import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import Composer, { collectPastedImages, looksLikeFsPath, toFileRefPath } from "./Composer";
import { useConfigStore } from "../state/config-store";
import { useBackgroundTaskStore } from "../state/background-task-store";
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
const showToastMock = vi.fn();
const setPreviewPathMock = vi.fn();
const openLightboxMock = vi.fn();

vi.mock("../state/chat-store", () => ({
  useChatStore: (selector: (s: any) => any) =>
    selector({
      streaming: mockStreaming,
      send: sendMock,
      pause: pauseMock,
      turns: [],
    }),
}));

// config-store is bridged to the real zustand store so that tests can drive
// state via `useConfigStore.setState(...)` (the import-path setState) and have
// both the Composer's own selectors AND any child component (e.g. ModelPicker
// rendered by T6) see the updates. The selector is routed through the real
// store's getState so writes and reads stay in sync.
vi.mock("../state/config-store", async () => {
  const actual = await vi.importActual<typeof import("../state/config-store")>("../state/config-store");
  const bridged = Object.assign(
    (selector: (s: any) => any) => selector(actual.useConfigStore.getState()),
    {
      getState: actual.useConfigStore.getState,
      setState: actual.useConfigStore.setState,
    },
  );
  return { ...actual, useConfigStore: bridged };
});

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
      showToast: showToastMock,
      setPreviewPath: setPreviewPathMock,
      openLightbox: openLightboxMock,
    }),
}));

