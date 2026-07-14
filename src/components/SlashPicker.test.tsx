import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import SlashPicker from "./SlashPicker";
import { useCatalogStore } from "../state/catalog-store";

describe("SlashPicker", () => {
  const onSelect = vi.fn();
  const onClose = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    useCatalogStore.setState({
      skills: [
        { name: "code-review", description: "Review code", disabled: false },
        { name: "csv", description: "CSV ops", disabled: true },
      ],
      mcpServers: [
        { name: "filesystem", connected: true, tools: 3 },
        { name: "github", connected: false, tools: 0 },
      ],
      loadSkills: vi.fn(),
      loadMcp: vi.fn(),
    } as any);
  });

  afterEach(() => {
    cleanup();
  });

  it("loads skills and mcp servers on mount", () => {
    const loadSkills = vi.fn();
    const loadMcp = vi.fn();
    useCatalogStore.setState({ loadSkills, loadMcp } as any);
    render(<SlashPicker query="" onSelect={onSelect} onClose={onClose} />);
    expect(loadSkills).toHaveBeenCalledTimes(1);
    expect(loadMcp).toHaveBeenCalledTimes(1);
  });

  it("renders enabled skills and all mcp servers", () => {
    render(<SlashPicker query="" onSelect={onSelect} onClose={onClose} />);
    expect(screen.getByText("code-review")).toBeInTheDocument();
    expect(screen.queryByText("csv")).not.toBeInTheDocument();
    expect(screen.getByText("filesystem")).toBeInTheDocument();
    expect(screen.getByText("github")).toBeInTheDocument();
  });

  it("filters items by query", () => {
    render(<SlashPicker query="file" onSelect={onSelect} onClose={onClose} />);
    expect(screen.queryByText("code-review")).not.toBeInTheDocument();
    expect(screen.getByText("filesystem")).toBeInTheDocument();
    expect(screen.queryByText("github")).not.toBeInTheDocument();
  });

  it("calls onSelect with skill when a skill row is clicked", () => {
    render(<SlashPicker query="" onSelect={onSelect} onClose={onClose} />);
    fireEvent.click(screen.getByText("code-review"));
    expect(onSelect).toHaveBeenCalledWith({ kind: "skill", name: "code-review" });
  });

  it("calls onSelect with mcp when an mcp row is clicked", () => {
    render(<SlashPicker query="" onSelect={onSelect} onClose={onClose} />);
    fireEvent.click(screen.getByText("filesystem"));
    expect(onSelect).toHaveBeenCalledWith({ kind: "mcp", name: "filesystem" });
  });

  it("closes on Escape", () => {
    render(<SlashPicker query="" onSelect={onSelect} onClose={onClose} />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("closes on Escape even when focus is outside the picker", () => {
    render(<SlashPicker query="" onSelect={onSelect} onClose={onClose} />);
    const outside = document.createElement("button");
    document.body.appendChild(outside);
    outside.focus();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
    document.body.removeChild(outside);
  });

  it("shows empty hint when nothing matches", () => {
    render(<SlashPicker query="zzzzz" onSelect={onSelect} onClose={onClose} />);
    expect(screen.getByText("无匹配项")).toBeInTheDocument();
  });

  it("renders MCP tool count", () => {
    render(<SlashPicker query="" onSelect={onSelect} onClose={onClose} />);
    expect(screen.getByText("3 tools")).toBeInTheDocument();
    expect(screen.getByText("0 tools")).toBeInTheDocument();
  });

  it("highlights the first option by default and moves with arrow keys", () => {
    render(<SlashPicker query="" onSelect={onSelect} onClose={onClose} />);
    const listbox = screen.getByRole("listbox");
    listbox.focus();
    expect(listbox).toHaveAttribute("aria-activedescendant", "slash-picker-option-0");
    expect(document.getElementById("slash-picker-option-0")).toHaveClass("slash-picker-row-active");

    fireEvent.keyDown(window, { key: "ArrowDown" });
    expect(listbox).toHaveAttribute("aria-activedescendant", "slash-picker-option-1");
    expect(document.getElementById("slash-picker-option-1")).toHaveClass("slash-picker-row-active");

    fireEvent.keyDown(window, { key: "ArrowDown" });
    expect(listbox).toHaveAttribute("aria-activedescendant", "slash-picker-option-2");

    fireEvent.keyDown(window, { key: "ArrowUp" });
    expect(listbox).toHaveAttribute("aria-activedescendant", "slash-picker-option-1");
  });

  it("selects the active option on Enter", () => {
    render(<SlashPicker query="" onSelect={onSelect} onClose={onClose} />);
    const listbox = screen.getByRole("listbox");
    listbox.focus();
    fireEvent.keyDown(window, { key: "ArrowDown" });
    fireEvent.keyDown(window, { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith({ kind: "mcp", name: "filesystem" });
  });
});
