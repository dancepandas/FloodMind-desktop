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
  });
});
