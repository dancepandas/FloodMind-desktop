export type ChatMessage = { role: string; content: string };

export type ChatEvent =
  | { type: "text"; content: string }
  | { type: "thinking"; content: string }
  | { type: "tool_start"; call_id: string; tool_name: string; input: string }
  | { type: "tool_end"; call_id: string; tool_name: string; status: string; output: string }
  | { type: "plan"; title: string; steps: unknown[] }
  | { type: "step"; key: string; status: string; title?: string; outcome?: string }
  | { type: "artifact"; kind: "file" | "image"; name: string; path: string }
  | { type: "permission"; ask_id: string; call_id: string; tool_name: string; reason: string; input: unknown }
  | { type: "usage"; prompt: number; completion: number; total: number }
  | { type: "error"; content: string }
  | { type: "done" };

export async function* streamChat(
  baseUrl: string,
  messages: ChatMessage[],
  signal?: AbortSignal
): AsyncGenerator<ChatEvent> {
  const res = await fetch(`${baseUrl}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages }),
    signal,
  });
  if (!res.ok || !res.body) {
    throw new Error(`chat request failed: ${res.status}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

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
      yield JSON.parse(trimmed) as ChatEvent;
    }
  }

  // Flush any trailing line that wasn't newline-terminated.
  const tail = buffer.trim();
  if (tail) yield JSON.parse(tail) as ChatEvent;
}
