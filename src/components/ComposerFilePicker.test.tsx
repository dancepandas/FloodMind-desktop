import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import ComposerFilePicker from "./ComposerFilePicker";
import type { FileEntry } from "../state/workspace-store";

let mockFiles: FileEntry[] = [];
let mockCurrent: { path: string; name: string } | null = { path: "/ws", name: "ws" };
const listFilesMock = vi.fn(() => Promise.resolve(mockFiles));

vi.mock("../state/workspace-store", () => ({
  useWorkspaceStore: (selector: (s: any) => any) =>
    selector({
      current: mockCurrent,
      listFiles: listFilesMock,
    }),
}));

describe("ComposerFilePicker", () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    listFilesMock.mockClear();
    mockFiles = [
      { name: "a.txt", type: "file", path: "a.txt" },
      { name: "b.tsx", type: "file", path: "b.tsx" },
      { name: "notes", type: "dir", path: "notes" },
    ];
    mockCurrent = { path: "/ws", name: "ws" };
  });

  it("shows matching files and selects", async () => {
    const onSelect = vi.fn();
    render(
      <ComposerFilePicker query="a" onSelect={onSelect} onClose={vi.fn()} />
    );
    const row = await screen.findByText("a.txt");
    expect(screen.queryByText("b.tsx")).not.toBeInTheDocument();
    fireEvent.click(row);
    expect(onSelect).toHaveBeenCalledWith("a.txt");
  });

  it("filters case-insensitively", async () => {
    render(
      <ComposerFilePicker query="B" onSelect={vi.fn()} onClose={vi.fn()} />
    );
    await screen.findByText("b.tsx");
    expect(screen.queryByText("a.txt")).not.toBeInTheDocument();
  });

  it("shows empty state when nothing matches", async () => {
    render(
      <ComposerFilePicker query="zzz" onSelect={vi.fn()} onClose={vi.fn()} />
    );
    await screen.findByText("无匹配文件");
  });

  it("renders nothing without a workspace", () => {
    mockCurrent = null;
    const { container } = render(
      <ComposerFilePicker query="" onSelect={vi.fn()} onClose={vi.fn()} />
    );
    expect(container.firstChild).toBeNull();
  });
});
