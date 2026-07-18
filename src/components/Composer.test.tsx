import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import Composer, { collectPastedImages } from "./Composer";
import type { FileEntry } from "../state/workspace-store";

const sendMock = vi.fn();
const pauseMock = vi.fn();
const addAttachmentsMock = vi.fn();
const removeAttachmentMock = vi.fn();
const clearAttachmentsMock = vi.fn();
const addImagesMock = vi.fn();
const removeImageMock = vi.fn();

let mockFiles: FileEntry[] = [];
let mockCurrent: { path: string; name: string } | null = { path: "/ws", name: "ws" };
let mockRecent: { path: string; name: string }[] = [{ path: "/ws2", name: "ws2" }];
let mockPending: string[] = [];
let mockImages: any[] = [];
let mockModel: any = null;
let mockStreaming = false;
const listFilesMock = vi.fn(() => Promise.resolve(mockFiles));
const openPathMock = vi.fn();
const pickAndOpenMock = vi.fn();
const setViewMock = vi.fn();

vi.mock("../state/chat-store", () => ({
  useChatStore: (selector: (s: any) => any) =>
    selector({
      streaming: mockStreaming,
      send: sendMock,
      pause: pauseMock,
    }),
}));

vi.mock("../state/config-store", () => ({
  useConfigStore: (selector: (s: any) => any) =>
    selector({
      permissionMode: "trust-once",
      model: mockModel,
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

vi.mock("../state/attachment-store", () => {
  const selectorFn = (selector: (s: any) => any) =>
    selector({
      pending: mockPending,
      add: addAttachmentsMock,
      remove: removeAttachmentMock,
      clear: clearAttachmentsMock,
      images: mockImages,
      addImages: addImagesMock,
      removeImage: removeImageMock,
      clearImages: vi.fn(),
      toWire: () => [],
    });
  // Composer calls useAttachmentStore.getState().toWire() at send time; mirror
  // the zustand-shaped handle so the production code path works under mock.
  (selectorFn as any).getState = () => ({ toWire: () => [] });
  return { useAttachmentStore: selectorFn };
});

vi.mock("../state/catalog-store", () => ({
  useCatalogStore: (selector: (s: any) => any) =>
    selector({
      skills: [{ name: "code-review", description: "Review code", disabled: false }],
      mcpServers: [{ name: "filesystem", connected: true, tools: 3 }],
      loadSkills: vi.fn(),
      loadMcp: vi.fn(),
    }),
}));

// Tauri drag-drop is a native window event — jsdom cannot fire it, so stub the
// listener registration. The wiring itself is verified in Task 12's manual pass.
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    onDragDropEvent: vi.fn(() => Promise.resolve(() => {})),
  }),
}));

// pathToDataUrl hits the sidecar over the network; stub it so the @ image
// bifurcation test (Task 10) doesn't need a running backend. fileToDataUrl is
// exercised directly via collectPastedImages and stays unmocked; isImageName
// and mimeForName are pure helpers used by the production code path. Use
// vi.hoisted so the mock handle exists by the time vi.mock's hoisted factory
// runs.
const { pathToDataUrlMock } = vi.hoisted(() => ({
  pathToDataUrlMock: vi.fn(async (path: string) => `data:image/png;base64,MOCK-${path}`),
}));
vi.mock("../lib/image-thumb", async () => {
  const actual = await vi.importActual<typeof import("../lib/image-thumb")>("../lib/image-thumb");
  return { ...actual, pathToDataUrl: pathToDataUrlMock };
});

