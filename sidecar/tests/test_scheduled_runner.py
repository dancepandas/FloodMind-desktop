from floodmind_desktop_sidecar.scheduled_runner import _due_tasks, _execute_task
from floodmind_desktop_sidecar.task_run_store import TaskRunStore


def test_due_tasks_filters_enabled_past_nonrunning():
    now = "2026-01-01T09:05:00"
    tasks = [
        {"id": "a", "enabled": True, "status": "pending", "next_run_at": "2026-01-01T09:00:00"},   # due
        {"id": "b", "enabled": True, "status": "pending", "next_run_at": "2026-01-01T10:00:00"},   # future
        {"id": "c", "enabled": False, "status": "pending", "next_run_at": "2026-01-01T09:00:00"},  # disabled
        {"id": "d", "enabled": True, "status": "running", "next_run_at": "2026-01-01T09:00:00"},   # running
        {"id": "e", "enabled": True, "status": "pending", "next_run_at": ""},                       # no schedule
    ]
    assert [t["id"] for t in _due_tasks(tasks, now)] == ["a"]


class FakeRuntime:
    def __init__(self):
        self.completed = []

    def complete_task(self, task_id, *, success, result="", error="", artifacts=None):
        self.completed.append((task_id, success, result, error, artifacts or []))


class FakeAgent:
    def run_headless(self, session_id, workspace_path, command):
        events = [{"type": "text", "content": "done"}]
        artifacts = [{"kind": "file", "name": "r.xlsx", "path": "/o/r.xlsx"}]
        return events, artifacts, "done"


def test_execute_task_success_writes_run_and_completes(tmp_path):
    run_store = TaskRunStore(tmp_path)
    task = {"id": "sched_a", "session_id": "sess-a", "command": "build report"}
    rt = FakeRuntime()

    run = _execute_task(rt, run_store, FakeAgent(), task, "/ws/A", run_id="run-1")

    assert run["status"] == "completed"
    assert run["run_id"] == "run-1"
    assert run["artifacts"][0]["name"] == "r.xlsx"
    assert rt.completed == [("sched_a", True, "done", "", [{"kind": "file", "name": "r.xlsx", "path": "/o/r.xlsx"}])]
    stored = run_store.get("sched_a", "run-1")
    assert stored["status"] == "completed"
    assert any(e["type"] == "text" for e in stored["events"])


def test_execute_task_failure_marks_failed(tmp_path):
    run_store = TaskRunStore(tmp_path)
    task = {"id": "sched_b", "session_id": "sess-b", "command": "go"}

    class BoomAgent:
        def run_headless(self, *a, **k):
            raise RuntimeError("kaboom")

    run = _execute_task(FakeRuntime(), run_store, BoomAgent(), task, "/ws/A", run_id="run-9")
    assert run["status"] == "failed"
    assert any(e["type"] == "error" for e in run["events"])


def test_execute_task_generates_run_id_when_omitted(tmp_path):
    run = _execute_task(FakeRuntime(), TaskRunStore(tmp_path), FakeAgent(),
                        {"id": "sched_c", "session_id": "s", "command": "x"}, "/ws/A")
    assert run["run_id"].startswith("run-")
