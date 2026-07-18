import { describe, it, expect, vi, beforeEach } from "vitest";
import { useConfigStore } from "./config-store";

vi.mock("../lib/sidecar-client", () => ({ getBaseUrl: vi.fn(async () => "http://test") }));

describe("config-store persona slice", () => {
  beforeEach(() => {
    useConfigStore.setState({
      soul: "",
      soulIsDefault: true,
      agents: "",
      personaLoading: false,
      personaSaving: false,
      personaError: null,
    });
    vi.clearAllMocks();
  });

  it("loadPersona fetches both endpoints and fills the store", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes("/soul")) {
        return new Response(JSON.stringify({ content: "我是Bot", isDefault: false }), { status: 200 });
      }
      return new Response(JSON.stringify({ content: "## 规则" }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await useConfigStore.getState().loadPersona();

    const s = useConfigStore.getState();
    expect(s.soul).toBe("我是Bot");
    expect(s.soulIsDefault).toBe(false);
    expect(s.agents).toBe("## 规则");
    expect(s.personaError).toBeNull();
    vi.unstubAllGlobals();
  });

  it("saveSoul rejects >20000 chars without sending a request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await useConfigStore.getState().saveSoul("x".repeat(20001));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(useConfigStore.getState().personaError).toContain("20000");
    vi.unstubAllGlobals();
  });

  it("saveSoul posts and updates the store from the response", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true, reloaded: true, content: "新身份", isDefault: false }), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);

    await useConfigStore.getState().saveSoul("新身份");

    expect(fetchMock).toHaveBeenCalledWith(
      "http://test/api/config/soul",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ content: "新身份" }) })
    );
    const s = useConfigStore.getState();
    expect(s.soul).toBe("新身份");
    expect(s.soulIsDefault).toBe(false);
    expect(s.personaSaving).toBe(false);
    vi.unstubAllGlobals();
  });

  it("resetSoul posts empty content (delete → default)", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true, reloaded: true, content: "默认", isDefault: true }), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);

    await useConfigStore.getState().resetSoul();

    expect(fetchMock).toHaveBeenCalledWith(
      "http://test/api/config/soul",
      expect.objectContaining({ body: JSON.stringify({ content: "" }) })
    );
    expect(useConfigStore.getState().soulIsDefault).toBe(true);
    vi.unstubAllGlobals();
  });
});

function mockGetModel(payload: unknown) {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (String(url).endsWith("/api/config/model")) {
      return { ok: true, json: async () => payload } as any;
    }
    return { ok: true, json: async () => ({}) } as any;
  }));
}

describe("config-store supportsVision", () => {
  beforeEach(() => useConfigStore.setState({ model: null, providers: [] }));

  it("reads active model supportsVision from /api/config/model", async () => {
    mockGetModel({ model: { provider: "zhipu", model: "glm-5.2", supportsVision: true },
                   providers: [], apiKeyPresent: true, baseURL: "" });
    await useConfigStore.getState().load();
    expect(useConfigStore.getState().model?.supportsVision).toBe(true);
  });

  it("defaults supportsVision to false when absent", async () => {
    mockGetModel({ model: { provider: "deepseek", model: "deepseek-v4-flash" },
                   providers: [], apiKeyPresent: true, baseURL: "" });
    await useConfigStore.getState().load();
    expect(useConfigStore.getState().model?.supportsVision).toBe(false);
  });

  it("includes supportsVision in save payload", async () => {
    let sent: any = null;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: any) => {
      if (String(url).endsWith("/api/config/model") && init?.method === "POST") {
        sent = JSON.parse(init.body);
      }
      return { ok: true, json: async () => ({ model: { model: "glm-5.2", supportsVision: true } }) } as any;
    }));
    await useConfigStore.getState().save({
      provider: "zhipu", model: "glm-5.2",
      providers: [{ id: "zhipu", name: "智谱", baseURL: "x", apiKey: "",
                    models: [{ name: "glm-5.2", maxTokens: 131072, supportsVision: true }] }],
    });
    expect(sent.providers[0].models[0].supportsVision).toBe(true);
  });
});
