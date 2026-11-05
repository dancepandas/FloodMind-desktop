import { describe, it, expect, vi, afterEach } from "vitest";
import { useBackgroundTaskStore, runningCount, type BgTask } from "./background-task-store";

vi.mock("../lib/sidecar-client", () => ({ getBaseUrl: vi.fn(async () => "http://test") }));

const RUNNING: BgTask = { task_id: "t1", status: "running", command: "ping", exit_code: null, started_at: 1, finished_at: null, tail: "", stdout_path: "" };

describe("background-task-store", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    useBackgroundTaskStore.setState({ tasks: [], panelOpen: false });
  });

  it("load parses tasks from /api/background-tasks", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ tasks: [RUNNING] }), { status: 200 })),
    );
    await useBackgroundTaskStore.getState().load();
    expect(useBackgroundTaskStore.getState().tasks).toHaveLength(1);
    expect(useBackgroundTaskStore.getState().tasks[0].task_id).toBe("t1");
  });

  it("kill POSTs the task id and refreshes", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    useBackgroundTaskStore.setState({ tasks: [RUNNING] });

    const ok = await useBackgroundTaskStore.getState().kill("t1");
    expect(ok).toBe(true);
    expect(String((fetchMock as any).mock.calls[0][0])).toContain("/api/background-tasks/t1/kill");
    expect(((fetchMock as any).mock.calls[0][1] as RequestInit).method).toBe("POST");
  });

  it("kill returns false when the sidecar rejects", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 404 })));
    expect(await useBackgroundTaskStore.getState().kill("nope")).toBe(false);
  });

  it("runningCount counts only in-progress statuses (v2.0.0 full set)", () => {
    const running = ["starting", "running", "kill_requested", "terminating"];
    const terminal = ["completed", "failed", "killed", "kill_failed", "orphaned", "unknown"];
    const tasks = [
      ...running.map((s) => ({ status: s })),
      ...terminal.map((s) => ({ status: s })),
    ] as any[];
    expect(runningCount(tasks)).toBe(running.length);
  });
});
