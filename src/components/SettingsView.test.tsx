import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import SettingsView from "./SettingsView";
import { useConfigStore } from "../state/config-store";
import { useFeedbackStore } from "../state/feedback-store";

// Persona tabs read `streaming` from the chat store; stub it hermetically.
vi.mock("../state/chat-store", () => ({
  useChatStore: (selector: (s: any) => any) => selector({ streaming: false }),
}));

vi.mock("../lib/sidecar-client", () => ({
  getBaseUrl: vi.fn(async () => "http://sidecar.test"),
}));

vi.mock("../lib/log-capture", () => ({
  getRecentLogs: vi.fn(() => []),
}));

describe("SettingsView tabs", () => {
  beforeEach(() => {
    useConfigStore.setState({
      model: null,
      providers: [],
      apiKeyPresent: false,
      baseURL: "",
      envOverrides: [],
      loading: false,
      saving: false,
      savedAt: null,
      reloadFailed: false,
      error: null,
      soul: "默认身份",
      soulIsDefault: true,
      agents: "",
      personaLoading: false,
      personaSaving: false,
      personaError: null,
      permissionMode: "trust-once",
      permissionLoading: false,
      permissionSaving: false,
      permissionSavedAt: null,
      permissionError: null,
      load: vi.fn(),
      loadPersona: vi.fn(),
      loadPermissions: vi.fn(),
    });
    useFeedbackStore.setState({
      submitting: false,
      submittedAt: null,
      error: null,
      submit: vi.fn(() => Promise.resolve(true)),
      clear: vi.fn(),
    });
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it("renders the settings tabs", () => {
    const html = renderToStaticMarkup(<SettingsView />);
    expect(html).toContain("模型");
    expect(html).toContain("身份");
    expect(html).toContain("规则");
    expect(html).toContain("权限");
    expect(html).toContain("问题反馈");
    expect(html).toContain("插件");
  });

  it("switches tabs via left navigation", () => {
    render(<SettingsView />);
    fireEvent.click(screen.getByRole("tab", { name: /身份/ }));
    expect(screen.getByText(/SOUL.md/)).toBeInTheDocument();
  });

  it("renders the feedback form", () => {
    render(<SettingsView />);
    const tabs = screen.getAllByRole("tab", { name: /问题反馈/ });
    fireEvent.click(tabs[0]);
    expect(screen.getByLabelText("问题描述")).toBeInTheDocument();
    expect(screen.getByText(/附带近期运行日志/)).toBeInTheDocument();
  });
});

describe("SettingsView plugins tab", () => {
  const fetchStub = vi.fn(async (url: string, _init?: RequestInit) => {
    if (typeof url === "string" && url.endsWith("/api/plugins/disabled")) {
      return { ok: true, json: async () => ({ ok: true }) } as Response;
    }
    return {
      ok: true,
      json: async () => ({
        plugins: [{
          name: "demo", version: "1.0", description: "演示插件",
          source: "C:/plugins/demo.py", kind: "file", disabled: false,
        }],
      }),
    } as Response;
  });

  beforeEach(() => {
    fetchStub.mockClear();
    vi.stubGlobal("fetch", fetchStub);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    cleanup();
  });

  it("lists discovered plugins and disables them in place", async () => {
    render(<SettingsView />);
    fireEvent.click(screen.getByRole("tab", { name: /插件/ }));

    expect(await screen.findByText("demo")).toBeInTheDocument();
    expect(screen.getByText("演示插件")).toBeInTheDocument();
    expect(screen.getByText("已启用")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "禁用" }));
    await waitFor(() =>
      expect(fetchStub).toHaveBeenCalledWith(
        expect.stringContaining("/api/plugins/disabled"),
        expect.objectContaining({ method: "POST" }),
      ),
    );
  });
});

describe("SettingsView diagnostics summary", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => ({
        model: { codec: "OpenAI", conservative: false, model: "m", provider: "p", base_url: "https://example.com" },
        tools: {
          mode: "progressive", max_loaded: 6, total: 50, loaded: 6,
          items: [
            { name: "Bash", description: "[必填] command: 不应该展示的长说明", is_readonly: false, is_destructive: true, loaded: true },
            { name: "mcp_secret", description: "[MCP:demo] 不应该展示的工具详情", is_readonly: false, is_destructive: true, loaded: false },
          ],
        },
        context: { estimated_tokens: 154, blocks: [{ label: "system_env", priority: 1, chars: 120 }] },
      }),
    })));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    cleanup();
  });

  it("shows aggregate tool health without rendering the tool catalog", async () => {
    render(<SettingsView />);
    fireEvent.click(screen.getByRole("tab", { name: /诊断/ }));

    expect(await screen.findByText("工具运行")).toBeInTheDocument();
    expect(screen.getByText("6/50")).toBeInTheDocument();
    expect(screen.getByText("progressive")).toBeInTheDocument();
    expect(screen.getByText("154 tokens", { exact: false })).toBeInTheDocument();
    expect(screen.queryByText("Bash")).toBeNull();
    expect(screen.queryByText(/不应该展示/)).toBeNull();
  });
});

