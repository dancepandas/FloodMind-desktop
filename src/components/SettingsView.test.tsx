import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
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
