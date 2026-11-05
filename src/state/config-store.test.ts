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

// ---- Task 4: resolveActiveModel + switchActive ----

const baseState = {
  providers: [], apiKeyPresent: false, baseURL: "", envOverrides: [],
  loading: false, saving: false, savedAt: null, reloadFailed: false, error: null,
  soul: "", soulIsDefault: true, agents: "",
  personaLoading: false, personaSaving: false, personaError: null,
  permissionMode: "trust-once" as const, permissionLoading: false, permissionSaving: false,
  permissionSavedAt: null, permissionError: null,
  load: vi.fn(), clearSaved: vi.fn(), loadPersona: vi.fn(), loadPermissions: vi.fn(),
};

describe("resolveActiveModel", () => {
  beforeEach(() => {
    useConfigStore.setState({ ...baseState, model: null, enabledModels: [] } as any);
  });

  it("prefers conversation override", () => {
    useConfigStore.setState({
      model: { provider: "qwen", model: "qwen3.7-plus", temperature: 0.3, maxTokens: 131072,
        enableReasoning: false, enableSearch: false, supportsVision: true } as any,
      enabledModels: [{ provider: "qwen", model: "qwen3.7-plus" }],
    } as any);
    expect(useConfigStore.getState().resolveActiveModel({ provider: "moonshot", model: "kimi-2.6" }))
      .toEqual({ provider: "moonshot", model: "kimi-2.6" });
  });

  it("falls back to active model when no override", () => {
    useConfigStore.setState({
      model: { provider: "qwen", model: "qwen3.7-plus" } as any,
      enabledModels: [{ provider: "qwen", model: "qwen3.7-plus" }],
    } as any);
    expect(useConfigStore.getState().resolveActiveModel(null))
      .toEqual({ provider: "qwen", model: "qwen3.7-plus" });
  });

  it("falls back to first enabled when active not enabled", () => {
    useConfigStore.setState({
      model: { provider: "deepseek", model: "deepseek-v4-pro" } as any,
      enabledModels: [{ provider: "qwen", model: "qwen3.7-plus" }],
    } as any);
    expect(useConfigStore.getState().resolveActiveModel(null))
      .toEqual({ provider: "qwen", model: "qwen3.7-plus" });
  });

  it("returns null when nothing enabled", () => {
    useConfigStore.setState({ model: null, enabledModels: [] } as any);
    expect(useConfigStore.getState().resolveActiveModel(null)).toBeNull();
  });
});

describe("switchActive", () => {
  beforeEach(() => {
    useConfigStore.setState({ ...baseState, model: { provider: "qwen", model: "qwen3.7-plus" } as any,
      enabledModels: [{ provider: "qwen", model: "qwen3.7-plus" }] } as any);
  });

  it("optimistically updates, calls active-model endpoint, persists conv binding", async () => {
    const calls: any[] = [];
    const fetchMock = (async (url: string, init?: any) => {
      calls.push({ url, init });
      return { ok: true, json: async () => ({ ok: true, reloaded: true,
        // POST 响应：快照裹在 model 下；snapshot.model = ModelConfig
        model: { model: { provider: "moonshot", model: "kimi-2.6", temperature: 0.3, maxTokens: 131072,
                          enableReasoning: false, enableSearch: false, supportsVision: true },
                 apiKeyPresent: true, baseURL: "u2", providers: [], enabledModels: [] } }) } as any;
    }) as any;
    vi.stubGlobal("fetch", fetchMock);
    const ok = await useConfigStore.getState().switchActive("moonshot", "kimi-2.6", "conv-1");
    expect(ok).toBe(true);
    expect(calls.some((c) => c.url.endsWith("/api/config/active-model"))).toBe(true);
    expect((useConfigStore.getState().model as any)?.model).toBe("kimi-2.6");
    expect(calls.some((c) => c.url.includes("/api/conversations/conv-1/model") && c.init?.method === "PUT")).toBe(true);
    vi.unstubAllGlobals();
  });

  it("rolls back on active-model failure", async () => {
    const fetchMock = (async (url: string) => {
      if (url.endsWith("/api/config/active-model")) return { ok: false, json: async () => ({}) } as any;
      return { ok: true, json: async () => ({}) } as any;
    }) as any;
    vi.stubGlobal("fetch", fetchMock);
    const before = useConfigStore.getState().model;
    const ok = await useConfigStore.getState().switchActive("moonshot", "kimi-2.6", "conv-1");
    expect(ok).toBe(false);
    expect(useConfigStore.getState().model).toEqual(before);
    vi.unstubAllGlobals();
  });
});

describe("config-store work-mode slice", () => {
  beforeEach(() => {
    useConfigStore.setState({
      workMode: "craft",
      workModeLoading: false,
      workModeSaving: false,
      workModeSavedAt: null,
      workModeError: null,
    });
    vi.clearAllMocks();
  });

  it("loadWorkMode reads /api/work-mode and fills the store", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ mode: "ask" }), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);

    await useConfigStore.getState().loadWorkMode();

    expect(fetchMock).toHaveBeenCalledWith("http://test/api/work-mode");
    expect(useConfigStore.getState().workMode).toBe("ask");
    vi.unstubAllGlobals();
  });

  it("loadWorkMode falls back to craft on an invalid server value", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ mode: "nonsense" }), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);

    await useConfigStore.getState().loadWorkMode();

    expect(useConfigStore.getState().workMode).toBe("craft");
    vi.unstubAllGlobals();
  });

  it("saveWorkMode posts the mode and updates the store", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true, work_mode: { mode: "plan" } }), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);

    const ok = await useConfigStore.getState().saveWorkMode("plan");

    expect(ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://test/api/work-mode",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ mode: "plan" }) })
    );
    expect(useConfigStore.getState().workMode).toBe("plan");
    vi.unstubAllGlobals();
  });
});
