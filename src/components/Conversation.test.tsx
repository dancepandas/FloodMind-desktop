import { describe, it, expect, afterEach, beforeAll, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import Conversation from "./Conversation";
import { useChatStore, _resetBlockIdsForTest, type ArtifactBlock, type Block } from "../state/chat-store";
import { useUiStore } from "../state/ui-store";
import { openFileInSystem } from "../lib/open-file";

vi.mock("../lib/open-file", () => ({
  openFileInSystem: vi.fn(() => Promise.resolve()),
}));
// Resume streams over /api/chat/resume; stub it so banner clicks don't hit fetch.
vi.mock("../lib/chat-stream", () => ({
  streamChat: vi.fn(),
  streamResume: vi.fn(async function* () {}),
}));

// jsdom doesn't implement Element.scrollIntoView; the Conversation mounts and
// runs its auto-scroll effect on every test, so stub it before any render.
beforeAll(() => {
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = function () {};
  }
});

afterEach(() => {
  cleanup();
  // Reset the store + id counter between tests so seeding is order-independent.
  useChatStore.setState({ turns: [], streaming: false, resumableCheckpoint: null });
  useUiStore.setState({ previewPath: null, lightboxImage: null });
  _resetBlockIdsForTest();
  vi.clearAllMocks();
});

function artifact(id: string, overrides: Partial<ArtifactBlock> = {}): ArtifactBlock {
  return {
    id,
    kind: "artifact",
    artKind: "file",
    name: `${id}.txt`,
    path: `C:\\output\\${id}.txt`,
    exists: true,
    source: "declared",
    ...overrides,
  };
}

function seedAssistant(blocks: Block[], done = true, streaming = false) {
  useChatStore.setState({
    turns: [{ id: "a1", role: "assistant", blocks, usage: null, done }],
    streaming,
  });
}