vi.mock("../lib/sidecar-client", () => ({ getBaseUrl: vi.fn(async () => "http://test") }));

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
  // Composer calls useAttachmentStore.getState() at send time for `.toWire()`,
  // `.pending`, and `.images`; mirror the zustand-shaped handle (including the
  // same mutable slices the selector exposes) so the production doSend path
  // works under mock. Omitting pending/images made every send-flow test crash
  // with "Cannot read properties of undefined (reading 'map')".
  (selectorFn as any).getState = () => ({
    toWire: () => [],
    pending: mockPending,
    images: mockImages,
  });
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
// listener registration and capture the handler so tests can drive drops.
const { dragDropHandler } = vi.hoisted(() => ({
  dragDropHandler: { current: null as ((ev: any) => void) | null },
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    onDragDropEvent: (handler: any) => {
      dragDropHandler.current = handler;
      return Promise.resolve(() => {});
    },
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

// Explorer-copied file paste falls back to the Rust clipboard command; stub it
// so tests can return synthetic file lists (default: nothing on the clipboard).
const { getClipboardFilePathsMock } = vi.hoisted(() => ({
  getClipboardFilePathsMock: vi.fn(async (): Promise<string[]> => []),
}));
vi.mock("../lib/clipboard", () => ({ getClipboardFilePaths: getClipboardFilePathsMock }));

// External-file authorization registration is a sidecar fetch; stub it (keep the
// real pure `partitionPaths`) so drop/paste tests never hit the network.
const { registerExternalPathsMock } = vi.hoisted(() => ({
  registerExternalPathsMock: vi.fn(async (): Promise<string[]> => []),
}));
vi.mock("../lib/external-paths", async () => {
  const actual = await vi.importActual<typeof import("../lib/external-paths")>("../lib/external-paths");
  return { ...actual, registerExternalPaths: registerExternalPathsMock };
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
    // config-store is bridged to the real zustand store (so ModelPicker, mounted
    // by T6, sees test-driven state). Seed the default model + minimal providers
    // slice; individual tests override via useConfigStore.setState({...}).
    useConfigStore.setState({
      model: mockModel,
      providers: [],
      enabledModels: [],
      switching: false,
    } as any);
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
    // send(msg, wire, images, fileRefs, mode) — no attachments here, so the last
    // three are undefined; mode defaults to the store's workMode ("craft").
    expect(sendMock).toHaveBeenCalledWith("review\n\n请使用 code-review skill", undefined, undefined, undefined, "craft");
  });

  it("sends message with mcp instruction when an mcp server is selected", async () => {
    render(<Composer />);
    const textarea = screen.getByLabelText("任务输入") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "list files /file" } });
    const row = await screen.findByText("filesystem");
    fireEvent.click(row);
    fireEvent.click(screen.getByLabelText("发送"));
    expect(sendMock).toHaveBeenCalledWith("list files\n\n请使用 filesystem MCP工具", undefined, undefined, undefined, "craft");
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
    useConfigStore.setState({ model: mockModel } as any);
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

  it("looksLikeFsPath recognizes drive-letter / UNC paths only", () => {
    expect(looksLikeFsPath("C:\\data\\report.xlsx")).toBe(true);
    expect(looksLikeFsPath("E:/预报分析/降雨.csv")).toBe(true);
    expect(looksLikeFsPath("\\\\nas\\share\\file.txt")).toBe(true);
    expect(looksLikeFsPath("普通文本")).toBe(false);
    expect(looksLikeFsPath("report.xlsx")).toBe(false); // relative → not a paste-ref
  });

  it("toFileRefPath makes inside-workspace paths relative, keeps external absolute", () => {
    expect(toFileRefPath("C:\\ws\\data\\info.csv", "C:\\ws")).toBe("data/info.csv");
    expect(toFileRefPath("C:\\ws\\report.xlsx", "C:\\ws")).toBe("report.xlsx");
    expect(toFileRefPath("D:\\outside\\notes.txt", "C:\\ws")).toBe("D:\\outside\\notes.txt");
    expect(toFileRefPath("data/info.csv", "C:\\ws")).toBe("data/info.csv"); // already relative
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

  it("pastes a copied file's path as a file reference (not raw text)", async () => {
    render(<Composer />);
    const textarea = screen.getByLabelText("任务输入") as HTMLTextAreaElement;
    const clipboardData = {
      items: [],
      getData: (t: string) => (t === "text/plain" ? "C:\\data\\report.xlsx" : ""),
    };
    fireEvent.paste(textarea, { clipboardData });

    // The ref flows through the async attachPaths (which also registers the
    // external file), so await the attachment.
    await waitFor(() => expect(addAttachmentsMock).toHaveBeenCalledWith(["C:\\data\\report.xlsx"]));
    expect(registerExternalPathsMock).toHaveBeenCalledWith(["C:\\data\\report.xlsx"]);
    expect(textarea.value).toBe(""); // path was not inserted as text
  });

  it("adds a non-image File with a path from the clipboard as a reference", async () => {
    render(<Composer />);
    const textarea = screen.getByLabelText("任务输入") as HTMLTextAreaElement;
    const file = Object.assign(new File(["x"], "report.xlsx"), { path: "C:\\data\\report.xlsx" });
    const clipboardData = {
      items: [{ kind: "file", type: "application/vnd.ms-excel", getAsFile: () => file }],
      getData: () => "",
    };
    fireEvent.paste(textarea, { clipboardData });

    await waitFor(() => expect(addAttachmentsMock).toHaveBeenCalledWith(["C:\\data\\report.xlsx"]));
    expect(registerExternalPathsMock).toHaveBeenCalledWith(["C:\\data\\report.xlsx"]);
  });

  it("pastes Explorer-copied files (CF_HDROP) via the Rust command and attaches them", async () => {
    // The Rust command already dedupes the CF_HDROP list before returning.
    getClipboardFilePathsMock.mockResolvedValue(["D:\\clip\\notes.txt"]);
    render(<Composer />);
    const textarea = screen.getByLabelText("任务输入") as HTMLTextAreaElement;
    // WebView exposes only a "Files" type for a CF_HDROP paste: no text, no
    // images, no File.path — so the handler must fall back to the Rust command.
    const clipboardData = {
      items: [],
      getData: () => "",
      types: ["Files"],
    };
    fireEvent.paste(textarea, { clipboardData });

    await waitFor(() => expect(getClipboardFilePathsMock).toHaveBeenCalled());
    await waitFor(() => expect(addAttachmentsMock).toHaveBeenCalledWith(["D:\\clip\\notes.txt"]));
    expect(registerExternalPathsMock).toHaveBeenCalledWith(["D:\\clip\\notes.txt"]);
  });

  it("leaves a path+prose mixed paste to the browser instead of swallowing the prose", async () => {
    render(<Composer />);
    const textarea = screen.getByLabelText("任务输入") as HTMLTextAreaElement;
    const clipboardData = {
      items: [],
      getData: (t: string) => (t === "text/plain" ? "C:\\data\\report.xlsx\n请分析这份报告" : ""),
      types: ["text/plain"],
    };
    fireEvent.paste(textarea, { clipboardData });

    await new Promise((r) => setTimeout(r, 10));
    expect(getClipboardFilePathsMock).not.toHaveBeenCalled();
    expect(addAttachmentsMock).not.toHaveBeenCalled();
    expect(registerExternalPathsMock).not.toHaveBeenCalled();
  });

  it("does not invoke Rust for a plain-text paste and leaves it to the browser", async () => {
    render(<Composer />);
    const textarea = screen.getByLabelText("任务输入") as HTMLTextAreaElement;
    const clipboardData = {
      items: [],
      getData: (t: string) => (t === "text/plain" ? "hello world" : ""),
      types: ["text/plain"],
    };
    fireEvent.paste(textarea, { clipboardData });

    await new Promise((r) => setTimeout(r, 10));
    expect(getClipboardFilePathsMock).not.toHaveBeenCalled();
    expect(addAttachmentsMock).not.toHaveBeenCalled();
    expect(registerExternalPathsMock).not.toHaveBeenCalled();
  });

  it("drops a non-image file as a workspace-relative reference", async () => {
    mockCurrent = { path: "C:\\ws", name: "ws" };
    render(<Composer />);
    await dragDropHandler.current?.({
      payload: { type: "drop", paths: ["C:\\ws\\data\\info.csv"] },
    });

    expect(addAttachmentsMock).toHaveBeenCalledWith(["data/info.csv"]);
    expect(registerExternalPathsMock).not.toHaveBeenCalled();
  });

  it("drops an external (non-workspace) file as an absolute reference and registers it", async () => {
    render(<Composer />);
    await dragDropHandler.current?.({
      payload: { type: "drop", paths: ["D:\\outside\\notes.txt"] },
    });

    expect(addAttachmentsMock).toHaveBeenCalledWith(["D:\\outside\\notes.txt"]);
    expect(registerExternalPathsMock).toHaveBeenCalledWith(["D:\\outside\\notes.txt"]);
  });

  it("renders an 外部 badge on external (absolute) attachment chips", () => {
    mockPending = ["D:\\outside\\notes.txt", "data/info.csv"];
    render(<Composer />);
    const badges = screen.getAllByText("外部");
    expect(badges).toHaveLength(1);
    expect(screen.getByText("notes.txt").closest(".attachment-pill")).not.toBeNull();
  });

  it("still routes dropped images to the visual channel", async () => {
    render(<Composer />);
    await dragDropHandler.current?.({
      payload: { type: "drop", paths: ["C:\\ws\\chart.png"] },
    });

    expect(addImagesMock).toHaveBeenCalled();
    expect(addAttachmentsMock).not.toHaveBeenCalled();
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

  it("insertFile blocks image files and toasts when the model lacks vision", async () => {
    // Fix: on a non-vision model, @-selecting an image must NOT degrade to a
    // text reference — that handed the agent a filename it couldn't actually
    // see and invited the "智能体说它看了" hallucination. Block it and surface
    // a toast instead. Non-image files still go to the text-reference channel.
    mockModel = { ...mockModel, supportsVision: false };
    useConfigStore.setState({ model: mockModel } as any);
    mockFiles = [{ name: "chart.png", type: "file", path: "chart.png" }];
    render(<Composer />);
    const textarea = screen.getByLabelText("任务输入") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "see @c" } });
    // Even with vision off, the row marker is the same (ComposerFilePicker
    // does not gate on supportsVision — only the routing does).
    const row = await screen.findByRole("option", { name: /chart\.png/ });
    expect(row).toHaveClass("is-image");
    fireEvent.click(row);
    // No vision → image blocked: not added to either channel, and a toast
    // tells the user why (so they don't think the model saw the image).
    expect(pathToDataUrlMock).not.toHaveBeenCalled();
    expect(addImagesMock).not.toHaveBeenCalled();
    expect(addAttachmentsMock).not.toHaveBeenCalled();
    expect(showToastMock).toHaveBeenCalledWith(expect.stringContaining("不支持图片"));
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

  it("clicking the model pill opens the model picker", async () => {
    // T6: the composer model pill becomes a <button> that mounts ModelPicker.
    // Drive the real config-store (the bridge routes reads to its getState) so
    // the picker sees a populated catalog, then assert the listbox appears.
    useConfigStore.setState({
      model: { provider: "qwen", model: "qwen3.7-plus" } as any,
      enabledModels: [{ provider: "qwen", model: "qwen3.7-plus" }],
      providers: [
        {
          id: "qwen",
          name: "通义千问",
          baseURL: "",
          apiKeyPresent: true,
          models: [{ name: "qwen3.7-plus", maxTokens: 131072, supportsVision: true }],
        },
      ],
      switching: false,
    } as any);
    render(<Composer />);
    const pill = screen.getByRole("button", { name: /qwen3\.7-plus/ });
    fireEvent.click(pill);
    expect(await screen.findByRole("listbox", { name: "选择模型" })).toBeInTheDocument();
  });

  it("renders pending file chips below the input; clicking one opens the preview panel", () => {
    mockPending = ["notes/report.txt"];
    render(<Composer />);
    // The chip shows the basename; the full path is the preview target.
    expect(screen.getByText("report.txt")).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("预览 notes/report.txt"));
    expect(setPreviewPathMock).toHaveBeenCalledWith("notes/report.txt");
  });

  it("clicking an image thumb opens the lightbox with its data URL", () => {
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
    fireEvent.click(screen.getByLabelText("预览 shot.png"));
    expect(openLightboxMock).toHaveBeenCalledWith({
      src: "data:image/png;base64,AAAA",
      name: "shot.png",
    });
  });

  it("renders the three work-mode buttons with craft active by default", () => {
    useConfigStore.setState({ workMode: "craft" } as any);
    render(<Composer />);
    expect(screen.getByRole("button", { name: "执行" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "问答" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: "计划" })).toHaveAttribute("aria-pressed", "false");
  });

  it("clicking a mode button saves it and switches the active state", async () => {
    useConfigStore.setState({ workMode: "craft" } as any);
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true, work_mode: { mode: "ask" } }), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);
    const { rerender } = render(<Composer />);

    fireEvent.click(screen.getByRole("button", { name: "问答" }));

    await waitFor(() => expect(useConfigStore.getState().workMode).toBe("ask"));
    // The bridged config-store mock does not subscribe to store changes, so
    // force a re-render to confirm the control reflects the saved mode.
    rerender(<Composer />);
    expect(screen.getByRole("button", { name: "问答" })).toHaveAttribute("aria-pressed", "true");
    vi.unstubAllGlobals();
  });

  it("doSend passes the current work mode as the 5th send arg", () => {
    useConfigStore.setState({ workMode: "plan" } as any);
    render(<Composer />);
    const textarea = screen.getByLabelText("任务输入") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "做一个水文报告" } });
    fireEvent.click(screen.getByLabelText("发送"));

    expect(sendMock).toHaveBeenCalledWith("做一个水文报告", undefined, undefined, undefined, "plan");
  });

  it("permission pill cycles to the next mode without navigating to settings", async () => {
    useConfigStore.setState({ permissionMode: "trust-once" } as any);
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true, permissions: { mode: "always-ask" } }), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);
    render(<Composer />);

    fireEvent.click(screen.getByRole("button", { name: /授权：首次询问/ }));

    await waitFor(() => expect(useConfigStore.getState().permissionMode).toBe("always-ask"));
    expect(setViewMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("permission pill shows the always-trust confirmation before switching", async () => {
    useConfigStore.setState({ permissionMode: "always-ask" } as any);
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true, permissions: { mode: "always-trust" } }), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);
    render(<Composer />);

    fireEvent.click(screen.getByRole("button", { name: /授权：每次都问/ }));

    // 确认框先弹出，模式尚未切换
    expect(screen.getByText(/切换到「完全信任」/)).toBeInTheDocument();
    expect(useConfigStore.getState().permissionMode).toBe("always-ask");

    fireEvent.click(screen.getByRole("button", { name: /确认切换/ }));
    await waitFor(() => expect(useConfigStore.getState().permissionMode).toBe("always-trust"));
    vi.unstubAllGlobals();
  });

  it("shows the shell indicator with running background-task count and opens the panel", () => {
    useBackgroundTaskStore.setState({
      tasks: [
        { task_id: "t1", status: "running", command: "ping", exit_code: null, started_at: 1, finished_at: null, tail: "", stdout_path: "" },
        { task_id: "t2", status: "running", command: "sleep", exit_code: null, started_at: 1, finished_at: null, tail: "", stdout_path: "" },
      ],
      panelOpen: false,
    });
    render(<Composer />);
    expect(screen.getByText("shell (2)")).toBeInTheDocument();
    fireEvent.click(screen.getByText("shell (2)"));
    expect(useBackgroundTaskStore.getState().panelOpen).toBe(true);
    useBackgroundTaskStore.setState({ tasks: [], panelOpen: false });
  });

  it("hides the shell indicator when no background task is running", () => {
    useBackgroundTaskStore.setState({
      tasks: [{ task_id: "t1", status: "completed", command: "ls", exit_code: 0, started_at: 1, finished_at: 1, tail: "", stdout_path: "" }],
      panelOpen: false,
    });
    render(<Composer />);
    expect(screen.queryByText(/shell/)).not.toBeInTheDocument();
    useBackgroundTaskStore.setState({ tasks: [], panelOpen: false });
  });
});
