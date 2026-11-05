import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, act } from "@testing-library/react";
import Conversation from "./Conversation";
import { useChatStore, _resetBlockIdsForTest, type ArtifactBlock, type Block, type AssistantTurn } from "../state/chat-store";
import { useUiStore } from "../state/ui-store";
import { useTurnCollapseStore } from "../state/turn-collapse-store";
import { openFileInSystem } from "../lib/open-file";

vi.mock("../lib/open-file", () => ({
  openFileInSystem: vi.fn(() => Promise.resolve()),
}));
vi.mock("../lib/chat-stream", () => ({
  streamChat: vi.fn(),
}));

afterEach(() => {
  cleanup();
  // Reset the store + id counter between tests so seeding is order-independent.
  useChatStore.setState({ turns: [], streaming: false });
  useUiStore.setState({ previewPath: null, lightboxImage: null });
  useTurnCollapseStore.setState({ overrides: {} });
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

function seedAssistant(
  blocks: Block[],
  done = true,
  streaming = false,
  extra: Partial<AssistantTurn> = {},
) {
  useChatStore.setState({
    turns: [{ id: "a1", role: "assistant", blocks, usage: null, done, ...extra }],
    streaming,
  });
}

describe("Conversation", () => {
  it("keeps a reader in history during streaming and exposes an accessible jump-to-latest action", () => {
    let height = 1400;
    const heightSpy = vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(() => height);
    const viewportSpy = vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(400);
    try {
      seedAssistant([{ id: "live", kind: "text", content: "正在答复" }], false, true);
      const { container } = render(<Conversation />);
      const viewport = container.querySelector<HTMLDivElement>(".conversation")!;
      viewport.scrollTop = 200;
      fireEvent.scroll(viewport);
      expect(screen.getByRole("button", { name: "跳转到最新消息" })).toBeInTheDocument();
      height = 1800;
      act(() => seedAssistant([{ id: "live", kind: "text", content: "正在答复，新增内容" }], false, true));
      expect(viewport.scrollTop).toBe(200);
      expect(screen.getByText("正在答复，新增内容")).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "跳转到最新消息" }));
      // jsdom doesn't clamp scrollTop; the browser clamps this to height - clientHeight.
      expect(viewport.scrollTop).toBe(1800);
      expect(screen.queryByRole("button", { name: "跳转到最新消息" })).not.toBeInTheDocument();
    } finally {
      heightSpy.mockRestore();
      viewportSpy.mockRestore();
    }
  });

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

  it("places the completed execution disclosure immediately before the final answer", () => {
    seedAssistant([
      { id: "t", kind: "thinking", content: "推理过程" },
      { id: "tool", kind: "tool", call_id: "c1", tool_name: "Read", status: "completed", input: "a.txt" },
      { id: "final", kind: "text", content: "完成", final: true },
    ], true, false, {
      finishReason: "stop",
      finalNodeId: "final",
      startedAt: 1_000,
      completedAt: 3_000,
      usage: { prompt: 1_200, completion: 80, total: 1_280 },
    });
    render(<Conversation />);

    const disclosure = screen.getByRole("button", { name: /展开执行过程/ });
    const finalAnswer = screen.getByText("完成");
    expect(disclosure).toHaveAttribute("aria-expanded", "false");
    expect(disclosure).toHaveAttribute("aria-controls");
    expect(disclosure.compareDocumentPosition(finalAnswer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(disclosure).toHaveTextContent("耗时 2s");
    expect(disclosure).toHaveTextContent("1 次工具调用");
    expect(disclosure).toHaveTextContent("1.2k 输入 tokens");
    expect(disclosure).toHaveTextContent("80 输出 tokens");
    expect(screen.queryByText("推理过程")).not.toBeInTheDocument();
  });

  it("uses native activity renderers inside the completed disclosure", () => {
    seedAssistant([
      { id: "t", kind: "thinking", content: "推理过程" },
      { id: "mid", kind: "text", content: "我先查一下" },
      { id: "tool", kind: "tool", call_id: "c1", tool_name: "Read", status: "completed", input: "a.txt" },
      { id: "final", kind: "text", content: "完成", final: true },
    ], true, false, { finishReason: "stop", finalNodeId: "final" });
    render(<Conversation />);

    fireEvent.click(screen.getByRole("button", { name: /展开执行过程/ }));
    expect(screen.getByText("思考过程")).toBeInTheDocument();
    expect(screen.getByText("我先查一下")).toBeInTheDocument();
    expect(screen.getByText(/工具调用 Read/)).toBeInTheDocument();
  });

  it("renders completed process blocks directly through native renderers", () => {
    seedAssistant([
      { id: "single", kind: "thinking", content: "第一段思考" },
      { id: "boundary", kind: "text", content: "先说明一下" },
      { id: "context", kind: "context", label: "项目上下文", content: "context" },
      { id: "tool", kind: "tool", call_id: "c1", tool_name: "Read", status: "completed", input: "a.txt" },
      { id: "final", kind: "text", content: "完成", final: true },
    ], true, false, { finishReason: "stop", finalNodeId: "final" });
    render(<Conversation />);

    fireEvent.click(screen.getByRole("button", { name: /展开执行过程/ }));
    expect(screen.getByText("思考过程")).toBeInTheDocument();
    expect(screen.getByText("先说明一下")).toBeInTheDocument();
    expect(screen.getByText("项目上下文")).toBeInTheDocument();
    expect(screen.getByText(/工具调用 Read a\.txt/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /活动组/ })).not.toBeInTheDocument();
  });

  it("renders the live summary before the current round's two status rows", () => {
    seedAssistant([
      { id: "t", kind: "thinking", content: "先算一下", round: 0 },
      { id: "tool", kind: "tool", call_id: "c1", tool_name: "Read", status: "running", input: "a.txt", round: 0 },
    ], false, true, { startedAt: Date.now() - 2_000, activeRound: 0 });
    render(<Conversation />);

    const summary = screen.getByRole("status", { name: /已工作/ });
    const thinking = screen.getByText(/正在思考/);
    const tool = screen.getByText(/工具调用 Read a\.txt/);
    expect(summary.compareDocumentPosition(thinking) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(thinking.compareDocumentPosition(tool) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(summary).not.toHaveAttribute("aria-expanded");
    expect(screen.queryByText("先算一下")).not.toBeInTheDocument();
  });

  it("keeps only the latest thinking and latest tool visible in the current round", () => {
    seedAssistant(
      [
        { id: "t1", kind: "thinking", content: "旧思考", round: 0 },
        { id: "tool-1", kind: "tool", call_id: "c1", tool_name: "Read", status: "completed", input: "a.txt", round: 0 },
        { id: "t2", kind: "thinking", content: "当前思考", round: 0 },
        { id: "tool-2", kind: "tool", call_id: "c2", tool_name: "Bash", status: "running", input: "pwd", round: 0 },
      ],
      false,
      true,
      { startedAt: Date.now() - 2_000, activeRound: 0 },
    );
    render(<Conversation />);

    expect(screen.getAllByText(/正在思考/)).toHaveLength(1);
    expect(screen.getByText(/工具调用 Bash pwd/)).toBeInTheDocument();
    expect(screen.queryByText(/工具调用 Read a\.txt/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByText(/正在思考/));
    expect(screen.getByText("当前思考")).toBeInTheDocument();
    expect(screen.queryByText("旧思考")).not.toBeInTheDocument();
  });

  it("renders all settled process directly inside the execution disclosure", () => {
    seedAssistant(
      [
        { id: "tool-1", kind: "tool", call_id: "c1", tool_name: "Read", status: "completed", input: "a.txt" },
        { id: "tool-2", kind: "tool", call_id: "c2", tool_name: "Bash", status: "completed", input: "pwd" },
        { id: "final", kind: "text", content: "完成", final: true },
      ],
      true,
      false,
      { finishReason: "stop", finalNodeId: "final", startedAt: 1_000, completedAt: 3_000 },
    );
    render(<Conversation />);

    fireEvent.click(screen.getByRole("button", { name: /展开执行过程/ }));
    expect(screen.getByText(/工具调用 Read a\.txt/)).toBeInTheDocument();
    expect(screen.getByText(/工具调用 Bash pwd/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /活动组/ })).not.toBeInTheDocument();
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

  it("shows one collapsed thinking row for a live singleton", () => {
    seedAssistant(
      [{ id: "t", kind: "thinking", content: "先算一下", round: 0 }],
      false,
      true,
      { startedAt: Date.now() - 1_000, activeRound: 0 },
    );
    render(<Conversation />);
    expect(screen.getByRole("status", { name: /已工作/ })).toBeInTheDocument();
    expect(screen.getAllByText(/正在思考/)).toHaveLength(1);
    expect(screen.queryByText("先算一下")).not.toBeInTheDocument();
    fireEvent.click(screen.getByText(/正在思考/));
    expect(screen.getByText("先算一下")).toBeInTheDocument();
  });

  it("moves previous rounds directly into the live summary fold", () => {
    seedAssistant(
      [
        { id: "old-think", kind: "thinking", content: "第一轮思考", round: 0 },
        { id: "old-tool", kind: "tool", call_id: "c1", tool_name: "Read", status: "completed", input: "old.txt", round: 0 },
        { id: "old-text", kind: "text", content: "第一轮说明", final: false, round: 0 },
        { id: "cur-think", kind: "thinking", content: "第二轮思考", round: 1 },
        { id: "cur-tool", kind: "tool", call_id: "c2", tool_name: "Bash", status: "running", input: "pwd", round: 1 },
        { id: "cur-text", kind: "text", content: "第二轮说明", final: false, round: 1 },
      ],
      false,
      true,
      { startedAt: Date.now() - 2_000, activeRound: 1 },
    );
    render(<Conversation />);

    const fold = screen.getByRole("button", { name: /展开执行过程/ });
    expect(fold).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("第一轮思考")).not.toBeInTheDocument();
    expect(screen.queryByText("第一轮说明")).not.toBeInTheDocument();
    expect(screen.getByText(/工具调用 Bash pwd/)).toBeInTheDocument();
    expect(screen.getByText("第二轮说明")).toBeInTheDocument();
    expect(screen.queryByText(/上一轮|历史记录/)).not.toBeInTheDocument();

    fireEvent.click(fold);
    expect(screen.getByText("第一轮说明")).toBeInTheDocument();
    expect(screen.getByText(/工具调用 Read old\.txt/)).toBeInTheDocument();
    expect(screen.getByText(/正在思考/)).toBeInTheDocument();
    expect(screen.getByText("第二轮说明")).toBeInTheDocument();
  });

  it("keeps current-round prose visible while hiding current context", () => {
    seedAssistant(
      [
        { id: "ctx", kind: "context", label: "项目上下文", content: "context", round: 2 },
        { id: "mid", kind: "text", content: "当前说明", final: false, round: 2 },
      ],
      false,
      true,
      { activeRound: 2 },
    );
    render(<Conversation />);
    expect(screen.getByText("当前说明")).toBeInTheDocument();
    expect(screen.queryByText("项目上下文")).not.toBeInTheDocument();
  });

  it("shows a running tool through its native renderer", () => {
    seedAssistant(
      [{ id: "tool", kind: "tool", call_id: "c1", tool_name: "Read", status: "running", input: "读取 E:\\very\\long\\path\\file.txt" }],
      false,
      true,
      { startedAt: Date.now() - 1_000 },
    );
    render(<Conversation />);
    expect(screen.getByRole("status", { name: /已工作/ })).toBeInTheDocument();
    // 单行「工具调用 + 工具名 + 参数」，详情默认折叠
    expect(screen.getByText(/工具调用 Read 读取/)).toBeInTheDocument();
    expect(screen.queryByText(/→ 读取/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByText(/工具调用 Read 读取/));
    expect(screen.getByText(/→ 读取/)).toBeInTheDocument();
  });

  it("shows the live summary while the model writes", () => {
    seedAssistant([{ id: "a", kind: "text", content: "答案" }], false, true, { startedAt: Date.now() - 1_000 });
    render(<Conversation />);
    expect(screen.getByRole("status", { name: /已工作/ })).toBeInTheDocument();
    expect(screen.getByText("答案")).toBeInTheDocument();
  });

  it("during execution keeps earlier visible prose as an activity boundary", () => {
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
    // 参考实现保留可见叙述；文本会中断相邻活动的紧凑合并。
    expect(screen.getByText("正在生成的答案")).toBeInTheDocument();
    expect(screen.getByText("中间回答")).toBeInTheDocument();
  });

  it("folds intermediate answers into the 过程 trace on completion", () => {
    seedAssistant([
      { id: "mid", kind: "text", content: "我先查一下资料", final: false },
      { id: "final", kind: "text", content: "最终结论", final: true },
    ], true, false, { finishReason: "stop", finalNodeId: "final" });
    render(<Conversation />);
    // 完成态：只显示最终回答；中间 text 默认不可见
    expect(screen.getByText("最终结论")).toBeInTheDocument();
    expect(screen.queryByText("我先查一下资料")).not.toBeInTheDocument();
    // 展开执行过程可复盘中间回答（折叠摘要）
    fireEvent.click(screen.getByRole("button", { name: /展开执行过程/ }));
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
      { finishReason: "aborted" },
    );
    render(<Conversation />);
    expect(screen.getByRole("button", { name: /展开执行过程.*已停止/ })).toBeInTheDocument();
    expect(screen.getByText("写了一半的回答")).toBeInTheDocument();
  });

  it("shows 已中断 for a non-streaming unfinished turn", () => {
    seedAssistant([{ id: "t", kind: "thinking", content: "思考" }], false, false);
    render(<Conversation />);
    expect(screen.getByText("已中断")).toBeInTheDocument();
  });

  it("shows a pending permission card while the turn is executing", () => {
    seedAssistant(
      [{
        id: "p1",
        kind: "permission",
        ask_id: "ask-1",
        call_id: "call-1",
        tool_name: "Bash",
        reason: "需要执行命令",
        input: { command: "pwd" },
      }],
      false,
      true,
    );

    render(<Conversation />);

    expect(screen.getByText("等待授权", { selector: ".tstat" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "批准" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "拒绝" })).toBeInTheDocument();
  });

  it("does not keep a permission card after the turn completes", () => {
    seedAssistant([
      {
        id: "p1",
        kind: "permission",
        ask_id: "ask-1",
        call_id: "call-1",
        tool_name: "Bash",
        reason: "需要执行命令",
      },
      { id: "final", kind: "text", content: "完成", final: true },
    ]);

    render(<Conversation />);

    expect(screen.queryByText("等待授权")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "批准" })).not.toBeInTheDocument();
    expect(screen.queryByText("已用过程")).not.toBeInTheDocument();
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

  it("does not expose SDK checkpoint recovery in the conversation UI", () => {
    seedAssistant([{ id: "f", kind: "text", content: "之前完成", final: true }]);
    render(<Conversation />);
    expect(screen.queryByText(/检测到未完成的任务/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "恢复执行" })).not.toBeInTheDocument();
  });
});
