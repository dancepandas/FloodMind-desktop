from floodmind_desktop_sidecar.agent import StubAgent
from floodmind_desktop_sidecar.app import create_app
from floodmind.agent.scheduled_task_runtime import ScheduledTaskRuntime
from floodmind_desktop_sidecar.task_index import TaskIndex
from floodmind_desktop_sidecar.task_run_store import TaskRunStore


def _client(tmp_path, monkeypatch, runner=None):
    monkeypatch.chdir(tmp_path)
    rt = ScheduledTaskRuntime(tmp_path / "tasks.json")
    idx = TaskIndex(tmp_path)
    rs = TaskRunStore(tmp_path)
    client = create_app(StubAgent(), task_runtime=rt, task_index=idx,
                        task_run_store=rs, task_runner=runner, start_runner=False).test_client()
    return client, rt, idx, rs


def test_create_then_list_scoped_by_workspace(tmp_path, monkeypatch):
    client, rt, idx, rs = _client(tmp_path, monkeypatch)
    r = client.post("/api/scheduled-tasks", json={
        "workspace": "/ws/A", "command": "daily report", "repeat": "daily", "run_time": "09:00"})
    assert r.status_code == 200
    task = r.get_json()
    assert task["command"] == "daily report"
    assert task["repeat"] == "daily"
    assert task["session_id"]                # per-task uuid

    # A task in another workspace is not listed for /ws/A.
    client.post("/api/scheduled-tasks", json={
        "workspace": "/ws/B", "command": "other", "repeat": "none", "scheduled_at": "2099-01-01T00:00:00"})

    items = client.get("/api/scheduled-tasks?workspace=/ws/A").get_json()["tasks"]
    assert [t["id"] for t in items] == [task["id"]]


def test_create_validates_command_and_schedule(tmp_path, monkeypatch):
    client, _, _, _ = _client(tmp_path, monkeypatch)
    assert client.post("/api/scheduled-tasks", json={"workspace": "/ws/A"}).status_code == 400          # no command
    assert client.post("/api/scheduled-tasks", json={
        "workspace": "/ws/A", "command": "x", "repeat": "daily"}).status_code == 400                    # daily needs run_time
    assert client.post("/api/scheduled-tasks", json={
        "workspace": "/ws/A", "command": "x", "repeat": "none"}).status_code == 400                     # one-shot needs scheduled_at


def test_update_enable_disable_and_delete(tmp_path, monkeypatch):
    client, rt, idx, rs = _client(tmp_path, monkeypatch)
    task = client.post("/api/scheduled-tasks", json={
        "workspace": "/ws/A", "command": "c", "repeat": "none",
        "scheduled_at": "2099-01-01T00:00:00"}).get_json()
    r = client.patch(f"/api/scheduled-tasks/{task['id']}", json={"enabled": False})
    assert r.status_code == 200
    assert r.get_json()["task"]["enabled"] is False
    assert client.delete(f"/api/scheduled-tasks/{task['id']}").status_code == 200
    assert client.get(f"/api/scheduled-tasks/{task['id']}").status_code == 404


def test_update_ignores_status_field(tmp_path, monkeypatch):
    client, rt, idx, rs = _client(tmp_path, monkeypatch)
    task = client.post("/api/scheduled-tasks", json={
        "workspace": "/ws/A", "command": "c", "repeat": "none",
        "scheduled_at": "2099-01-01T00:00:00"}).get_json()
    r = client.patch(f"/api/scheduled-tasks/{task['id']}", json={"status": "completed"})
    assert r.status_code == 200
    # Status must remain pending; clients cannot override the runner state machine.
    assert r.get_json()["task"]["status"] == "pending"


def test_run_now_returns_run_id_via_runner(tmp_path, monkeypatch):
    class FakeRunner:
        def __init__(self):
            self.called = []
        def run_now(self, task_id):
            self.called.append(task_id)
            return "run-fake"
    runner = FakeRunner()
    client, _, _, _ = _client(tmp_path, monkeypatch, runner=runner)
    task = client.post("/api/scheduled-tasks", json={
        "workspace": "/ws/A", "command": "c", "repeat": "none",
        "scheduled_at": "2099-01-01T00:00:00"}).get_json()
    r = client.post(f"/api/scheduled-tasks/{task['id']}/run")
    assert r.status_code == 200
    assert r.get_json() == {"run_id": "run-fake"}
    assert runner.called == [task["id"]]


def test_run_now_409_when_no_runner(tmp_path, monkeypatch):
    client, _, _, _ = _client(tmp_path, monkeypatch)             # runner=None
    task = client.post("/api/scheduled-tasks", json={
        "workspace": "/ws/A", "command": "c", "repeat": "none",
        "scheduled_at": "2099-01-01T00:00:00"}).get_json()
    assert client.post(f"/api/scheduled-tasks/{task['id']}/run").status_code == 503


def test_runs_list_and_detail(tmp_path, monkeypatch):
    client, rt, idx, rs = _client(tmp_path, monkeypatch)
    task = client.post("/api/scheduled-tasks", json={
        "workspace": "/ws/A", "command": "c", "repeat": "none",
        "scheduled_at": "2099-01-01T00:00:00"}).get_json()
    # Seed a run record directly via the store (the worker path is tested elsewhere).
    rs.create({"run_id": "run-1", "task_id": task["id"], "started_at": "2026-01-01T00:00:00",
               "finished_at": "2026-01-01T00:01:00", "status": "completed", "events": [], "artifacts": []})
    runs = client.get(f"/api/scheduled-tasks/{task['id']}/runs").get_json()["runs"]
    assert [r["run_id"] for r in runs] == ["run-1"]
    detail = client.get(f"/api/scheduled-tasks/{task['id']}/runs/run-1").get_json()
    assert detail["run_id"] == "run-1"
    assert detail["events"] == []


def test_list_auto_indexes_agent_created_tasks(tmp_path, monkeypatch):
    """Agent-created tasks (ScheduleTask tool in a conversation) live in the SDK
    runtime but lack a task_index entry — they'd be invisible in the UI. The list
    endpoint must auto-index orphaned tasks under the requesting workspace."""
    client, rt, idx, rs = _client(tmp_path, monkeypatch)
    # Simulate an agent-created task: write directly to the runtime, bypassing
    # the desktop index (the way the ScheduleTask tool would).
    rt.create_task(session_id="s1", command="搜集水利资讯", repeat="daily", run_time="08:00")

    # Without auto-index the task would be missing from the workspace query.
    items = client.get("/api/scheduled-tasks?workspace=/ws/A").get_json()["tasks"]
    tids = [t["id"] for t in items]
    assert len(tids) == 1
    assert idx.get(tids[0]) == "/ws/A"   # persisted into the index for next time

    # A second query should be stable — the task is now indexed.
    items2 = client.get("/api/scheduled-tasks?workspace=/ws/A").get_json()["tasks"]
    assert [t["id"] for t in items2] == tids
