export type ChatMessage = { role: string; content: string };
export type ChatEvent = { type: "text"; content: string } | { type: "done" };

export async function* streamChat(
  baseUrl: string,
  messages: ChatMessage[]
): AsyncGenerator<ChatEvent> {
  const res = await fetch(`${baseUrl}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages }),
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
