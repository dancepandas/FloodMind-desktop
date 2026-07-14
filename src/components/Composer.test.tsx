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
let mockRecent: { path: string; name: string }[] = [{ path: "/ws2", name: "ws2" }];
let mockPending: string[] = [];
const listFilesMock = vi.fn(() => Promise.resolve(mockFiles));
const openPathMock = vi.fn();
const pickAndOpenMock = vi.fn();
const setViewMock = vi.fn();

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
      recent: mockRecent,
      listFiles: listFilesMock,
      openPath: openPathMock,
      pickAndOpen: pickAndOpenMock,
    }),
}));

vi.mock("../state/ui-store", () => ({
  useUiStore: (selector: (s: any) => any) =>
    selector({
      setView: setViewMock,
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

vi.mock("../state/catalog-store", () => ({
  useCatalogStore: (selector: (s: any) => any) =>
    selector({
      skills: [{ name: "code-review", description: "Review code", disabled: false }],
      mcpServers: [{ name: "filesystem", connected: true, tools: 3 }],
      loadSkills: vi.fn(),
      loadMcp: vi.fn(),
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
    expect(textarea.value).toBe("review ");
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

  it("opens the slash picker when / is typed", async () => {
    render(<Composer />);
    const textarea = screen.getByLabelText("任务输入");
    fireEvent.change(textarea, { target: { value: "check /" } });
    await screen.findByText("Skills");
    await screen.findByText("MCP 服务器");
    expect(screen.getByText("code-review")).toBeInTheDocument();
    expect(screen.getByText("filesystem")).toBeInTheDocument();
  });

  it("does not open the slash picker for / inside a path or url", async () => {
    render(<Composer />);
    const textarea = screen.getByLabelText("任务输入");
    fireEvent.change(textarea, { target: { value: "src/components" } });
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByText("Skills")).not.toBeInTheDocument();
  });

  it("selects a skill and shows it as a removable pill", async () => {
    render(<Composer />);
    const textarea = screen.getByLabelText("任务输入") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "review /code" } });
    const row = await screen.findByText("code-review");
    fireEvent.click(row);
    expect(textarea.value).toBe("review ");
    expect(screen.getByText("Skill")).toBeInTheDocument();
    expect(screen.getByText("code-review")).toBeInTheDocument();
  });

  it("selects an mcp server and shows it as a removable pill", async () => {
    render(<Composer />);
    const textarea = screen.getByLabelText("任务输入") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "list /file" } });
    const row = await screen.findByText("filesystem");
    fireEvent.click(row);
    expect(textarea.value).toBe("list ");
    expect(screen.getByText("MCP")).toBeInTheDocument();
    expect(screen.getByText("filesystem")).toBeInTheDocument();
  });

  it("removes the slash pill when clicking its remove button", async () => {
    render(<Composer />);
    const textarea = screen.getByLabelText("任务输入");
    fireEvent.change(textarea, { target: { value: "review /code" } });
    const row = await screen.findByText("code-review");
    fireEvent.click(row);
    const remove = screen.getByLabelText("移除 code-review");
    fireEvent.click(remove);
    expect(screen.queryByText("Skill")).not.toBeInTheDocument();
  });

  it("sends message with skill instruction when a skill is selected", async () => {
    render(<Composer />);
    const textarea = screen.getByLabelText("任务输入") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "review /code" } });
    const row = await screen.findByText("code-review");
    fireEvent.click(row);
    fireEvent.click(screen.getByLabelText("发送"));
    expect(sendMock).toHaveBeenCalledWith("review\n\n请使用 code-review skill");
  });

  it("sends message with mcp instruction when an mcp server is selected", async () => {
    render(<Composer />);
    const textarea = screen.getByLabelText("任务输入") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "list files /file" } });
    const row = await screen.findByText("filesystem");
    fireEvent.click(row);
    fireEvent.click(screen.getByLabelText("发送"));
    expect(sendMock).toHaveBeenCalledWith("list files\n\n请使用 filesystem MCP工具");
  });

  it("clears slash item after sending", async () => {
    render(<Composer />);
    const textarea = screen.getByLabelText("任务输入");
    fireEvent.change(textarea, { target: { value: "review /code" } });
    fireEvent.click(await screen.findByText("code-review"));
    fireEvent.click(screen.getByLabelText("发送"));
    expect(screen.queryByText("Skill")).not.toBeInTheDocument();
  });

  it("returns focus to textarea after slash selection", async () => {
    render(<Composer />);
    const textarea = screen.getByLabelText("任务输入") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "review /code" } });
    fireEvent.click(await screen.findByText("code-review"));
    expect(document.activeElement).toBe(textarea);
  });

  it("switches from slash picker to file picker when @ is typed", async () => {
    render(<Composer />);
    const textarea = screen.getByLabelText("任务输入") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "review /code" } });
    await screen.findByText("code-review");
    fireEvent.change(textarea, { target: { value: "review /code@r" } });
    await screen.findByText("readme.md");
    expect(screen.queryByText("Skills")).not.toBeInTheDocument();
  });

  it("can use @ file picker after selecting a slash skill", async () => {
    render(<Composer />);
    const textarea = screen.getByLabelText("任务输入") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "review /code" } });
    fireEvent.click(await screen.findByText("code-review"));
    expect(textarea.value).toBe("review ");
    fireEvent.change(textarea, { target: { value: "review @r" } });
    await screen.findByText("readme.md");
  });

  it("returns focus to textarea after file selection", async () => {
    render(<Composer />);
    const textarea = screen.getByLabelText("任务输入") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "review @r" } });
    fireEvent.click(await screen.findByText("readme.md"));
    expect(document.activeElement).toBe(textarea);
  });
});
