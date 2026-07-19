import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import ModelPicker from "./ModelPicker";
import { useConfigStore } from "../state/config-store";

vi.mock("../state/chat-store", () => ({
  useChatStore: (sel: (s: any) => any) => sel({ streaming: false }),
}));
vi.mock("../state/ui-store", () => ({
  useUiStore: (sel: (s: any) => any) => sel({ showToast: vi.fn() }),
}));

describe("ModelPicker", () => {
  afterEach(() => cleanup());

  beforeEach(() => {
    useConfigStore.setState({
      model: { provider: "qwen", model: "qwen3.7-plus" } as any,
      enabledModels: [
        { provider: "qwen", model: "qwen3.7-plus" },
        { provider: "qwen", model: "qwen3.6-flash" },
        { provider: "moonshot", model: "kimi-2.6" },
      ],
      providers: [
        { id: "qwen", name: "通义千问", baseURL: "", apiKeyPresent: true,
          models: [{ name: "qwen3.7-plus", maxTokens: 131072, supportsVision: true },
                   { name: "qwen3.6-flash", maxTokens: 65536, supportsVision: false }] },
        { id: "moonshot", name: "月之暗面", baseURL: "", apiKeyPresent: false,
          models: [{ name: "kimi-2.6", maxTokens: 131072, supportsVision: true }] },
      ],
      switching: false,
    } as any);
  });

  it("groups enabled models by provider", () => {
    render(<ModelPicker onPick={() => {}} onClose={() => {}} />);
    expect(screen.getByText("通义千问")).toBeInTheDocument();
    expect(screen.getByText("月之暗面")).toBeInTheDocument();
    expect(screen.getByText("qwen3.7-plus")).toBeInTheDocument();
    expect(screen.getByText("kimi-2.6")).toBeInTheDocument();
  });

  it("shows vision badge only for vision models", () => {
    render(<ModelPicker onPick={() => {}} onClose={() => {}} />);
    expect(document.querySelectorAll('[data-vision="true"]').length).toBeGreaterThanOrEqual(2);
  });

  it("greys out models whose provider has no api key and blocks pick", () => {
    const onPick = vi.fn();
    render(<ModelPicker onPick={onPick} onClose={() => {}} />);
    const kimiBtn = screen.getByText("kimi-2.6").closest("button")!;
    expect(kimiBtn).toHaveAttribute("disabled");
    fireEvent.click(kimiBtn);
    expect(onPick).not.toHaveBeenCalled();
  });

  it("picks a usable model", () => {
    const onPick = vi.fn();
    render(<ModelPicker onPick={onPick} onClose={() => {}} />);
    fireEvent.click(screen.getByText("qwen3.6-flash"));
    expect(onPick).toHaveBeenCalledWith("qwen", "qwen3.6-flash");
  });
});