describe("Composer", () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockFiles = [{ name: "readme.md", type: "file", path: "readme.md" }];
    mockCurrent = { path: "/ws", name: "ws" };
    mockPending = [];
    mockImages = [];
    mockStreaming = false;
    // Default: vision-capable model so existing tests behave as before.
    mockModel = {
      provider: "deepseek",
      model: "deepseek-v4-flash",
      temperature: 0.3,
      maxTokens: 8192,
      enableReasoning: false,
      enableSearch: false,
      supportsVision: true,
    };
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
    expect(sendMock).toHaveBeenCalledWith("review\n\n请使用 code-review skill", undefined, undefined);
  });

  it("sends message with mcp instruction when an mcp server is selected", async () => {
    render(<Composer />);
    const textarea = screen.getByLabelText("任务输入") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "list files /file" } });
    const row = await screen.findByText("filesystem");
    fireEvent.click(row);
    fireEvent.click(screen.getByLabelText("发送"));
    expect(sendMock).toHaveBeenCalledWith("list files\n\n请使用 filesystem MCP工具", undefined, undefined);
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

  it("disables the + affordance when the active model lacks vision", () => {
    mockModel = { ...mockModel, supportsVision: false };
    render(<Composer />);
    const addBtn = screen.getByLabelText("引用工作区文件") as HTMLButtonElement;
    expect(addBtn).toBeDisabled();
  });

  it("keeps the + affordance enabled for a vision-capable model", () => {
    render(<Composer />);
    const addBtn = screen.getByLabelText("引用工作区文件") as HTMLButtonElement;
    expect(addBtn).not.toBeDisabled();
  });

  it("renders image chips from the store with a remove button", () => {
    mockImages = [
      {
        id: "img-1",
        name: "shot.png",
        mime: "image/png",
        thumb: "data:image/png;base64,AAAA",
        source: "clipboard",
      },
    ];
    render(<Composer />);
    const thumb = screen.getByAltText("shot.png");
    expect(thumb).toHaveAttribute("src", "data:image/png;base64,AAAA");
    expect(screen.getByLabelText("移除 shot.png")).toBeInTheDocument();
  });

  it("removes an image chip via its remove button", () => {
    mockImages = [
      {
        id: "img-1",
        name: "shot.png",
        mime: "image/png",
        thumb: "data:image/png;base64,AAAA",
        source: "clipboard",
      },
    ];
    render(<Composer />);
    fireEvent.click(screen.getByLabelText("移除 shot.png"));
    expect(removeImageMock).toHaveBeenCalledWith("img-1");
  });

  it("collectPastedImages extracts image files and rejects oversized / non-image items", async () => {
    const ok = new File([new Uint8Array([1, 2, 3])], "shot.png", { type: "image/png" });
    const big = new File([new Uint8Array([4])], "huge.png", { type: "image/png" });
    Object.defineProperty(big, "size", { value: 11 * 1024 * 1024 });
    const txt = new File(["hi"], "note.txt", { type: "text/plain" });

    const items = [
      { kind: "file", type: "image/png", getAsFile: () => ok },
      { kind: "file", type: "image/png", getAsFile: () => big },
      { kind: "file", type: "text/plain", getAsFile: () => txt },
      { kind: "string", type: "text/plain", getAsFile: () => null },
    ] as any;

    const out = await collectPastedImages(items);
    expect(out).toHaveLength(1);
    const first = out[0]!;
    expect(first.name).toBe("shot.png");
    expect(first.source).toBe("clipboard");
    expect(first.mime).toBe("image/png");
    expect(first.thumb.startsWith("data:image/png;base64,")).toBe(true);
    expect(typeof first.data).toBe("string");
    expect(first.data!.length).toBeGreaterThan(0);
  });

  it("does not accept pasted images while streaming", async () => {
    // Single-turn contract: only the initiating send carries images. A paste
    // during an active stream must NOT add an image chip — otherwise it would
    // silently attach to the wrong (next) turn. jsdom has no DataTransfer, so
    // synthesize a clipboardData carrying one image item (same shape the pure
    // collectPastedImages helper expects) and drive the real onPaste handler.
    mockStreaming = true;

    render(<Composer />);
    const textarea = screen.getByLabelText("任务输入") as HTMLTextAreaElement;

    const file = new File([new Uint8Array([1, 2, 3])], "shot.png", { type: "image/png" });
    const clipboardData = {
      items: [{ kind: "file", type: "image/png", getAsFile: () => file }],
    };
    fireEvent.paste(textarea, { clipboardData });

    // Give the async handler a tick in case it had leaked through the gate.
    await new Promise((r) => setTimeout(r, 10));

    expect(addImagesMock).not.toHaveBeenCalled();
  });

  it("forwards attachments + images snapshot when sending", () => {
    mockImages = [
      {
        id: "img-1",
        name: "shot.png",
        mime: "image/png",
        thumb: "data:image/png;base64,AAAA",
        source: "clipboard",
        data: "AAAA",
      },
    ];
    render(<Composer />);
    const ta = screen.getByLabelText("任务输入") as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: "hello" } });
    fireEvent.click(screen.getByLabelText("发送"));
    // The composer builds message text; the chat-store mock just records args.
    expect(sendMock).toHaveBeenCalledTimes(1);
    const args = sendMock.mock.calls[0];
    // images snapshot must be { name, thumb } pairs
    expect(args[2]).toEqual([{ name: "shot.png", thumb: "data:image/png;base64,AAAA" }]);
  });

  it("insertFile routes image files to the visual channel (vision on)", async () => {
    // Task 10: a .png selected via the @ picker must land in images, not pending.
    mockFiles = [{ name: "chart.png", type: "file", path: "chart.png" }];
    render(<Composer />);
    const textarea = screen.getByLabelText("任务输入") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "see @c" } });
    // The row carries a 🖼 prefix + is-image class now (Task 10 visual marker),
    // so match on role + name rather than the exact filename text.
    const row = await screen.findByRole("option", { name: /chart\.png/ });
    expect(row).toHaveClass("is-image");
    fireEvent.click(row);
    // pathToDataUrl is awaited inside insertFile; let it resolve.
    await waitFor(() => expect(pathToDataUrlMock).toHaveBeenCalledWith("chart.png"));
    expect(addImagesMock).toHaveBeenCalledTimes(1);
    const [items] = addImagesMock.mock.calls[0];
    expect(items).toHaveLength(1);
    expect(items[0].name).toBe("chart.png");
    expect(items[0].mime).toBe("image/png");
    expect(items[0].source).toBe("workspace");
    expect(items[0].rel).toBe("chart.png");
    expect(items[0].thumb.startsWith("data:image/png;base64,")).toBe(true);
    // And the file must NOT have been pushed to the text-reference channel.
    expect(addAttachmentsMock).not.toHaveBeenCalled();
  });

  it("insertFile routes image files to pending when model lacks vision", async () => {
    // Task 10 fallback: with supportsVision=false the image can't be seen, so
    // the @ selection degrades to a text reference the agent reads by name.
    mockModel = { ...mockModel, supportsVision: false };
    mockFiles = [{ name: "chart.png", type: "file", path: "chart.png" }];
    render(<Composer />);
    const textarea = screen.getByLabelText("任务输入") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "see @c" } });
    // Even with vision off, the row marker is the same (ComposerFilePicker
    // does not gate on supportsVision — only the routing does).
    const row = await screen.findByRole("option", { name: /chart\.png/ });
    expect(row).toHaveClass("is-image");
    fireEvent.click(row);
    // No vision → no thumbnail fetch, no visual channel push.
    expect(pathToDataUrlMock).not.toHaveBeenCalled();
    expect(addImagesMock).not.toHaveBeenCalled();
    expect(addAttachmentsMock).toHaveBeenCalledWith(["chart.png"]);
  });

  it("insertFile keeps non-image files on the text-reference channel", async () => {
    // Task 10 invariant: only image files bifurcate. A .md file still goes to
    // pending exactly as before, regardless of vision support.
    mockFiles = [{ name: "readme.md", type: "file", path: "readme.md" }];
    render(<Composer />);
    const textarea = screen.getByLabelText("任务输入") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "see @r" } });
    const row = await screen.findByRole("option", { name: "readme.md" });
    expect(row).not.toHaveClass("is-image");
    fireEvent.click(row);
    expect(addAttachmentsMock).toHaveBeenCalledWith(["readme.md"]);
    expect(addImagesMock).not.toHaveBeenCalled();
    expect(pathToDataUrlMock).not.toHaveBeenCalled();
  });
});
