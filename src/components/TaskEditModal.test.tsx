import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { SchedTask } from "../state/scheduled-task-store";

const createMock = vi.fn(async () => null);
const updateMock = vi.fn(async () => null);

vi.mock("../state/scheduled-task-store", () => ({
  useScheduledTaskStore: (selector: (s: any) => any) =>
    selector({ create: createMock, update: updateMock }),
}));

// Import after mock registration.
import TaskEditModal from "./TaskEditModal";

beforeEach(() => {
  vi.clearAllMocks();
});

function render(props: { workspace: string; editing: SchedTask | null }) {
  return renderToStaticMarkup(
    <TaskEditModal workspace={props.workspace} editing={props.editing} onClose={vi.fn()} />
  );
}

describe("TaskEditModal", () => {
  it("renders create mode with default one-shot scheduled time", () => {
    const html = render({ workspace: "/ws/A", editing: null });
    expect(html).toContain("新建定时任务");
    expect(html).toContain('placeholder="例如：生成上周水文情势简报"');
    expect(html).toContain("datetime-local");
    expect(html).not.toContain("编辑定时任务");
  });

  it("renders edit mode pre-filled with task values", () => {
    const task: SchedTask = {
      id: "t1",
      session_id: "s1",
      command: "生成日报",
      repeat: "daily",
      enabled: false,
      run_time: "08:30",
      scheduled_at: "2099-01-01T00:00",
      timezone: "UTC",
      next_run_at: "2099-01-01T00:00",
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
    };
    const html = render({ workspace: "/ws/A", editing: task });
    expect(html).toContain("编辑定时任务");
    expect(html).toContain("生成日报");
    expect(html).toContain('type="time"');
    expect(html).toContain('value="08:30"');
  });

  it("does not show daily time input in default one-shot create mode", () => {
    const html = render({ workspace: "/ws/A", editing: null });
    // Default is one-shot, so daily time input should not appear.
    expect(html).toContain("datetime-local");
    expect(html).not.toContain('type="time"');
  });
});
