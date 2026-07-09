import { describe, it, expect, vi, beforeEach } from "vitest";
import { useChatStore, reduceEvent, _resetBlockIdsForTest } from "./chat-store";
import type { AssistantTurn } from "./chat-store";

vi.mock("../lib/sidecar-client", () => ({
  getBaseUrl: vi.fn(async () => "http://test"),
}));
vi.mock("../lib/chat-stream", () => ({
  streamChat: vi.fn(),
}));

// Import after mocks are registered.
import { streamChat } from "../lib/chat-stream";

function emptyTurn(): AssistantTurn {
  return { role: "assistant", blocks: [], usage: null, done: false };
}

describe("reduceEvent (block model)", () => {
  it("merges consecutive text deltas into one text block", () => {
    let t = reduceEvent(emptyTurn(), { type: "text", content: "Hel" });
    t = reduceEvent(t, { type: "text", content: "lo" });
    expect(t.blocks).toHaveLength(1);
    expect(t.blocks[0]).toMatchObject({ kind: "text", content: "Hello" });
  });

  it("interleaves: think -> text -> tool -> text yields 4 blocks in order", () => {
    let t = emptyTurn();
    t = reduceEvent(t, { type: "thinking", content: "hmm" });
    t = reduceEvent(t, { type: "text", content: "looking..." });
    t = reduceEvent(t, { type: "tool_start", call_id: "c1", tool_name: "search", input: "x" });
    t = reduceEvent(t, { type: "text", content: "found it" });
    expect(t.blocks.map((b) => b.kind)).toEqual(["thinking", "text", "tool", "text"]);
  });

  it("matches tool_end to its tool_start by call_id (single tool block)", () => {
    let t = emptyTurn();
    t = reduceEvent(t, { type: "tool_start", call_id: "c1", tool_name: "search", input: "x" });
    t = reduceEvent(t, { type: "tool_end", call_id: "c1", tool_name: "search", status: "ok", output: "r" });
    const tools = t.blocks.filter((b) => b.kind === "tool");
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({ call_id: "c1", status: "ok", output: "r" });
  });

  it("accumulates usage across calls", () => {
    let t = emptyTurn();
    t = reduceEvent(t, { type: "usage", prompt: 10, completion: 5, total: 15 });
    t = reduceEvent(t, { type: "usage", prompt: 3, completion: 2, total: 5 });
    expect(t.usage).toEqual({ prompt: 13, completion: 7, total: 20 });
  });
});

describe("chat-store.send", () => {
  beforeEach(() => {
    _resetBlockIdsForTest();
    useChatStore.setState({ turns: [], streaming: false });
    vi.clearAllMocks();
  });

  it("streams text into one final-marked text block on done", async () => {
    (streamChat as any).mockImplementation(async function* () {
      yield { type: "text", content: "Hel" };
      yield { type: "text", content: "lo" };
      yield { type: "done" };
    });

    await useChatStore.getState().send("hi");

    const { turns, streaming } = useChatStore.getState();
    expect(streaming).toBe(false);
    expect(turns).toHaveLength(2);
    const reply = turns[1] as AssistantTurn;
    expect(reply.done).toBe(true);
    expect(reply.blocks).toHaveLength(1);
    expect(reply.blocks[0]).toMatchObject({ kind: "text", content: "Hello", final: true });
  });

  it("ignores empty / whitespace input", async () => {
    await useChatStore.getState().send("   ");
    expect(useChatStore.getState().turns).toEqual([]);
  });

  it("surfaces a stream error as an error block", async () => {
    (streamChat as any).mockImplementation(async function* () {
      throw new Error("boom");
    });

    await useChatStore.getState().send("hi");

    const reply = useChatStore.getState().turns[1] as AssistantTurn;
    const err = reply.blocks.find((b) => b.kind === "error");
    expect(err).toMatchObject({ kind: "error" });
    expect((err as { content: string }).content).toContain("boom");
  });

  it("does NOT mark a partial answer final when the turn errored mid-stream", async () => {
    // Text streamed, then the stream throws -> the partial text must not become
    // the "final answer"; only the error block is added.
    (streamChat as any).mockImplementation(async function* () {
      yield { type: "text", content: "partial..." };
      throw new Error("boom");
    });

    await useChatStore.getState().send("hi");
    const reply = useChatStore.getState().turns[1] as AssistantTurn;
    const text = reply.blocks.find((b) => b.kind === "text");
    expect((text as { final?: boolean }).final).toBeFalsy();
    expect(reply.blocks.some((b) => b.kind === "error")).toBe(true);
  });

  it("marks the last text block final when multiple text runs exist", async () => {
    (streamChat as any).mockImplementation(async function* () {
      yield { type: "text", content: "intermediate" };
      yield { type: "tool_start", call_id: "c1", tool_name: "t", input: "" };
      yield { type: "tool_end", call_id: "c1", tool_name: "t", status: "ok", output: "" };
      yield { type: "text", content: "final answer" };
      yield { type: "done" };
    });

    await useChatStore.getState().send("hi");
    const reply = useChatStore.getState().turns[1] as AssistantTurn;
    const texts = reply.blocks.filter((b) => b.kind === "text");
    expect(texts).toHaveLength(2);
    expect((texts[0] as { final?: boolean }).final).toBeFalsy();
    expect((texts[1] as { final?: boolean }).final).toBe(true);
  });

  it("reset clears turns and pings /api/session/reset", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    useChatStore.setState({
      turns: [{ role: "user", content: "x" }, { role: "assistant", blocks: [], usage: null, done: true }],
      streaming: false,
    });

    useChatStore.getState().reset();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(useChatStore.getState().turns).toEqual([]);
    expect(fetchMock).toHaveBeenCalled();
    expect(String((fetchMock as any).mock.calls[0][0])).toContain("/api/session/reset");
    vi.unstubAllGlobals();
  });
});