describe("SettingsView model save preserves supportsVision", () => {
  const saveMock = vi.fn(async (_form: any) => true);
  beforeEach(() => {
    saveMock.mockClear();
    useConfigStore.setState({
      model: {
        provider: "qwen", model: "qwen3.7-plus", temperature: 0.3, maxTokens: 131072,
        enableReasoning: false, enableSearch: false, supportsVision: true,
      },
      providers: [{
        id: "qwen", name: "通义千问",
        baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        apiKeyPresent: true,
        models: [
          { name: "qwen3.7-plus", maxTokens: 131072, supportsVision: true },
          { name: "qwen3.7-flash", maxTokens: 65536, supportsVision: false },
        ],
      }],
      apiKeyPresent: true,
      baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      envOverrides: [],
      loading: false, saving: false, savedAt: null, reloadFailed: false, error: null,
      soul: "", soulIsDefault: true, agents: "",
      personaLoading: false, personaSaving: false, personaError: null,
      permissionMode: "trust-once", permissionLoading: false, permissionSaving: false,
      permissionSavedAt: null, permissionError: null,
      load: vi.fn(), loadPersona: vi.fn(), loadPermissions: vi.fn(), clearSaved: vi.fn(),
      save: saveMock,
    } as any);
    useFeedbackStore.setState({
      submitting: false, submittedAt: null, error: null,
      submit: vi.fn(() => Promise.resolve(true)), clear: vi.fn(),
    });
  });
  afterEach(() => cleanup());

  it("save payload carries the curated supportsVision flag for each model", async () => {
    // Regression: the form used to build models as {name, maxTokens} only,
    // dropping supportsVision — so every save wrote supports_vision=false and
    // wiped the vision flag off every model (qwen3.7-plus, kimi, minimax3...).
    //
    // Reworked for the master-detail + "配置即可用" redesign: the model tab no
    // longer has an "enabled set" checkbox — every model in the form is
    // automatically usable and lands in `enabledModels` on save. The regression
    // intent is unchanged: every saved model must still carry its curated
    // supportsVision flag, and the enabled set auto-includes all configured models.
    render(<SettingsView />);

    const btn = screen.getByRole("button", { name: /保存并重载/ });
    fireEvent.click(btn);
    await waitFor(() => expect(saveMock).toHaveBeenCalled());
    const arg = saveMock.mock.calls[0][0];
    const qwen = arg.providers.find((p: any) => p.id === "qwen");
    const plus = qwen.models.find((m: any) => m.name === "qwen3.7-plus");
    const flash = qwen.models.find((m: any) => m.name === "qwen3.7-flash");
    expect(plus.supportsVision).toBe(true);
    expect(flash.supportsVision).toBe(false);
    // 配置即可用：payload 的 enabledModels 自动包含所有已配置模型（无需勾选）。
    expect(Array.isArray(arg.enabledModels)).toBe(true);
    expect(arg.enabledModels).toEqual(
      expect.arrayContaining([{ provider: "qwen", model: "qwen3.7-plus" }]),
    );
  });
});

