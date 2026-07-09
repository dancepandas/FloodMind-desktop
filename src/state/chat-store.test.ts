import { describe, it, expect, vi, beforeEach } from "vitest";
import { useChatStore } from "./chat-store";

vi.mock("../lib/sidecar-client", () => ({
  getBaseUrl: vi.fn(async () => "http://test"),
}));
vi.mock("../lib/chat-stream", () => ({
  streamChat: vi.fn(),
}));

// Import after mocks are registered.
import { streamChat } from "../lib/chat-stream";

describe("chat-store.send", () => {
  beforeEach(() => {
    useChatStore.setState({ messages: [], streaming: false });
    vi.clearAllMocks();
  });

  it("accumulates streamed text into one assistant message", async () => {
    (streamChat as any).mockImplementation(async function* () {
      yield { type: "text", content: "Hel" };
      yield { type: "text", content: "lo" };
      yield { type: "done" };
    });

    await useChatStore.getState().send("hi");

    const { messages, streaming } = useChatStore.getState();
    expect(streaming).toBe(false);
    expect(messages).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "Hello" },
    ]);
  });

  it("ignores empty / whitespace input", async () => {
    await useChatStore.getState().send("   ");
    expect(useChatStore.getState().messages).toEqual([]);
  });

  it("surfaces a stream error as an assistant message", async () => {
    (streamChat as any).mockImplementation(async function* () {
      throw new Error("boom");
    });

    await useChatStore.getState().send("hi");

    const last = useChatStore.getState().messages.at(-1);
    expect(last?.role).toBe("assistant");
    expect(last?.content).toContain("boom");
    expect(useChatStore.getState().streaming).toBe(false);
  });

  it("records tool_start/tool_end into the tools slice", async () => {
    (streamChat as any).mockImplementation(async function* () {
      yield { type: "tool_start", call_id: "c1", tool_name: "search", input: "x" };
      yield { type: "tool_end", call_id: "c1", tool_name: "search", status: "ok", output: "result" };
      yield { type: "done" };
    });

    await useChatStore.getState().send("hi");

    const tools = useChatStore.getState().tools;
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({ call_id: "c1", tool_name: "search", status: "ok", output: "result" });
  });

  it("accumulates token_usage across calls within one turn", async () => {
    // The sidecar translates SDK `token_usage` into `usage` events; one fires
    // per LLM call, so a multi-iteration turn emits several. The store must sum.
    (streamChat as any).mockImplementation(async function* () {
      yield { type: "usage", prompt: 10, completion: 5, total: 15 };
      yield { type: "usage", prompt: 3, completion: 2, total: 5 };
      yield { type: "done" };
    });

    await useChatStore.getState().send("hi");

    expect(useChatStore.getState().usage).toEqual({ prompt: 13, completion: 7, total: 20 });
  });

  it("reset clears local state and pings /api/session/reset", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    useChatStore.setState({
      messages: [{ role: "user", content: "x" }, { role: "assistant", content: "y" }],
      streaming: false,
    });

    useChatStore.getState().reset();
    // reset's session-reset ping is fire-and-forget; flush microtasks.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(useChatStore.getState().messages).toEqual([]);
    expect(fetchMock).toHaveBeenCalled();
    const url = String((fetchMock as any).mock.calls[0][0]);
    expect(url).toContain("/api/session/reset");

    vi.unstubAllGlobals();
  });
});
