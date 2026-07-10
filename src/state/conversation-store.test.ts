import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../lib/sidecar-client", () => ({ getBaseUrl: vi.fn(async () => "http://test") }));

import { useConversationStore } from "./conversation-store";

beforeEach(() => {
  vi.clearAllMocks();
  useConversationStore.setState({ list: [] });
});

describe("conversation-store", () => {
  it("loadList hits GET /api/conversations?workspace= and stores items", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ conversations: [{ id: "c1", title: "T", updated_at: "x", active: true }] }), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);

    const items = await useConversationStore.getState().loadList("/ws/A");
    expect(items).toHaveLength(1);
    expect(useConversationStore.getState().list[0].id).toBe("c1");
    expect(String((fetchMock as any).mock.calls[0][0])).toContain("/api/conversations?workspace=");
    expect(((fetchMock as any).mock.calls[0][1] as RequestInit | undefined)?.method ?? "GET").toBe("GET");
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

  it("returns [] / null / false on fetch failure without throwing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 500 })));
    expect(await useConversationStore.getState().loadList("/ws")).toEqual([]);
    expect(await useConversationStore.getState().create("/ws")).toBeNull();
    expect(await useConversationStore.getState().activate("c1")).toBe(false);
    expect(await useConversationStore.getState().remove("c1")).toBe(false);
  });
});
