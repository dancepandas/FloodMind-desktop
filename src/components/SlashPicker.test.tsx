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

  it("shows empty hint when nothing matches", () => {
    render(<SlashPicker query="zzzzz" onSelect={onSelect} onClose={onClose} />);
    expect(screen.getByText("无匹配项")).toBeInTheDocument();
  });
});