describe("Conversation", () => {
  it("renders image thumbnails on a user turn that carried images", () => {
    useChatStore.setState({
      turns: [
        {
          id: "u1",
          role: "user",
          content: "看图",
          images: [{ name: "chart.png", thumb: "data:image/png;base64,AAAA" }],
        },
      ] as any,
    });
    render(<Conversation />);
    const imgs = screen.getAllByRole("img");
    expect(imgs.some((i) => (i as HTMLImageElement).src.startsWith("data:image/png"))).toBe(true);
  });

  it("renders no thumbnails on a user turn without images", () => {
    useChatStore.setState({
      turns: [{ id: "u2", role: "user", content: "纯文本" }] as any,
    });
    render(<Conversation />);
    // No image thumbnails should be present on an image-less user bubble.
    expect(screen.queryAllByRole("img")).toHaveLength(0);
  });

  it("renders a referenced file as a chip that opens the preview panel", () => {
    useChatStore.setState({
      turns: [
        {
          id: "u3",
          role: "user",
          content: "看下这个",
          attachments: [{ path: "notes/report.txt", name: "report.txt" }],
        },
      ] as any,
    });
    render(<Conversation />);
    const chip = screen.getByText("report.txt").closest("button")!;
    expect(chip).toBeInTheDocument();
    fireEvent.click(chip);
    // Clicking the file chip routes to the right-side PreviewPanel.
    expect(useUiStore.getState().previewPath).toBe("notes/report.txt");
  });

  it("does not render a final artifact group when a completed turn has no eligible artifacts", () => {
    seedAssistant([{ id: "final", kind: "text", content: "完成", final: true }]);
    render(<Conversation />);
    expect(screen.queryByRole("button", { name: /最终产物/ })).not.toBeInTheDocument();
  });

  it("groups final and historical artifacts while excluding final false artifacts", () => {
    seedAssistant([
      { id: "work", kind: "thinking", content: "处理中" },
      artifact("declared", { final: true }),
      artifact("historical", { final: undefined }),
      artifact("temporary", { final: false }),
      { id: "final", kind: "text", content: "完成", final: true },
    ]);
    render(<Conversation />);

    const summary = screen.getByRole("button", { name: /最终产物.*2 个/ });
    expect(summary).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(summary);
    expect(screen.getByText("declared.txt")).toBeInTheDocument();
    expect(screen.getByText("historical.txt")).toBeInTheDocument();
    expect(screen.queryByText("temporary.txt")).not.toBeInTheDocument();
  });

  it("hides the process and shows one artifact group on a completed turn", () => {
    seedAssistant([
      { id: "work", kind: "thinking", content: "处理中" },
      artifact("report"),
      { id: "final", kind: "text", content: "完成", final: true },
    ]);
    render(<Conversation />);
    // 完成态默认不渲染思维链
    expect(screen.queryByText("处理中")).not.toBeInTheDocument();
    // 只展示一个最终产物组
    fireEvent.click(screen.getByRole("button", { name: /最终产物/ }));
    expect(screen.getAllByText("report.txt")).toHaveLength(1);
  });

  it("completed turn keeps a collapsed 已用过程 trace that expands on click", () => {
    seedAssistant([
      { id: "t", kind: "thinking", content: "推理过程" },
      { id: "tool", kind: "tool", call_id: "c1", tool_name: "Read", status: "completed", input: "a.txt" },
      { id: "final", kind: "text", content: "完成", final: true },
    ]);
    render(<Conversation />);
    // 默认折叠：不渲染过程块内容，但有「已用过程」入口
    expect(screen.getByText("已用过程")).toBeInTheDocument();
    expect(screen.queryByText("推理过程")).not.toBeInTheDocument();
    // 点击展开可复盘：工具名可见，思考块以折叠 chip 呈现（内容需再点开）
    fireEvent.click(screen.getByText("已用过程"));
    expect(screen.getByText("Read")).toBeInTheDocument();
    expect(screen.getByText("思考过程")).toBeInTheDocument();
    expect(screen.queryByText("推理过程")).not.toBeInTheDocument();
  });

  it("routes artifact preview and folder actions through existing integrations", () => {
    seedAssistant([
      artifact("report", { path: "C:\\deliverables\\report.txt" }),
      { id: "final", kind: "text", content: "完成", final: true },
    ]);
    render(<Conversation />);

    fireEvent.click(screen.getByRole("button", { name: /最终产物/ }));
    fireEvent.click(screen.getByRole("button", { name: /report\.txt.*预览/ }));
    expect(useUiStore.getState().previewPath).toBe("C:\\deliverables\\report.txt");

    fireEvent.click(screen.getByRole("button", { name: "打开所在文件夹" }));
    expect(openFileInSystem).toHaveBeenCalledWith("C:\\deliverables");
  });

  it("does not render artifacts during execution (they appear on completion)", () => {
    seedAssistant([artifact("streaming", { final: false })], false, true);
    render(<Conversation />);
    // 执行中只显示动态状态行，产物在完成态才出现
    expect(screen.queryByText("streaming.txt")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /最终产物/ })).not.toBeInTheDocument();
  });

  it("shows 正在思考 status while reasoning and expands the current thinking on click", () => {
    seedAssistant(
      [{ id: "t", kind: "thinking", content: "先算一下" }],
      false,
      true,
    );
    render(<Conversation />);
    // 执行中：当前步骤动态指示 = 正在思考，默认不显示思考内容
    expect(screen.getByText(/正在思考/)).toBeInTheDocument();
    expect(screen.queryByText("先算一下")).not.toBeInTheDocument();
    // 点击展开当前思考内容
    fireEvent.click(screen.getByText(/正在思考/));
    expect(screen.getByText("先算一下")).toBeInTheDocument();
  });

  it("shows 正在调用工具 status and expands tool name + truncated params on click", () => {
    seedAssistant(
      [{ id: "tool", kind: "tool", call_id: "c1", tool_name: "Read", status: "running", input: "读取 E:\\very\\long\\path\\file.txt" }],
      false,
      true,
    );
    render(<Conversation />);
    expect(screen.getByText(/正在调用/)).toBeInTheDocument();
    // 默认不显示工具名
    expect(screen.queryByText("Read")).not.toBeInTheDocument();
    // 点击展开工具名 + 参数
    fireEvent.click(screen.getByText(/正在调用/));
    expect(screen.getByText("Read")).toBeInTheDocument();
  });

  it("shows 正在生成回答 status while the model writes", () => {
    seedAssistant([{ id: "a", kind: "text", content: "答案" }], false, true);
    render(<Conversation />);
    expect(screen.getByText(/正在生成回答/)).toBeInTheDocument();
    expect(screen.getByText("答案")).toBeInTheDocument();
  });

  it("during execution shows only the last text block, intermediate hidden", () => {
    seedAssistant(
      [
        { id: "mid", kind: "text", content: "中间回答", final: false },
        { id: "tool", kind: "tool", call_id: "c1", tool_name: "Read", status: "running", input: "a.txt" },
        { id: "cur", kind: "text", content: "正在生成的答案", final: false },
      ],
      false,
      true,
    );
    render(<Conversation />);
    // 只流式展示最后一个 text 块；中间回答不占对话流（追加形式消除）
    expect(screen.getByText("正在生成的答案")).toBeInTheDocument();
    expect(screen.queryByText("中间回答")).not.toBeInTheDocument();
  });

  it("folds intermediate answers into the 已用过程 trace on completion", () => {
    seedAssistant([
      { id: "mid", kind: "text", content: "我先查一下资料", final: false },
      { id: "final", kind: "text", content: "最终结论", final: true },
    ]);
    render(<Conversation />);
    // 完成态：只显示最终回答；中间 text 默认不可见
    expect(screen.getByText("最终结论")).toBeInTheDocument();
    expect(screen.queryByText("我先查一下资料")).not.toBeInTheDocument();
    // 展开「已用过程」可复盘中间回答（折叠摘要）
    fireEvent.click(screen.getByText("已用过程"));
    expect(screen.getByText("我先查一下资料")).toBeInTheDocument();
  });

  it("shows partial answer + 已停止 for an aborted completed turn", () => {
    seedAssistant(
      [
        { id: "t", kind: "thinking", content: "思考" },
        { id: "partial", kind: "text", content: "写了一半的回答", final: false },
      ],
      true,
      false,
    );
    render(<Conversation />);
    expect(screen.getByText("已停止")).toBeInTheDocument();
    expect(screen.getByText("写了一半的回答")).toBeInTheDocument();
  });

  it("shows 已停止 for an aborted (stopped) turn", () => {
    seedAssistant([{ id: "t", kind: "thinking", content: "思考" }], false, false);
    render(<Conversation />);
    expect(screen.getByText("已停止")).toBeInTheDocument();
  });

  it("renders a plan-confirm bar on a completed plan-mode turn", () => {
    useChatStore.setState({
      turns: [{
        id: "a1", role: "assistant",
        blocks: [{ id: "b1", kind: "text", content: "计划：…", final: true }],
        usage: null, done: true,
        plan: { awaiting: true, originalText: "生成报告" },
      }],
      streaming: false,
    });
    render(<Conversation />);
    expect(screen.getByText("已生成计划，请选择：")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "执行" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "补充" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "讨论" })).toBeInTheDocument();
  });

  it("discussing a plan proposal dismisses the confirm bar", () => {
    useChatStore.setState({
      turns: [{
        id: "a1", role: "assistant",
        blocks: [{ id: "b1", kind: "text", content: "计划：…", final: true }],
        usage: null, done: true,
        plan: { awaiting: true, originalText: "生成报告" },
      }],
      streaming: false,
    });
    render(<Conversation />);
    fireEvent.click(screen.getByRole("button", { name: "讨论" }));
    expect(useChatStore.getState().turns[0]).toMatchObject({
      plan: { awaiting: false },
    });
    expect(screen.queryByText("已生成计划，请选择：")).not.toBeInTheDocument();
  });

  it("shows a resume banner for an interrupted run and resumes on click", () => {
    seedAssistant([{ id: "f", kind: "text", content: "之前完成", final: true }]);
    useChatStore.setState({
      resumableCheckpoint: { checkpoint_id: "cp-1", status: "running", iteration: 3, created_at: "t" },
    });
    render(<Conversation />);

    expect(screen.getByText(/未完成的任务/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "恢复执行" }));
    // resume() consumes the offer immediately.
    expect(useChatStore.getState().resumableCheckpoint).toBeNull();
  });

  it("hides the resume banner while streaming", () => {
    seedAssistant(
      [{ id: "t", kind: "thinking", content: "思考" }],
      false,
      true, // streaming
    );
    useChatStore.setState({
      resumableCheckpoint: { checkpoint_id: "cp-1", status: "running", iteration: 3, created_at: "t" },
    });
    render(<Conversation />);
    expect(screen.queryByText(/未完成的任务/)).not.toBeInTheDocument();
  });
});
