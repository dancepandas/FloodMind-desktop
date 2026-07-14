import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import Composer from "./Composer";
import type { FileEntry } from "../state/workspace-store";

const sendMock = vi.fn();
const pauseMock = vi.fn();
const addAttachmentsMock = vi.fn();
const removeAttachmentMock = vi.fn();
const clearAttachmentsMock = vi.fn();

let mockFiles: FileEntry[] = [];
let mockCurrent: { path: string; name: string } | null = { path: "/ws", name: "ws" };
let mockPending: string[] = [];
const listFilesMock = vi.fn(() => Promise.resolve(mockFiles));

vi.mock("../state/chat-store", () => ({
  useChatStore: (selector: (s: any) => any) =>
    selector({
      streaming: false,
      send: sendMock,
      pause: pauseMock,
    }),
}));

vi.mock("../state/workspace-store", () => ({
  useWorkspaceStore: (selector: (s: any) => any) =>
    selector({
      current: mockCurrent,
      listFiles: listFilesMock,
    }),
}));

vi.mock("../state/attachment-store", () => ({
  useAttachmentStore: (selector: (s: any) => any) =>
    selector({
      pending: mockPending,
      add: addAttachmentsMock,
      remove: removeAttachmentMock,
      clear: clearAttachmentsMock,
    }),
}));

describe("Composer", () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockFiles = [{ name: "readme.md", type: "file", path: "readme.md" }];
    mockCurrent = { path: "/ws", name: "ws" };
    mockPending = [];
  });

  it("opens the file picker when @ is typed", async () => {
    render(<Composer />);
    const textarea = screen.getByLabelText("任务输入");
    fireEvent.change(textarea, { target: { value: "check @" } });
    await screen.findByText("readme.md");
  });

  it("inserts the selected file and adds it as an attachment", async () => {
    render(<Composer />);
    const textarea = screen.getByLabelText("任务输入") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "review @r" } });
    const row = await screen.findByText("readme.md");
    fireEvent.click(row);
    expect(textarea.value).toBe("review @readme.md ");
    expect(addAttachmentsMock).toHaveBeenCalledWith(["readme.md"]);
  });

  it("closes the picker when a space is typed after @", async () => {
    render(<Composer />);
    const textarea = screen.getByLabelText("任务输入");
    fireEvent.change(textarea, { target: { value: "check @" } });
    await screen.findByText("readme.md");
    fireEvent.change(textarea, { target: { value: "check @ " } });
    expect(screen.queryByText("readme.md")).not.toBeInTheDocument();
  });
});
