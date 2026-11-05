import type { ImageAttachmentWire } from "../state/attachment-store";

// Re-export so chat-store.ts (and other callers) can import the canonical wire
// type from either location. attachment-store.ts is the single source of truth
// (see Task 7) — do not duplicate the union here.
export type { ImageAttachmentWire } from "../state/attachment-store";

export type ChatMessage = { role: string; content: string };

export type ArtifactSource = "declared" | "fallback";

export type ArtifactEvent = {
  type: "artifact";
  kind: "file" | "image";
  name: string;
  path: string;
  final?: boolean;
  exists?: boolean;
  size?: number;
  source?: ArtifactSource;
};

export type ChatEvent =
  | { type: "text"; content: string }
  | { type: "thinking"; content: string }
  | { type: "tool_start"; call_id: string; tool_name: string; input: string }
  | { type: "tool_end"; call_id: string; tool_name: string; status: string; output: string }
  | { type: "plan"; title: string; steps: unknown[] }
  | { type: "step"; key: string; status: string; title?: string; outcome?: string }
  | ArtifactEvent
  | { type: "permission"; ask_id: string; call_id: string; tool_name: string; reason: string; input: unknown; approved?: boolean; auto_approved?: boolean }
  | { type: "usage"; prompt: number; completion: number; total: number }
  | { type: "error"; content: string }
  | { type: "round_start"; iteration: number }
  | { type: "finish"; reason: string }
  | { type: "context"; label: string; content: string }
  | { type: "done" };

export async function appendInstruction(baseUrl: string, text: string): Promise<void> {
  const res = await fetch(`${baseUrl}/api/chat/append`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "user", content: text }] }),
  });
  if (!res.ok) {
    throw new Error(`append request failed: ${res.status}`);
  }
}

export async function pauseChat(baseUrl: string): Promise<void> {
  const res = await fetch(`${baseUrl}/api/chat/pause`, { method: "POST" });
  if (!res.ok) {
    throw new Error(`pause request failed: ${res.status}`);
  }
}

export async function respondToPermissionAsk(
  baseUrl: string,
  askId: string,
  approved: boolean,
): Promise<void> {
  const res = await fetch(`${baseUrl}/api/permission/respond`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ask_id: askId, approved }),
  });
  if (!res.ok) {
    throw new Error(`permission respond failed: ${res.status}`);
  }
}

/** Parse an NDJSON response body into ChatEvents. */
async function* readNdjson(res: Response): AsyncGenerator<ChatEvent> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  // Parse one NDJSON line defensively: a single malformed/partial line (a log
  // leaking into the stream, a truncated UTF-8 boundary, a proxy error page)
  // must not abort the whole turn. Skip it with a warning instead.
  const parseLine = (line: string): ChatEvent | null => {
    try {
      return JSON.parse(line) as ChatEvent;
    } catch {
      console.warn("[chat-stream] skipping non-JSON stream line:", line.slice(0, 200));
      return null;
    }
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    // Keep the last (possibly partial) segment in the buffer for the next read.
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const ev = parseLine(trimmed);
      if (ev) yield ev;
    }
  }

  // Flush any trailing line that wasn't newline-terminated.
  const tail = buffer.trim();
  if (tail) {
    const ev = parseLine(tail);
    if (ev) yield ev;
  }
}

export async function* streamChat(
  baseUrl: string,
  messages: ChatMessage[],
  signal?: AbortSignal,
  attachments?: ImageAttachmentWire[],
  mode?: "craft" | "ask" | "plan",
): AsyncGenerator<ChatEvent> {
  const res = await fetch(`${baseUrl}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages, attachments: attachments ?? [], mode: mode ?? "craft" }),
    signal,
  });
  if (!res.ok || !res.body) {
    throw new Error(`chat request failed: ${res.status}`);
  }
  yield* readNdjson(res);
}
