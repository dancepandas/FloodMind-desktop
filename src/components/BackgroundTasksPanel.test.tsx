import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { test, expect, vi, afterEach } from "vitest";
import BackgroundTasksPanel from "./BackgroundTasksPanel";
import { useBackgroundTaskStore } from "../state/background-task-store";

vi.mock("../lib/sidecar-client", () => ({ getBaseUrl: vi.fn(async () => "http://test") }));

function task(over: Partial<Record<string, unknown>> = {}) {
  return {
    task_id: "t1", status: "running", command: "ping -n 100", exit_code: null,
    started_at: 1700000000, finished_at: null, tail: "Reply from 127.0.0.1", stdout_path: "/x/o.log",
    ...over,
  } as any;
}

afterEach(() => {
  cleanup();
  useBackgroundTaskStore.setState({ tasks: [], panelOpen: false });
  vi.unstubAllGlobals();
});

test("renders running and completed tasks; only running has 关闭", () => {
  useBackgroundTaskStore.setState({
    tasks: [
      task(),
      task({ task_id: "t2", status: "completed", command: "ls", exit_code: 0, finished_at: 1700000100, tail: "" }),
    ],
  });
  render(<BackgroundTasksPanel />);
  expect(screen.getByText("ping -n 100")).toBeInTheDocument();
  expect(screen.getByText("ls")).toBeInTheDocument();
  expect(screen.getAllByRole("button", { name: /关闭/ })).toHaveLength(1);
});

test("关闭 terminates a running task via POST /kill", async () => {
  useBackgroundTaskStore.setState({ tasks: [task()] });
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  render(<BackgroundTasksPanel />);
  fireEvent.click(screen.getByRole("button", { name: /关闭/ }));
  await vi.waitFor(() =>
    expect(String((fetchMock as any).mock.calls[0][0])).toContain("/api/background-tasks/t1/kill"),
  );
  expect(((fetchMock as any).mock.calls[0][1] as RequestInit).method).toBe("POST");
});

test("返回 closes the panel", () => {
  useBackgroundTaskStore.setState({ tasks: [task()], panelOpen: true });
  render(<BackgroundTasksPanel />);
  fireEvent.click(screen.getByRole("button", { name: /返回/ }));
  expect(useBackgroundTaskStore.getState().panelOpen).toBe(false);
});

test("shows an empty hint when no tasks", () => {
  useBackgroundTaskStore.setState({ tasks: [], panelOpen: true });
  render(<BackgroundTasksPanel />);
  expect(screen.getByText("暂无后台任务")).toBeInTheDocument();
});
