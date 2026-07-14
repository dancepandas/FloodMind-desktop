import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { render, screen, fireEvent } from "@testing-library/react";
import type { SchedTask, RunSummary, RunDetail } from "../state/scheduled-task-store";

const loadMock = vi.fn(async () => []);
const loadRunsMock = vi.fn(async () => []);
const loadRunMock = vi.fn(async () => null);
const runNowMock = vi.fn(async () => null);
const updateMock = vi.fn(async () => null);

let mockState = {
  tasks: [] as SchedTask[],
  runs: [] as RunSummary[],
  currentRun: null as RunDetail | null,
};

vi.mock("../state/scheduled-task-store", () => ({
  useScheduledTaskStore: (selector: (s: any) => any) =>
    selector({
      tasks: mockState.tasks,
      runs: mockState.runs,
      currentRun: mockState.currentRun,
      load: loadMock,
      loadRuns: loadRunsMock,
      loadRun: loadRunMock,
      runNow: runNowMock,
      update: updateMock,
    }),
}));

const setViewMock = vi.fn();
const setSelectedTaskIdMock = vi.fn();
let selectedTaskId: string | null = null;

vi.mock("../state/ui-store", () => ({
  useUiStore: (selector: (s: any) => any) =>
    selector({
      selectedTaskId,
      setView: setViewMock,
      setSelectedTaskId: setSelectedTaskIdMock,
    }),
}));

vi.mock("../state/workspace-store", () => ({
  useWorkspaceStore: (selector: (s: any) => any) =>
    selector({ current: { path: "/ws/A" } }),
}));

vi.mock("./TaskEditModal", () => ({
  default: ({
    editing,
    onClose,
  }: {
    editing: SchedTask | null;
    onClose: () => void;
  }) => (
    <button data-testid="task-edit-modal" onClick={onClose} type="button">
      {editing ? "editing" : "create"}
    </button>
  ),
}));

// Import after mock registration.
import ScheduledTasksView from "./ScheduledTasksView";
import { _resetBlockIdsForTest } from "../state/chat-store";

beforeEach(() => {
  vi.clearAllMocks();
  _resetBlockIdsForTest();
  selectedTaskId = null;
  mockState = { tasks: [], runs: [], currentRun: null };
});

function renderStatic() {
  return renderToStaticMarkup(<ScheduledTasksView />);
}

function makeTask(overrides: Partial<SchedTask> = {}): SchedTask {
  return {
    id: "t1",
    session_id: "s1",
    command: "生成日报",
    repeat: "daily",
    enabled: true,
    run_time: "08:30",
    scheduled_at: "",
    timezone: "UTC",
    next_run_at: "2099-01-01T08:30",
    status: "idle",
    last_status: "",
    last_run_at: "",
    last_finished_at: "",
    last_result: "",
    last_error: "",
    artifacts: [],
    attempt_count: 0,
    created_at: "",
    updated_at: "",
    ...overrides,
  };
}

describe("ScheduledTasksView", () => {
  it("shows empty hint when no tasks exist", () => {
    const html = renderStatic();
    expect(html).toContain("暂无定时任务，点击上方按钮创建");
    expect(html).toContain("＋ 新建定时任务");
    expect(html).not.toContain("生成日报");
  });

  it("shows selection hint when tasks exist but none is selected", () => {
    mockState.tasks = [makeTask()];
    const html = renderStatic();
    expect(html).toContain("选择一个定时任务查看详情");
    expect(html).toContain("生成日报");
  });

  it("lists tasks with status dot and command", () => {
    mockState.tasks = [makeTask({ id: "t1", command: "生成日报" }), makeTask({ id: "t2", command: "生成周报" })];
    const html = renderStatic();
    expect(html).toContain("生成日报");
    expect(html).toContain("生成周报");
  });

  it("renders task command, schedule and status", () => {
    selectedTaskId = "t1";
    mockState.tasks = [makeTask({ status: "completed", last_error: "boom" })];
    const html = renderStatic();
    expect(html).toContain("生成日报");
    expect(html).toContain("每日 08:30");
    expect(html).toContain("状态");
    expect(html).toContain("completed");
    expect(html).toContain("boom");
  });

  it("renders one-shot schedule when repeat is none", () => {
    selectedTaskId = "t1";
    mockState.tasks = [makeTask({ repeat: "none", scheduled_at: "2099-01-01T09:00" })];
    const html = renderStatic();
    expect(html).toContain("一次性 2099-01-01T09:00");
  });

  it("lists run history", () => {
    selectedTaskId = "t1";
    mockState.tasks = [makeTask()];
    mockState.runs = [
      { run_id: "r1", started_at: "2026-07-10T08:30:00", finished_at: "", status: "completed" },
      { run_id: "r2", started_at: "2026-07-10T08:31:00", finished_at: "", status: "failed" },
    ];
    const html = renderStatic();
    expect(html).toContain("运行历史");
    expect(html).toContain("2026-07-10T08:30:00");
    expect(html).toContain("2026-07-10T08:31:00");
    expect(html).toContain("completed");
    expect(html).toContain("failed");
  });

  it("shows empty run history message", () => {
    selectedTaskId = "t1";
    mockState.tasks = [makeTask()];
    mockState.runs = [];
    const html = renderStatic();
    expect(html).toContain("还没有运行记录");
  });

  it("replays run events into BlockView components", () => {
    selectedTaskId = "t1";
    mockState.tasks = [makeTask()];
    mockState.currentRun = {
      run_id: "r1",
      task_id: "t1",
      started_at: "2026-07-10T08:30:00",
      finished_at: "2026-07-10T08:31:00",
      status: "completed",
      events: [
        { type: "thinking", content: "step 1" },
        { type: "text", content: "final answer" },
      ],
      artifacts: [],
    };
    const html = renderStatic();
    expect(html).toContain("执行过程");
    expect(html).toContain("思考过程");
    expect(html).toContain("final answer");
  });

  it("renders run artifacts", () => {
    selectedTaskId = "t1";
    mockState.tasks = [makeTask()];
    mockState.currentRun = {
      run_id: "r1",
      task_id: "t1",
      started_at: "2026-07-10T08:30:00",
      finished_at: "",
      status: "completed",
      events: [],
      artifacts: [{ kind: "file", name: "report.md", path: "/ws/A/report.md" }],
    };
    const html = renderStatic();
    expect(html).toContain("产物");
    expect(html).toContain("report.md");
  });

  it("shows 'no content' when the run has no events", () => {
    selectedTaskId = "t1";
    mockState.tasks = [makeTask()];
    mockState.currentRun = {
      run_id: "r1",
      task_id: "t1",
      started_at: "2026-07-10T08:30:00",
      finished_at: "",
      status: "completed",
      events: [],
      artifacts: [],
    };
    const html = renderStatic();
    expect(html).toContain("（无内容）");
  });

  it("reloads task list when TaskEditModal closes after create", () => {
    render(<ScheduledTasksView />);
    fireEvent.click(screen.getByRole("button", { name: /新建定时任务/ }));
    fireEvent.click(screen.getByTestId("task-edit-modal"));
    expect(loadMock).toHaveBeenCalledWith("/ws/A");
  });

  it("reloads task list when TaskEditModal closes after edit", () => {
    selectedTaskId = "t1";
    mockState.tasks = [makeTask()];
    render(<ScheduledTasksView />);
    fireEvent.click(screen.getByRole("button", { name: /编辑/ }));
    fireEvent.click(screen.getByTestId("task-edit-modal"));
    expect(loadMock).toHaveBeenCalledWith("/ws/A");
  });
});
