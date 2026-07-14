import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import ComposerFilePicker from "./ComposerFilePicker";
import type { FileEntry } from "../state/workspace-store";

let fileTree: Record<string, FileEntry[]> = {};
let mockCurrent: { path: string; name: string } | null = { path: "/ws", name: "ws" };
const listFilesMock = vi.fn((relPath?: string) =>
  Promise.resolve(fileTree[relPath || "."] ?? [])
);

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
    fileTree = {
      ".": [
        { name: "a.txt", type: "file", path: "a.txt" },
        { name: "b.tsx", type: "file", path: "b.tsx" },
        { name: "notes", type: "dir", path: "notes" },
      ],
      notes: [
        { name: "c.md", type: "file", path: "notes/c.md" },
        { name: "deep", type: "dir", path: "notes/deep" },
      ],
      "notes/deep": [
        { name: "d.py", type: "file", path: "notes/deep/d.py" },
      ],
    };
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

  it("shows nested files and inserts their relative path", async () => {
    const onSelect = vi.fn();
    render(
      <ComposerFilePicker query="c" onSelect={onSelect} onClose={vi.fn()} />
    );
    const row = await screen.findByText("notes/c.md");
    fireEvent.click(row);
    expect(onSelect).toHaveBeenCalledWith("notes/c.md");
  });

  it("filters nested files by full relative path", async () => {
    render(
      <ComposerFilePicker query="notes" onSelect={vi.fn()} onClose={vi.fn()} />
    );
    await screen.findByText("notes/c.md");
    expect(screen.queryByText("a.txt")).not.toBeInTheDocument();
  });

  it("recursively finds deeply nested files", async () => {
    render(
      <ComposerFilePicker query="d.py" onSelect={vi.fn()} onClose={vi.fn()} />
    );
    await screen.findByText("notes/deep/d.py");
  });

  it("fetches the workspace tree only once and filters locally when query changes", async () => {
    const { rerender } = render(
      <ComposerFilePicker query="a" onSelect={vi.fn()} onClose={vi.fn()} />
    );
    await screen.findByText("a.txt");
    expect(listFilesMock).toHaveBeenCalled();
    const callCountAfterFirstRender = listFilesMock.mock.calls.length;

    rerender(
      <ComposerFilePicker query="b" onSelect={vi.fn()} onClose={vi.fn()} />
    );
    await screen.findByText("b.tsx");
    await waitFor(() => {
      expect(listFilesMock.mock.calls.length).toBe(callCountAfterFirstRender);
    });
  });
});