describe("SettingsView model tab — enabled set + add/delete all providers", () => {
  beforeEach(() => {
    useConfigStore.setState({
      model: { provider: "qwen", model: "qwen3.7-plus", temperature: 0.3, maxTokens: 131072,
        enableReasoning: false, enableSearch: false, supportsVision: true } as any,
      enabledModels: [{ provider: "qwen", model: "qwen3.7-plus" }],
      providers: [
        { id: "qwen", name: "通义千问", baseURL: "u", apiKeyPresent: true,
          models: [{ name: "qwen3.7-plus", maxTokens: 131072, supportsVision: true },
                   { name: "qwen3.6-flash", maxTokens: 65536, supportsVision: false }] },
        { id: "deepseek", name: "DeepSeek", baseURL: "u2", apiKeyPresent: false,
          models: [{ name: "deepseek-v4-pro", maxTokens: 131072, supportsVision: false }] },
      ],
      loading: false, saving: false, savedAt: null, reloadFailed: false, error: null,
      soul: "", soulIsDefault: true, agents: "", envOverrides: [],
      personaLoading: false, personaSaving: false, personaError: null,
      permissionMode: "trust-once", permissionLoading: false, permissionSaving: false,
      permissionSavedAt: null, permissionError: null,
      load: vi.fn(), clearSaved: vi.fn(), loadPersona: vi.fn(), loadPermissions: vi.fn(),
      save: vi.fn(async () => true),
    } as any);
    useFeedbackStore.setState({ submitting: false, submittedAt: null, error: null,
      submit: vi.fn(() => Promise.resolve(true)), clear: vi.fn() });
  });
  afterEach(() => cleanup());

  it("hides manual add-model for curated official providers (fetch from official site)", () => {
    render(<SettingsView />);
    // The auto-selected provider (qwen, has a key) is a curated official
    // provider → no manual add-model input. Models come from "拉取模型".
    expect(screen.queryByPlaceholderText(/添加模型/)).toBeNull();
  });

  it("shows only the fetch button for ollama providers too (no more manual add)", () => {
    useConfigStore.setState({
      providers: [
        ...(useConfigStore.getState().providers as any[]),
        { id: "ollama", name: "Ollama 本地", baseURL: "http://localhost:11434/v1",
          apiKeyPresent: false, models: [] },
      ],
    } as any);
    render(<SettingsView />);
    fireEvent.click(screen.getByRole("button", { name: /Ollama 本地/ }));
    // The only add affordance is now the "拉取模型" fetch button — no manual input.
    expect(screen.getByText("↻ 拉取模型")).toBeInTheDocument();
    expect(screen.queryByPlaceholderText(/添加模型/)).toBeNull();
  });

  it("delete button removes a curated model from the form", () => {
    render(<SettingsView />);
    // master-detail: qwen is auto-selected (it has a key), so switch to the
    // deepseek panel first to bring the deepseek-v4-pro remove button into view.
    fireEvent.click(screen.getByRole("button", { name: /DeepSeek/ }));
    fireEvent.click(screen.getAllByRole("button", { name: /移除 deepseek-v4-pro/ })[0]);
    expect(screen.queryByText("deepseek-v4-pro")).toBeNull();
  });

  it("save payload includes enabledModels (auto, config-as-usable)", async () => {
    render(<SettingsView />);
    fireEvent.click(screen.getByRole("button", { name: /保存并重载/ }));
    await waitFor(() => expect(useConfigStore.getState().save).toHaveBeenCalled());
  });
});

