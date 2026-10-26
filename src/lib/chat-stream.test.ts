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

  it("parses mixed event types in order", async () => {
    (globalThis.fetch as any).mockResolvedValue(
      ndjsonResponse([
        '{"type":"tool_start","call_id":"c1","tool_name":"search","input":"x"}\n',
        '{"type":"text","content":"Hi"}\n',
        '{"type":"artifact","kind":"file","name":"r.xlsx","path":"/r"}\n',
        '{"type":"done"}\n',
      ])
    );
    const events = [];
    for await (const e of streamChat("http://x", [{ role: "user", content: "hi" }])) {
      events.push(e);
    }
    expect(events.map((e) => e.type)).toEqual(["tool_start", "text", "artifact", "done"]);
  });

  it("parses full and legacy artifact events without inventing metadata", async () => {
    (globalThis.fetch as any).mockResolvedValue(
      ndjsonResponse([
        '{"type":"artifact","kind":"file","name":"r.xlsx","path":"/r","final":true,"exists":true,"size":42,"source":"fallback"}\n',
        '{"type":"artifact","kind":"image","name":"old.png","path":"/old"}\n',
      ])
    );

    const events = [];
    for await (const event of streamChat("http://x", [{ role: "user", content: "hi" }])) {
      events.push(event);
    }

    expect(events[0]).toEqual({
      type: "artifact",
      kind: "file",
      name: "r.xlsx",
      path: "/r",
      final: true,
      exists: true,
      size: 42,
      source: "fallback",
    });
    expect(events[1]).toEqual({
      type: "artifact",
      kind: "image",
      name: "old.png",
      path: "/old",
    });
  });

  it("skips a malformed line without aborting the stream", async () => {
    (globalThis.fetch as any).mockResolvedValue(
      ndjsonResponse([
        "this is not json\n",
        '{"type":"text","content":"after"}\n',
        '{"type":"done"}\n',
      ])
    );
    const events = [];
    for await (const e of streamChat("http://x", [{ role: "user", content: "hi" }])) {
      events.push(e);
    }
    // The bad line is dropped; valid events still arrive, including the terminal.
    expect(events.map((e) => e.type)).toEqual(["text", "done"]);
  });

  it("sends the work mode in the request body (default craft)", async () => {
    (globalThis.fetch as any).mockResolvedValue(ndjsonResponse(['{"type":"done"}\n']));
    for await (const _ of streamChat("http://x", [{ role: "user", content: "hi" }], undefined, undefined, "ask")) {
      // drain
    }
    const [url, init] = (globalThis.fetch as any).mock.calls[0];
    expect(url).toBe("http://x/api/chat");
    expect(JSON.parse(init.body)).toMatchObject({ mode: "ask" });

    // Default mode is craft when omitted.
    (globalThis.fetch as any).mockClear();
    (globalThis.fetch as any).mockResolvedValue(ndjsonResponse(['{"type":"done"}\n']));
    for await (const _ of streamChat("http://x", [{ role: "user", content: "hi" }])) {
      // drain
    }
    expect(JSON.parse((globalThis.fetch as any).mock.calls[0][1].body)).toMatchObject({ mode: "craft" });
  });
});
