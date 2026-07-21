import { describe, it, expect, vi, beforeEach } from "vitest";
import { useChatStore, reduceEvent, deriveStatusText, _resetBlockIdsForTest } from "./chat-store";
import type { AssistantTurn } from "./chat-store";
import type { ImageAttachmentWire } from "../lib/chat-stream";

vi.mock("../lib/sidecar-client", () => ({
  getBaseUrl: vi.fn(async () => "http://test"),
}));
vi.mock("../lib/chat-stream", () => ({
  streamChat: vi.fn(),
  appendInstruction: vi.fn(async () => {}),
  pauseChat: vi.fn(async () => {}),
  respondToPermissionAsk: vi.fn(async () => {}),
}));
vi.mock("./conversation-store", () => ({
  useConversationStore: {
    getState: () => ({
      create: vi.fn(async (_ws: string) => ({
        id: "c-new", session_id: "s-new", workspace: _ws, title: "新会话",
        created_at: "t", updated_at: "t", turns: [],
      })),
      activate: vi.fn(async (_id: string) => true),
      open: vi.fn(async (id: string) => ({
        id, session_id: "s", workspace: "/ws", title: "old", created_at: "t", updated_at: "t",
        turns: [{ role: "user", content: "loaded" }],
      })),
      loadList: vi.fn(async () => []),
    }),
    setState: vi.fn(),
  },
}));

// Import after mocks are registered.
import { streamChat, appendInstruction as postAppendInstruction, pauseChat, respondToPermissionAsk } from "../lib/chat-stream";
import { useConversationStore } from "./conversation-store";
import { useConfigStore } from "./config-store";

function emptyTurn(): AssistantTurn {
  return { id: "t0", role: "assistant", blocks: [], usage: null, done: false };
}

