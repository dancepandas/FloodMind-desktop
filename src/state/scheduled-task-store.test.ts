import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../lib/sidecar-client", () => ({ getBaseUrl: vi.fn(async () => "http://test") }));

import { useScheduledTaskStore } from "./scheduled-task-store";

beforeEach(() => {
  vi.clearAllMocks();
  useScheduledTaskStore.setState({ tasks: [], runs: [], currentRun: null });
});

describe("scheduled-task-store", () => {
  it("load GETs the workspace's tasks", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ tasks: [{ id: "sched_a", command: "c" }] }), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);
    const tasks = await useScheduledTaskStore.getState().load("/ws/A");
    expect(tasks).toHaveLength(1);
    expect(useScheduledTaskStore.getState().tasks[0].id).toBe("sched_a");
    expect(String((fetchMock as any).mock.calls[0][0])).toContain("/api/scheduled-tasks?workspace=");
    vi.unstubAllGlobals();
  });

  it("create POSTs and returns the task", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ id: "sched_b", command: "x" }), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);
    const t = await useScheduledTaskStore.getState().create({ workspace: "/ws/A", command: "x", repeat: "none", scheduled_at: "2099-01-01T00:00:00" });
    expect(t?.id).toBe("sched_b");
    const init = (fetchMock as any).mock.calls[0][1] as RequestInit;
    expect(init.method).toBe("POST");
    vi.unstubAllGlobals();
  });

  it("runNow returns run_id; degrade to null on failure", async () => {
    const ok = vi.fn(async () => new Response(JSON.stringify({ run_id: "run-1" }), { status: 200 }));
    vi.stubGlobal("fetch", ok);
    expect(await useScheduledTaskStore.getState().runNow("sched_a")).toBe("run-1");
    vi.unstubAllGlobals();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 500 })));
    expect(await useScheduledTaskStore.getState().runNow("sched_a")).toBeNull();
    vi.unstubAllGlobals();
  });

  it("loadRun stores currentRun", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ run_id: "run-1", task_id: "sched_a", events: [], artifacts: [] }), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);
    await useScheduledTaskStore.getState().loadRun("sched_a", "run-1");
    expect(useScheduledTaskStore.getState().currentRun?.run_id).toBe("run-1");
    vi.unstubAllGlobals();
  });
});
