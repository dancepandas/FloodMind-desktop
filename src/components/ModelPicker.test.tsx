import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import ModelPicker from "./ModelPicker";
import { useConfigStore } from "../state/config-store";

vi.mock("../state/chat-store", () => ({
  useChatStore: (sel: (s: any) => any) => sel({ streaming: false }),
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

  it("shows only usable models grouped by provider", () => {
    render(<ModelPicker onPick={() => {}} onClose={() => {}} />);
    // qwen has apiKey → shown
    expect(screen.getByText("通义千问")).toBeInTheDocument();
    expect(screen.getByText("qwen3.7-plus")).toBeInTheDocument();
    expect(screen.getByText("qwen3.6-flash")).toBeInTheDocument();
    // moonshot has no apiKey → hidden entirely (no group header, no model)
    expect(screen.queryByText("月之暗面")).not.toBeInTheDocument();
    expect(screen.queryByText("kimi-2.6")).not.toBeInTheDocument();
  });

  it("shows vision badge only for vision models", () => {
    render(<ModelPicker onPick={() => {}} onClose={() => {}} />);
    // only qwen3.7-plus has supportsVision in the visible set
    expect(document.querySelectorAll('[data-vision="true"]').length).toBe(1);
  });

  it("hides models whose provider has no api key", () => {
    const onPick = vi.fn();
    render(<ModelPicker onPick={onPick} onClose={() => {}} />);
    // kimi-2.6 is not rendered at all because moonshot has no key
    expect(screen.queryByText("kimi-2.6")).toBeNull();
  });

  it("picks a usable model", () => {
    const onPick = vi.fn();
    render(<ModelPicker onPick={onPick} onClose={() => {}} />);
    fireEvent.click(screen.getByText("qwen3.6-flash"));
    expect(onPick).toHaveBeenCalledWith("qwen", "qwen3.6-flash");
  });

  it("allows picking local provider (ollama) models without an api key", () => {
    useConfigStore.setState({
      model: { provider: "ollama", model: "llama3" } as any,
      enabledModels: [{ provider: "ollama", model: "llama3" }],
      providers: [
        { id: "ollama", name: "Ollama 本地", baseURL: "http://localhost:11434/v1", apiKeyPresent: false,
          models: [{ name: "llama3", maxTokens: 4096, supportsVision: false }] },
      ],
      switching: false,
    } as any);
    const onPick = vi.fn();
    render(<ModelPicker onPick={onPick} onClose={() => {}} />);
    const btn = screen.getByText("llama3").closest("button")!;
    expect(btn).not.toHaveAttribute("disabled");
    fireEvent.click(btn);
    expect(onPick).toHaveBeenCalledWith("ollama", "llama3");
  });
});