describe("deriveStatusText", () => {
  it("returns waiting text when there is no block", () => {
    expect(deriveStatusText(undefined)).toBe("等待响应…");
  });

  it("reflects a thinking block", () => {
    expect(deriveStatusText({ kind: "thinking", content: "hmm" } as any)).toBe("正在思考…");
  });

  it("reflects a running tool block with the tool name", () => {
    expect(deriveStatusText({ kind: "tool", tool_name: "read_file", status: "running" } as any)).toBe("正在执行：read_file…");
  });

  it("returns empty for a completed tool block", () => {
    expect(deriveStatusText({ kind: "tool", tool_name: "read_file", status: "ok" } as any)).toBe("");
  });

  it("returns empty for a failed tool block", () => {
    expect(deriveStatusText({ kind: "tool", tool_name: "read_file", status: "error" } as any)).toBe("");
  });

  it("reflects a non-final text block", () => {
    expect(deriveStatusText({ kind: "text", content: "ans", final: false } as any)).toBe("正在回答…");
  });

  it("returns empty for a final text block", () => {
    expect(deriveStatusText({ kind: "text", content: "ans", final: true } as any)).toBe("");
  });

  it("returns empty for unknown block kinds", () => {
    expect(deriveStatusText({ kind: "error", content: "boom" } as any)).toBe("");
  });
});

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

  it("tracks latest prompt token count and accumulates completion/total", () => {
    let t = emptyTurn();
    t = reduceEvent(t, { type: "usage", prompt: 10, completion: 5, total: 15 });
    t = reduceEvent(t, { type: "usage", prompt: 13, completion: 2, total: 5 });
    // prompt: latest value only (each request's prompt_tokens = full context)
    // completion & total: accumulate across calls
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

  it("while streaming, send routes to appendInstruction — inserts a user bubble BEFORE the active assistant turn (keeps assistant last so events still reduce)", async () => {
    useChatStore.setState({
      streaming: true,
      turns: [
        { id: "u1", role: "user", content: "first" },
        { id: "a1", role: "assistant", blocks: [], usage: null, done: false },
      ],
    });

    await useChatStore.getState().send("also do X");

    expect(streamChat).not.toHaveBeenCalled();
    expect(postAppendInstruction).toHaveBeenCalledWith("http://test", "also do X");
    // The appended instruction becomes a normal user bubble inserted before
    // the assistant turn — so the assistant turn stays last (reducer invariant)
    // and the instruction shows immediately below the original request.
    const turns = useChatStore.getState().turns;
    expect(turns).toHaveLength(3);
    expect(turns[0]).toMatchObject({ role: "user", content: "first" });
    expect(turns[1]).toMatchObject({ role: "user", content: "also do X" });
    expect(turns[2].role).toBe("assistant");
    // The original stream stays active — streaming flag untouched.
    expect(useChatStore.getState().streaming).toBe(true);
  });

  it("appendInstruction rolls back the optimistic user bubble when the POST fails", async () => {
    (postAppendInstruction as any).mockRejectedValueOnce(new Error("boom"));
    useChatStore.setState({
      streaming: true,
      turns: [
        { id: "u1", role: "user", content: "first" },
        { id: "a1", role: "assistant", blocks: [], usage: null, done: false },
      ],
    });

    await useChatStore.getState().appendInstruction("lost in transit");

    // Rolled back — the SDK never received it, so the transcript must not keep it.
    const turns = useChatStore.getState().turns;
    expect(turns).toHaveLength(2);
    expect(turns[1].role).toBe("assistant");
  });

  it("pause posts /api/chat/pause and aborts the active stream", async () => {
    const ctl = new AbortController();
    useChatStore.setState({ streaming: true, abortController: ctl });
    await useChatStore.getState().pause();
    expect(pauseChat).toHaveBeenCalledWith("http://test");
    expect(ctl.signal.aborted).toBe(true);
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

  it("reset clears local turns without a sidecar call", () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    useChatStore.setState({
      turns: [{ id: "u1", role: "user", content: "x" }, { id: "a1", role: "assistant", blocks: [], usage: null, done: true }],
      streaming: false,
      title: "some title",
    });
    useChatStore.getState().reset();
    expect(useChatStore.getState().turns).toEqual([]);
    expect(useChatStore.getState().title).toBe("新会话");
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("startNew creates a conversation, clears turns, sets conversationId", async () => {
    useChatStore.setState({
      turns: [{ id: "u1", role: "user", content: "old" }],
      streaming: false,
      conversationId: null,
    });
    await useChatStore.getState().startNew("/ws/A");
    const st = useChatStore.getState();
    expect(st.turns).toEqual([]);
    expect(st.conversationId).toBe("c-new");
    expect(st.title).toBe("新会话");   // from the create() mock record
  });

  it("loadConversation activates + hydrates turns from the loaded record", async () => {
    await useChatStore.getState().loadConversation("c-old");
    const st = useChatStore.getState();
    expect(st.conversationId).toBe("c-old");
    expect(st.turns).toHaveLength(1);
    expect((st.turns[0] as any).content).toBe("loaded");
    expect(st.title).toBe("old");      // from the open() mock record's title
  });

  it("send posts the finalized turn pair when a conversation is active", async () => {
    (streamChat as any).mockImplementation(async function* () {
      yield { type: "text", content: "Hi" };
      yield { type: "done" };
    });
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    useChatStore.setState({ turns: [], streaming: false, conversationId: "c1" });
    _resetBlockIdsForTest();

    await useChatStore.getState().send("hello");

    const posted = fetchMock.mock.calls.find(
      (c) => String(c[0]).includes("/api/conversations/c1/turns")
    );
    expect(posted).toBeTruthy();
    const body = JSON.parse((posted![1] as RequestInit).body as string);
    expect(body.turns).toHaveLength(2);
    expect(body.turns[0]).toMatchObject({ role: "user", content: "hello" });
    expect(body.turns[1].role).toBe("assistant");
    vi.unstubAllGlobals();
  });

  it("send refreshes the generated title in byWorkspace (sidebar's source of truth)", async () => {
    // Regression: the title was patched only into `list`, but the Sidebar reads
    // byWorkspace[path] — so the new title didn't show until a workspace/conv
    // switch re-fetched. The patch must reach byWorkspace too.
    (streamChat as any).mockImplementation(async function* () {
      yield { type: "done" };
    });
    (useConversationStore.setState as any).mockClear();
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true, title: "水文分析" }), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);
    useChatStore.setState({ turns: [], streaming: false, conversationId: "c1" });
    _resetBlockIdsForTest();

    await useChatStore.getState().send("整理降雨径流");
    await vi.waitFor(() => expect(useConversationStore.setState).toHaveBeenCalled());

    // Find the title-patch call and run its updater against a fake state.
    const fakeState = {
      list: [{ id: "c1", title: "新会话", updated_at: "t", active: true }],
      byWorkspace: { "/ws": [{ id: "c1", title: "新会话", updated_at: "t", active: true }] },
    };
    const call = (useConversationStore.setState as any).mock.calls
      .map((c: any) => (typeof c[0] === "function" ? (c[0] as any)(fakeState) : c[0]))
      .find((out: any) => out?.byWorkspace?.["/ws"]?.[0]?.title === "水文分析");
    expect(call).toBeTruthy();
    expect(call.list[0].title).toBe("水文分析");
    expect(useChatStore.getState().title).toBe("水文分析");   // TopBar's source
    vi.unstubAllGlobals();
  });

  it("send does NOT post when no conversation is active", async () => {
    (streamChat as any).mockImplementation(async function* () {
      yield { type: "done" };
    });
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    useChatStore.setState({ turns: [], streaming: false, conversationId: null });
    _resetBlockIdsForTest();

    await useChatStore.getState().send("hi");
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("send forwards attachments to streamChat and tags the user turn with images", async () => {
    // Vision: send(text, attachments?, images?) — attachments flow into the
    // /api/chat POST body (via streamChat's 4th arg) and the local user turn
    // is stamped with images[] for live thumbnail display (single-turn, not
    // persisted). Adapted to the file's existing mock convention: streamChat
    // is mocked, so we assert on its captured call args rather than fetch.
    (streamChat as any).mockImplementation(async function* () {
      yield { type: "done" };
    });
    useChatStore.setState({ turns: [], streaming: false, conversationId: null });
    _resetBlockIdsForTest();

    const attachments: ImageAttachmentWire[] = [{ source: "file", path: "D:/x.png", mime: "image/png" }];
    const images = [{ name: "x.png", thumb: "data:..." }];

    await useChatStore.getState().send("看图", attachments, images);

    // streamChat was called with attachments as the 4th positional argument.
    expect(streamChat).toHaveBeenCalledWith(
      "http://test",
      [{ role: "user", content: "看图" }],
      expect.any(AbortSignal),
      attachments,
    );
    // The local user turn carries images for live display.
    const userTurn = useChatStore.getState().turns.find((t) => t.role === "user");
    expect((userTurn as any).images).toEqual(images);
  });

  it("send persists [已附图片：…] prefix instead of the images payload", async () => {
    // Images are single-turn only — persistence must strip the `images` key
    // from the user turn and prepend a [已附图片：a.png, b.jpg] marker line so
    // a reloaded transcript shows the marker instead of a vanished image.
    (streamChat as any).mockImplementation(async function* () {
      yield { type: "done" };
    });
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    useChatStore.setState({ turns: [], streaming: false, conversationId: "c1" });
    _resetBlockIdsForTest();

    await useChatStore.getState().send(
      "看这两张",
      [
        { source: "file", path: "D:/a.png", mime: "image/png" },
        { source: "file", path: "D:/b.jpg", mime: "image/jpeg" },
      ] as ImageAttachmentWire[],
      [{ name: "a.png", thumb: "d1" }, { name: "b.jpg", thumb: "d2" }],
    );
    // The persistence POST is async — wait for it to land.
    await vi.waitFor(() => {
      expect(fetchMock.mock.calls.some((c) => String(c[0]).includes("/api/conversations/c1/turns"))).toBe(true);
    });

    const posted = fetchMock.mock.calls.find((c) =>
      String(c[0]).includes("/api/conversations/c1/turns"),
    );
    const body = JSON.parse((posted![1] as RequestInit).body as string);
    const persistedUser = body.turns.find((t: any) => t.role === "user");
    // Prefix present.
    expect(persistedUser.content).toBe("[已附图片：a.png, b.jpg]\n看这两张");
    // images key stripped.
    expect(persistedUser.images).toBeUndefined();
    vi.unstubAllGlobals();
  });
});

describe("respondToPermission", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("optimistically marks the matching permission block approved", async () => {
    (respondToPermissionAsk as any).mockResolvedValue(undefined);
    useChatStore.setState({
      turns: [
        { id: "t1", role: "assistant", done: true, usage: null, blocks: [
          { id: "p1", kind: "permission", ask_id: "ask-1", call_id: "c1", tool_name: "Bash", reason: "r", approved: undefined },
        ] },
      ],
      streaming: false,
      conversationId: "c1",
    });

    await useChatStore.getState().respondToPermission("ask-1", true);

    expect(respondToPermissionAsk).toHaveBeenCalledWith("http://test", "ask-1", true);
    const block = (useChatStore.getState().turns[0] as AssistantTurn).blocks[0];
    expect(block.kind).toBe("permission");
    expect((block as any).approved).toBe(true);
  });

  it("appends an error block when the respond request fails", async () => {
    (respondToPermissionAsk as any).mockRejectedValue(new Error("network down"));
    useChatStore.setState({
      turns: [
        { id: "t1", role: "assistant", done: true, usage: null, blocks: [
          { id: "p1", kind: "permission", ask_id: "ask-1", call_id: "c1", tool_name: "Bash", reason: "r", approved: undefined },
        ] },
      ],
      streaming: false,
      conversationId: "c1",
    });

    await useChatStore.getState().respondToPermission("ask-1", false);

    const blocks = (useChatStore.getState().turns[0] as AssistantTurn).blocks;
    expect(blocks.some((b) => b.kind === "error" && (b as any).content.includes("network down"))).toBe(true);
    // The original permission block is left untouched (still waiting).
    expect((blocks[0] as any).approved).toBeUndefined();
  });

  it("updates a permission block on an earlier (non-last) assistant turn", async () => {
    (respondToPermissionAsk as any).mockResolvedValue(undefined);
    useChatStore.setState({
      turns: [
        { id: "t1", role: "assistant", done: true, usage: null, blocks: [
          { id: "p1", kind: "permission", ask_id: "ask-1", call_id: "c1", tool_name: "Bash", reason: "r", approved: undefined },
        ] },
        { role: "user", id: "u1", content: "follow up" },
        { id: "t2", role: "assistant", done: true, usage: null, blocks: [] },
      ],
      streaming: false,
      conversationId: "c1",
    });

    await useChatStore.getState().respondToPermission("ask-1", true);

    const first = useChatStore.getState().turns[0] as AssistantTurn;
    expect((first.blocks[0] as any).approved).toBe(true);
  });
});

describe("loadConversation sticky model restore", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset config-store to a known empty baseline before each case.
    const { setState } = useConfigStore;
    setState({ model: null, enabledModels: [] } as any);
  });

  it("loadConversation restores the conversation's bound model when it differs", async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("/api/conversations/") && url.endsWith("/model")) {
        return { ok: true, json: async () => ({ model: { provider: "moonshot", model: "kimi-2.6" } }) } as any;
      }
      if (url.endsWith("/api/config/active-model")) {
        return {
          ok: true,
          json: async () => ({
            ok: true,
            reloaded: true,
            model: { model: { provider: "moonshot", model: "kimi-2.6" } },
          }),
        } as any;
      }
      return { ok: true, json: async () => ({ id: "conv-1", session_id: "s1", turns: [] }) } as any;
    });
    vi.stubGlobal("fetch", fetchMock);
    // 预设当前活动模型为 qwen，与绑定 moonshot 不同 → 应触发 active-model POST
    const { setState } = useConfigStore;
    setState({
      model: { provider: "qwen", model: "qwen3.7-plus" } as any,
      enabledModels: [
        { provider: "moonshot", model: "kimi-2.6" },
        { provider: "qwen", model: "qwen3.7-plus" },
      ],
    } as any);
    await useChatStore.getState().loadConversation("conv-1");
    expect(
      fetchMock.mock.calls.some((c) => (c[0] as string).endsWith("/api/config/active-model")),
    ).toBe(true);
    vi.unstubAllGlobals();
  });

  it("loadConversation does NOT switch when the bound model equals the active model", async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("/api/conversations/") && url.endsWith("/model")) {
        return { ok: true, json: async () => ({ model: { provider: "moonshot", model: "kimi-2.6" } }) } as any;
      }
      // Should never be reached: bound == active, so no switch.
      return { ok: true, json: async () => ({}) } as any;
    });
    vi.stubGlobal("fetch", fetchMock);
    const { setState } = useConfigStore;
    setState({
      model: { provider: "moonshot", model: "kimi-2.6" } as any,
      enabledModels: [{ provider: "moonshot", model: "kimi-2.6" }],
    } as any);

    await useChatStore.getState().loadConversation("conv-same");

    expect(
      fetchMock.mock.calls.some((c) => (c[0] as string).endsWith("/api/config/active-model")),
    ).toBe(false);
    vi.unstubAllGlobals();
  });

  it("loadConversation swallows model-restore failures (conversation still loads)", async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("/api/conversations/") && url.endsWith("/model")) {
        // loadConversationModel returns null on !ok → no switch attempted.
        return { ok: false, json: async () => ({}) } as any;
      }
      return { ok: true, json: async () => ({}) } as any;
    });
    vi.stubGlobal("fetch", fetchMock);
    const { setState } = useConfigStore;
    setState({
      model: { provider: "qwen", model: "qwen3.7-plus" } as any,
      enabledModels: [{ provider: "qwen", model: "qwen3.7-plus" }],
    } as any);

    // Must not throw — turns are still hydrated from the conversation-store mock.
    await useChatStore.getState().loadConversation("conv-broken");
    expect(useChatStore.getState().conversationId).toBe("conv-broken");
    expect(
      fetchMock.mock.calls.some((c) => (c[0] as string).endsWith("/api/config/active-model")),
    ).toBe(false);
    vi.unstubAllGlobals();
  });
});
