import { describe, it, expect, vi, beforeEach } from "vitest";
import { streamChat } from "./chat-stream";

function ndjsonResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "application/x-ndjson" },
  });
}

describe("streamChat", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  it("parses NDJSON lines into events", async () => {
    (globalThis.fetch as any).mockResolvedValue(
      ndjsonResponse([
        '{"type":"text","content":"Hel"}\n',
        '{"type":"text","content":"lo"}\n',
        '{"type":"done"}\n',
      ])
    );
    const events = [];
    for await (const e of streamChat("http://x", [{ role: "user", content: "hi" }])) {
      events.push(e);
    }
    const text = events
      .filter((e) => e.type === "text")
      .map((e: any) => e.content)
      .join("");
    expect(text).toBe("Hello");
    expect(events[events.length - 1]).toEqual({ type: "done" });
  });

  it("handles a chunk split across read boundaries", async () => {
    // The JSON object {"type":"text","content":"ab"} is split mid-value across reads.
    (globalThis.fetch as any).mockResolvedValue(
      ndjsonResponse(['{"type":"text","content":"a', 'b"}\n{"type":"done"}\n'])
    );
    const events = [];
    for await (const e of streamChat("http://x", [{ role: "user", content: "hi" }])) {
      events.push(e);
    }
    const text = events
      .filter((e) => e.type === "text")
      .map((e: any) => e.content)
      .join("");
    expect(text).toBe("ab");
  });

  it("throws on non-ok response", async () => {
    (globalThis.fetch as any).mockResolvedValue(new Response("nope", { status: 500 }));
    await expect(
      (async () => {
        for await (const _ of streamChat("http://x", [{ role: "user", content: "hi" }])) {
          // drain
        }
      })()
    ).rejects.toThrow();
  });
});
