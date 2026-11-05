import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../lib/sidecar-client", () => ({ getBaseUrl: vi.fn(async () => "http://test") }));

import { useConversationStore } from "./conversation-store";

beforeEach(() => {
  vi.clearAllMocks();
  useConversationStore.setState({ list: [], byWorkspace: {} });
});

describe("conversation-store", () => {
  it("loadList hits GET /api/conversations?workspace= and stores items in both list and byWorkspace", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ conversations: [{ id: "c1", title: "T", updated_at: "x", active: true }] }), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);

    const items = await useConversationStore.getState().loadList("/ws/A");
    expect(items).toHaveLength(1);
    expect(useConversationStore.getState().list[0].id).toBe("c1");
    expect(useConversationStore.getState().byWorkspace["/ws/A"]).toHaveLength(1);
    expect(useConversationStore.getState().byWorkspace["/ws/A"][0].id).toBe("c1");
    expect(String((fetchMock as any).mock.calls[0][0])).toContain("/api/conversations?workspace=");
    expect(((fetchMock as any).mock.calls[0][1] as RequestInit | undefined)?.method ?? "GET").toBe("GET");
  });

  it("loadWorkspaceConversations populates byWorkspace without mutating list", async () => {
    // Pre-populate list to prove it stays untouched
    useConversationStore.setState({ list: [{ id: "prior", title: "P", updated_at: "x", active: false }] });

    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ conversations: [{ id: "c2", title: "WS", updated_at: "y", active: true }] }), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);

    const items = await useConversationStore.getState().loadWorkspaceConversations("/ws/B");
    expect(items).toHaveLength(1);

    const state = useConversationStore.getState();
    expect(state.byWorkspace["/ws/B"]).toHaveLength(1);
    expect(state.byWorkspace["/ws/B"][0].id).toBe("c2");
    // list must be unchanged
    expect(state.list).toHaveLength(1);
    expect(state.list[0].id).toBe("prior");
    expect(String((fetchMock as any).mock.calls[0][0])).toContain("/api/conversations?workspace=");
  });

  it("open GETs /api/conversations/<id> and returns the record", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ id: "c9", session_id: "s", workspace: "/ws", title: "T", created_at: "", updated_at: "", turns: [] }), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);
    const rec = await useConversationStore.getState().open("c9");
    expect(rec).toEqual({ id: "c9", session_id: "s", workspace: "/ws", title: "T", created_at: "", updated_at: "", turns: [] });
    expect(String((fetchMock as any).mock.calls[0][0])).toContain("/api/conversations/c9");
    expect(((fetchMock as any).mock.calls[0][1] as RequestInit | undefined)?.method ?? "GET").toBe("GET");
  });

  it("open returns null on fetch failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 500 })));
    expect(await useConversationStore.getState().open("c9")).toBeNull();
  });

  it("create POSTs {workspace} and returns the record", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ id: "c2", session_id: "s", workspace: "/ws/A", title: "x", created_at: "", updated_at: "", turns: [] }), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);
    const rec = await useConversationStore.getState().create("/ws/A");
    expect(rec?.id).toBe("c2");
    const init = (fetchMock as any).mock.calls[0][1] as RequestInit;
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ workspace: "/ws/A" });
  });

  it("activate and remove use POST / DELETE on the id", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await useConversationStore.getState().activate("c1");
    await useConversationStore.getState().remove("c1");
    expect(String((fetchMock as any).mock.calls[0][0])).toContain("/api/conversations/c1/activate");
    expect(((fetchMock as any).mock.calls[0][1] as RequestInit).method).toBe("POST");
    expect(String((fetchMock as any).mock.calls[1][0])).toContain("/api/conversations/c1");
    expect(((fetchMock as any).mock.calls[1][1] as RequestInit).method).toBe("DELETE");
  });

  it("removeEmpty deletes only empty conversations except the excluded one", async () => {
    const calls: { url: string; method?: string }[] = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), method: init?.method });
      if (String(url).includes("?workspace=")) {
        return new Response(JSON.stringify({ conversations: [
          { id: "empty1", title: "新会话", updated_at: "x", active: false, turns_count: 0 },
          { id: "empty2", title: "新会话", updated_at: "x", active: false, turns_count: 0 },
          { id: "keep", title: "新会话", updated_at: "x", active: true, turns_count: 0 }, // excluded (current)
          { id: "hascontent", title: "有内容", updated_at: "x", active: false, turns_count: 5 },
        ] }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await useConversationStore.getState().removeEmpty("/ws/A", "keep");
    const deletes = calls.filter((c) => c.method === "DELETE").map((c) => c.url);
    expect(deletes).toHaveLength(2);
    expect(deletes.some((u) => u.includes("/empty1"))).toBe(true);
    expect(deletes.some((u) => u.includes("/empty2"))).toBe(true);
    expect(deletes.some((u) => u.includes("/keep"))).toBe(false);
    expect(deletes.some((u) => u.includes("/hascontent"))).toBe(false);
    vi.unstubAllGlobals();
  });

  it("returns [] / null / false on fetch failure without throwing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 500 })));
    expect(await useConversationStore.getState().loadList("/ws")).toEqual([]);
    expect(await useConversationStore.getState().create("/ws")).toBeNull();
    expect(await useConversationStore.getState().activate("c1")).toBe(false);
    expect(await useConversationStore.getState().remove("c1")).toBe(false);
  });
});