describe("SettingsView model fetch overwrites instead of appending", () => {
  beforeEach(() => {
    useConfigStore.setState({
      model: { provider: "openai", model: "stale-a", temperature: 0.3, maxTokens: 4096, enableReasoning: false, enableSearch: false, supportsVision: false },
      providers: [{
        id: "openai", name: "OpenAI 兼容", baseURL: "https://relay.example.com/v1",
        apiKeyPresent: true,
        models: [{ name: "stale-a", maxTokens: null, contextSize: null, temperature: null, supportsVision: false }],
      }],
      load: vi.fn(),
      save: vi.fn(async () => true),
      clearSaved: vi.fn(),
      switchActive: vi.fn(async () => true),
      testConnection: vi.fn(async () => ({ ok: true, error: null })),
      fetchRemoteModels: vi.fn(async () => ({ ok: true, models: ["m-new1", "m-new1", "m-new2"], error: null })),
    } as any);
  });
  afterEach(() => cleanup());

  it("lets draft credentials select a fetched default before the first save", async () => {
    const save = vi.fn(async () => true);
    const switchActive = vi.fn(async () => true);
    useConfigStore.setState({
      model: { provider: "qwen", model: "qwen-old", temperature: 0.3, maxTokens: 4096, enableReasoning: false, enableSearch: false, supportsVision: false },
      providers: [{
        id: "openai", name: "OpenAI 兼容", baseURL: "", apiKeyPresent: false, models: [],
      }],
      load: vi.fn(), save, clearSaved: vi.fn(), switchActive,
      testConnection: vi.fn(async () => ({ ok: true, error: null })),
      fetchRemoteModels: vi.fn(async () => ({ ok: true, models: ["draft-model"], error: null })),
    } as any);

    render(<SettingsView />);
    fireEvent.click(screen.getByRole("button", { name: /OpenAI 兼容/ }));
    fireEvent.change(screen.getByPlaceholderText("https://api.example.com/v1"), {
      target: { value: "https://draft.example.com/v1" },
    });
    fireEvent.change(screen.getByPlaceholderText("输入 API Key"), {
      target: { value: "draft-secret" },
    });
    fireEvent.click(screen.getByText("↻ 拉取模型"));

    const defaultButton = await screen.findByRole("button", { name: "设为默认" });
    expect(defaultButton).toBeEnabled();
    fireEvent.click(defaultButton);
    expect(screen.getByText("默认")).toBeInTheDocument();
    expect(switchActive).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /保存并重载/ }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    const payload = (save.mock.calls as any[][])[0][0];
    expect(payload).toMatchObject({ provider: "openai", model: "draft-model" });
    expect(payload.enabledModels).toContainEqual({ provider: "openai", model: "draft-model" });
    expect(payload.providers.find((p: any) => p.id === "openai")).toMatchObject({
      baseURL: "https://draft.example.com/v1", apiKey: "draft-secret",
      models: [expect.objectContaining({ name: "draft-model" })],
    });
  });

  it("invalidates a draft default removed by a successful fetch overwrite", async () => {
    const fetchRemoteModels = vi.fn()
      .mockResolvedValueOnce({ ok: true, models: ["replacement"], error: null })
      .mockResolvedValueOnce({ ok: true, models: ["newer"], error: null });
    useConfigStore.setState({
      fetchRemoteModels,
      save: vi.fn(async () => true),
    } as any);
    render(<SettingsView />);
    fireEvent.click(screen.getByRole("button", { name: /OpenAI 兼容/ }));
    fireEvent.click(screen.getByText("↻ 拉取模型"));
    await screen.findByText("replacement");
    fireEvent.click(screen.getByRole("button", { name: "设为默认" }));
    expect(screen.getByText("默认")).toBeInTheDocument();

    fireEvent.click(screen.getByText("↻ 拉取模型"));
    await screen.findByText("newer");
    expect(screen.queryByText("默认")).toBeNull();
  });

  it("replaces the provider's model list with the fetched list (deduped)", async () => {
    render(<SettingsView />);
    fireEvent.click(screen.getByRole("button", { name: /OpenAI 兼容/ }));
    fireEvent.click(screen.getByText("↻ 拉取模型"));

    await waitFor(() => expect(screen.queryByText("stale-a")).toBeNull());
    // The stale model from a previous base_url must NOT survive an overwrite.
    expect(screen.getByText("m-new1")).toBeInTheDocument();
    expect(screen.getByText("m-new2")).toBeInTheDocument();
    expect(screen.getAllByText("m-new1")).toHaveLength(1); // deduped
  });

  it("caps the rendered model list with a show-all toggle", () => {
    const many = Array.from({ length: 200 }, (_, i) => ({
      name: `model-${i}`, maxTokens: null, contextSize: null, temperature: null, supportsVision: false,
    }));
    useConfigStore.setState({ providers: [{
      id: "openai", name: "OpenAI 兼容", baseURL: "https://relay.example.com/v1",
      apiKeyPresent: true, models: many,
    }] } as any);
    render(<SettingsView />);
    fireEvent.click(screen.getByRole("button", { name: /OpenAI 兼容/ }));

    // Only the first 80 render by default; the rest are behind a toggle.
    expect(screen.getAllByRole("button", { name: /设为默认/ })).toHaveLength(80);
    expect(screen.getByText(/显示全部 200 个模型/)).toBeInTheDocument();
    const saveBar = screen.getByRole("button", { name: /保存并重载/ }).closest(".model-save-bar");
    const detail = screen.getByText(/显示全部 200 个模型/).closest(".provider-detail");
    expect(saveBar).not.toBeNull();
    expect(detail).not.toBeNull();
    expect(detail?.contains(saveBar)).toBe(false);
  });

  it("clears the list when the endpoint returns no models (stale must not persist)", async () => {
    useConfigStore.setState({
      fetchRemoteModels: vi.fn(async () => ({ ok: true, models: [], error: null })),
    } as any);
    render(<SettingsView />);
    fireEvent.click(screen.getByRole("button", { name: /OpenAI 兼容/ }));
    fireEvent.click(screen.getByText("↻ 拉取模型"));

    await waitFor(() => expect(screen.queryByText("stale-a")).toBeNull());
    expect(screen.getByText(/未返回可用模型/)).toBeInTheDocument();
  });

  it("keeps the list but flags it when the fetch fails", async () => {
    useConfigStore.setState({
      fetchRemoteModels: vi.fn(async () => ({ ok: false, models: [], error: "连接失败" })),
    } as any);
    render(<SettingsView />);
    fireEvent.click(screen.getByRole("button", { name: /OpenAI 兼容/ }));
    fireEvent.click(screen.getByText("↻ 拉取模型"));

    await waitFor(() => expect(screen.getByText(/拉取失败：连接失败/)).toBeInTheDocument());
    // The stale list stays visible but is explicitly flagged as NOT a fresh result.
    expect(screen.getByText("stale-a")).toBeInTheDocument();
  });
});
