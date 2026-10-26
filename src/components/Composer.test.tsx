import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import Composer, { collectPastedImages, looksLikeFsPath, toFileRefPath } from "./Composer";
import { useConfigStore } from "../state/config-store";
import { useBackgroundTaskStore } from "../state/background-task-store";
import type { FileEntry } from "../state/workspace-store";
import { WelcomeStarters } from "./WelcomeView";
import { COMPOSER_DRAFT_EVENT } from "./composer/draft-event";

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
  useChatStore: Object.assign((selector: (s: any) => any) =>
    selector({
      streaming: mockStreaming,
      send: sendMock,
      pause: pauseMock,
      turns: [],
    }), { getState: () => ({ conversationId: "conv-test" }) }),
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

vi.mock("../state/ui-store", () => {
  const getState = () => ({
    setView: setViewMock,
    showToast: showToastMock,
    setPreviewPath: setPreviewPathMock,
    openLightbox: openLightboxMock,
    openInspector: vi.fn(),
    closeInspector: vi.fn(),
    inspectorTab: "files",
  });
  return {
    useUiStore: Object.assign((selector: (s: any) => any) => selector(getState()), { getState }),
  };
});

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
    mockRecent = [{ path: "/ws2", name: "ws2" }];
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

  it.each([
    { isComposing: true },
    { keyCode: 229 },
  ])("does not send Enter used for native IME confirmation: %o", (nativeFlags) => {
    render(<Composer />);
    const input = screen.getByLabelText("任务输入");
    fireEvent.change(input, { target: { value: "整理会议记录" } });
    fireEvent.keyDown(input, { key: "Enter", ...nativeFlags });
    expect(sendMock).not.toHaveBeenCalled();
    expect(input).toHaveValue("整理会议记录");
  });

  it("guards composition state and sends normal Enter after composition ends", () => {
    render(<Composer />);
    const input = screen.getByLabelText("任务输入");
    fireEvent.change(input, { target: { value: "整理会议记录" } });
    fireEvent.compositionStart(input);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(sendMock).not.toHaveBeenCalled();
    fireEvent.compositionEnd(input);
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(sendMock).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it("does not let IME confirmation select a slash item through its window listener", async () => {
    render(<Composer />);
    const input = screen.getByLabelText("任务输入");
    fireEvent.change(input, { target: { value: "/code" } });
    await screen.findByText("code-review");
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    expect(input).toHaveValue("/code");
    expect(screen.getByText("Skills")).toBeInTheDocument();
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("preserves the composer node, draft and attachments across empty-state layout changes", () => {
    mockPending = ["notes.txt"];
    const Stage = ({ empty }: { empty: boolean }) => (
      <div className={`chat-stage${empty ? " chat-stage-empty" : ""}`}>
        <div>{empty ? "欢迎" : "消息内容"}</div>
        <Composer />
        {empty && <WelcomeStarters />}
      </div>
    );
    const { rerender } = render(<Stage empty />);
    const input = screen.getByLabelText("任务输入");
    fireEvent.change(input, { target: { value: "保留这份草稿" } });
    for (const empty of [false, true]) {
      rerender(<Stage empty={empty} />);
      expect(screen.getByLabelText("任务输入")).toBe(input);
      expect(input).toHaveValue("保留这份草稿");
      expect(screen.getByLabelText("移除 notes.txt")).toBeInTheDocument();
    }
  });

  it("keeps an existing unsent draft when choosing a welcome starter", () => {
    render(<><WelcomeStarters /><Composer /></>);
    const input = screen.getByLabelText("任务输入");
    fireEvent.change(input, { target: { value: "会议记录在附件里" } });
    fireEvent.click(screen.getByRole("button", { name: /整理一份文档/ }));
    expect(input).toHaveValue("会议记录在附件里\n\n请帮我整理这份文档，提炼核心观点、关键结论和待办事项。");
    expect(input).toHaveFocus();
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("fills and focuses the draft from a welcome starter without sending", () => {
    render(<><WelcomeStarters /><Composer /></>);
    fireEvent.click(screen.getByRole("button", { name: /整理一份文档/ }));
    const input = screen.getByLabelText("任务输入");
    expect(input).toHaveValue("请帮我整理这份文档，提炼核心观点、关键结论和待办事项。");
    expect(input).toHaveFocus();
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("closes an open picker when a starter fills the draft and ignores malformed events", async () => {
    render(<><WelcomeStarters /><Composer /></>);
    const input = screen.getByLabelText("任务输入");
    fireEvent.change(input, { target: { value: "/" } });
    await screen.findByText("Skills");
    fireEvent.click(screen.getByRole("button", { name: /推进一个计划/ }));
    expect(screen.queryByText("Skills")).not.toBeInTheDocument();
    const draft = (input as HTMLTextAreaElement).value;
    fireEvent(window, new CustomEvent(COMPOSER_DRAFT_EVENT, { detail: { text: 123 } }));
    expect(input).toHaveValue(draft);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("shows file and image attachments before the editable draft", () => {
    mockPending = ["notes.txt"];
    mockImages = [{ id: "im", name: "photo.png", thumb: "data:image/png;base64,AA", mime: "image/png", source: "clipboard" }];
    render(<Composer />);
    const tray = screen.getByRole("group", { name: "待发送附件" });
    const input = screen.getByLabelText("任务输入");
    expect(tray.compareDocumentPosition(input) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(screen.getByLabelText("移除 notes.txt"));
    expect(removeAttachmentMock).toHaveBeenCalledWith("notes.txt");
  });

  it("keeps append and pause available while streaming", () => {
    mockStreaming = true;
    render(<Composer />);
    const input = screen.getByLabelText("任务输入");
    expect(input).toHaveAttribute("placeholder", "追加指令到当前任务… @ 引用文件 · / 选择工具");
    fireEvent.change(input, { target: { value: "请补充结论" } });
    fireEvent.click(screen.getByLabelText("发送"));
    expect(sendMock).toHaveBeenCalledWith("请补充结论", undefined, undefined, undefined, expect.any(String));
    fireEvent.click(screen.getByLabelText("暂停"));
    expect(pauseMock).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "工作模式" })).toBeDisabled();
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

  it("opens the file picker and attaches ordinary files without vision support", async () => {
    mockModel = { ...mockModel, supportsVision: false };
    useConfigStore.setState({ model: mockModel } as any);
    render(<Composer />);
    fireEvent.click(screen.getByLabelText("引用工作区文件"));
    fireEvent.click(await screen.findByRole("checkbox", { name: "readme.md" }));
    fireEvent.click(screen.getByRole("button", { name: "确认" }));
    await waitFor(() => expect(addAttachmentsMock).toHaveBeenCalledWith(["readme.md"]));
    expect(addImagesMock).not.toHaveBeenCalled();
  });

  it("rejects unsupported images but keeps ordinary files in a mixed selection", async () => {
    mockModel = { ...mockModel, supportsVision: false };
    useConfigStore.setState({ model: mockModel } as any);
    mockFiles.push({ name: "chart.png", type: "file", path: "chart.png" });
    render(<Composer />);
    fireEvent.click(screen.getByLabelText("引用工作区文件"));
    fireEvent.click(await screen.findByRole("checkbox", { name: "chart.png" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "readme.md" }));
    fireEvent.click(screen.getByRole("button", { name: "确认" }));
    await waitFor(() => expect(showToastMock).toHaveBeenCalledWith(expect.stringContaining("不支持图片")));
    expect(addAttachmentsMock).toHaveBeenCalledExactlyOnceWith(["readme.md"]);
    expect(addImagesMock).not.toHaveBeenCalled();
    expect(pathToDataUrlMock).not.toHaveBeenCalled();
  });

  it.each(["workspace", "streaming"])("disables file selection while missing %s availability", (reason) => {
    if (reason === "workspace") mockCurrent = null;
    else mockStreaming = true;
    render(<Composer />);
    const button = screen.getByLabelText("引用工作区文件");
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("title", reason === "workspace" ? "请先打开一个工作区" : "任务运行中，暂时无法添加文件");
  });

  it("places the unframed workspace selector before and outside the form", () => {
    const { container } = render(<Composer />);
    const select = screen.getByRole("button", { name: "工作区" });
    const form = container.querySelector("form")!;
    expect(select.closest("form, .fm-composer-meta")).toBeNull();
    expect(select.closest(".fm-workspace-row")).not.toBeNull();
    expect(select.compareDocumentPosition(form) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("deduplicates the current workspace in recent options", () => {
    mockRecent = [mockCurrent!, { path: "/ws2", name: "ws2" }];
    render(<Composer />);
    fireEvent.click(screen.getByRole("button", { name: "工作区" }));
    expect(screen.getAllByRole("option", { name: "ws" })).toHaveLength(1);
  });

  it("keeps workspace selection available without a current workspace", () => {
    mockCurrent = null;
    render(<Composer />);
    const select = screen.getByRole("button", { name: "工作区" });
    expect(select).toHaveTextContent("未选择");
    expect(select).not.toBeDisabled();
    fireEvent.click(select);
    fireEvent.click(screen.getByRole("button", { name: "打开其他工作区…" }));
    expect(pickAndOpenMock).toHaveBeenCalledOnce();
  });

  it("switches recent workspaces and dispatches the folder picker", () => {
    render(<Composer />);
    const select = screen.getByRole("button", { name: "工作区" });
    fireEvent.click(select);
    fireEvent.click(screen.getByRole("option", { name: "ws2" }));
    expect(openPathMock).toHaveBeenCalledWith("/ws2");
    expect(setViewMock).toHaveBeenCalledWith("chat");
    fireEvent.click(select);
    fireEvent.click(screen.getByRole("button", { name: "打开其他工作区…" }));
    expect(pickAndOpenMock).toHaveBeenCalledOnce();
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
    expect(screen.getByText("notes.txt").closest(".fm-file-card")).not.toBeNull();
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
    const pill = screen.getByRole("button", { name: "选择模型" });
    expect(pill.querySelector("svg")).toBeNull();
    expect(pill).not.toHaveTextContent("▾");
    const mode = screen.getByRole("button", { name: "工作模式" });
    expect(mode.parentElement?.querySelector("svg")).toBeNull();
    fireEvent.click(pill);
    expect(await screen.findByRole("listbox", { name: "选择模型" })).toBeInTheDocument();
  });

  it("switches model with the active conversation binding and returns focus", async () => {
    const original = useConfigStore.getState().switchActive;
    const switchActive = vi.fn().mockResolvedValue(true);
    useConfigStore.setState({ switchActive, switching: false, enabledModels: [{ provider: "qwen", model: "qwen-test" }], providers: [{ id: "qwen", name: "Qwen", apiKeyPresent: true, models: [{ name: "qwen-test" }] }] } as any);
    render(<Composer />);
    const trigger = screen.getByRole("button", { name: "选择模型" });
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("option", { name: "qwen-test" }));
    expect(switchActive).toHaveBeenCalledWith("qwen", "qwen-test", "conv-test");
    expect(trigger).toHaveFocus();
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    await waitFor(() => expect(switchActive).toHaveResolved());
    useConfigStore.setState({ switchActive: original });
  });

  it("keeps only one portal menu open and preserves drafts and attachments", () => {
    mockPending = ["notes/report.txt"];
    render(<Composer />);
    const input = screen.getByLabelText("任务输入");
    fireEvent.change(input, { target: { value: "保留草稿" } });
    fireEvent.click(screen.getByRole("button", { name: "工作模式" }));
    expect(screen.getByRole("listbox", { name: "选择工作模式" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "工作区" }));
    expect(screen.queryByRole("listbox", { name: "选择工作模式" })).not.toBeInTheDocument();
    expect(screen.getByRole("listbox", { name: "选择工作区" }).closest(".fm-composer-wrap")).toBeNull();
    expect(input).toHaveValue("保留草稿");
    expect(screen.getByText("report.txt")).toBeInTheDocument();
  });

  it("supports mode keyboard navigation, Escape focus and outside dismissal", () => {
    render(<Composer />);
    const trigger = screen.getByRole("button", { name: "工作模式" });
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    const list = screen.getByRole("listbox", { name: "选择工作模式" });
    expect(list).toHaveFocus();
    fireEvent.keyDown(list, { key: "End" });
    expect(list.getAttribute("aria-activedescendant")).toBe(screen.getByRole("option", { name: "计划" }).id);
    fireEvent.keyDown(list, { key: "Home" });
    expect(list.getAttribute("aria-activedescendant")).toBe(screen.getByRole("option", { name: "执行" }).id);
    fireEvent.keyDown(list, { key: "Escape" });
    expect(trigger).toHaveFocus();
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    fireEvent.click(trigger);
    const input = screen.getByLabelText("任务输入");
    input.focus();
    fireEvent.mouseDown(input);
    expect(input).toHaveFocus();
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("keeps workspace footer outside listbox and Tabs back into toolbar order", () => {
    render(<Composer />);
    fireEvent.click(screen.getByRole("button", { name: "工作区" }));
    const footer = screen.getByRole("button", { name: "打开其他工作区…" });
    expect(footer.closest('[role="listbox"]')).toBeNull();
    footer.focus();
    fireEvent.keyDown(footer, { key: "Tab" });
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(screen.getByLabelText("任务输入")).toHaveFocus();
  });

  it("keeps reference hint inside input and permission in toolbar without empty meta", () => {
    const { container } = render(<Composer />);
    expect(screen.getByLabelText("任务输入")).toHaveAttribute("placeholder", "描述你想完成的任务… @ 引用文件 · / 选择工具");
    expect(screen.queryByText("@ 引用文件 · / 选择工具")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /授权：/ }).closest(".fm-composer-toolbar")).not.toBeNull();
    expect(screen.getByRole("button", { name: /授权：/ }).querySelector("svg")).toBeNull();
    expect(screen.getByRole("button", { name: "工作区" }).querySelector("svg")).toBeNull();
    expect(container.querySelector(".fm-composer-meta")).toBeNull();
  });

  it("renders pending file chips above the input; clicking one opens the preview panel", () => {
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

  it("renders a compact work-mode selector with craft active by default", () => {
    useConfigStore.setState({ workMode: "craft" } as any);
    render(<Composer />);
    expect(screen.getByRole("button", { name: "工作模式" })).toHaveTextContent("执行");
    fireEvent.click(screen.getByRole("button", { name: "工作模式" }));
    for (const name of ["执行", "问答", "计划"]) expect(screen.getByRole("option", { name })).toBeInTheDocument();
  });

  it("clicking a mode button saves it and switches the active state", async () => {
    useConfigStore.setState({ workMode: "craft" } as any);
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true, work_mode: { mode: "ask" } }), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);
    const { rerender } = render(<Composer />);

    fireEvent.click(screen.getByRole("button", { name: "工作模式" }));
    fireEvent.click(screen.getByRole("option", { name: "问答" }));

    await waitFor(() => expect(useConfigStore.getState().workMode).toBe("ask"));
    // The bridged config-store mock does not subscribe to store changes, so
    // force a re-render to confirm the control reflects the saved mode.
    rerender(<Composer />);
    expect(screen.getByRole("button", { name: "工作模式" })).toHaveTextContent("问答");
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

  it("permission menu lists every mode and saves the chosen one without navigating to settings", async () => {
    useConfigStore.setState({ permissionMode: "trust-once" } as any);
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true, permissions: { mode: "always-ask" } }), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);
    render(<Composer />);

    fireEvent.click(screen.getByRole("button", { name: /授权：首次询问/ }));
    for (const name of ["首次询问", "每次都问", "完全信任"]) {
      expect(screen.getByRole("option", { name })).toBeInTheDocument();
    }
    expect(screen.getByRole("option", { name: "首次询问" })).toHaveAttribute("aria-selected", "true");

    fireEvent.click(screen.getByRole("option", { name: "每次都问" }));

    await waitFor(() => expect(useConfigStore.getState().permissionMode).toBe("always-ask"));
    expect(screen.queryByRole("listbox", { name: "选择授权模式" })).not.toBeInTheDocument();
    expect(setViewMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("choosing always-trust from the permission menu shows the confirmation before switching", async () => {
    useConfigStore.setState({ permissionMode: "always-ask" } as any);
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true, permissions: { mode: "always-trust" } }), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);
    render(<Composer />);

    fireEvent.click(screen.getByRole("button", { name: /授权：每次都问/ }));
    fireEvent.click(screen.getByRole("option", { name: "完全信任" }));

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
