from floodmind_desktop_sidecar.task_run_store import TaskRunStore


def _run(run_id="run-1", status="running"):
    return {"run_id": run_id, "task_id": "sched_a",
            "started_at": "2026-01-01T00:00:00", "finished_at": "",
            "status": status, "events": [], "artifacts": []}


def test_create_then_finalize(tmp_path):
    s = TaskRunStore(tmp_path)
    s.create(_run("run-1"))
    s.finalize({**_run("run-1"), "status": "completed",
                "finished_at": "2026-01-01T00:01:00",
                "events": [{"type": "text", "content": "hi"}],
                "artifacts": [{"kind": "file", "name": "r.xlsx", "path": "/o/r.xlsx"}]})
    got = s.get("sched_a", "run-1")
    assert got["status"] == "completed"
    assert got["events"] == [{"type": "text", "content": "hi"}]
    assert got["artifacts"][0]["name"] == "r.xlsx"


def test_list_returns_summaries_newest_first(tmp_path):
    s = TaskRunStore(tmp_path)
    s.create(_run("run-1"))
    s.finalize({**_run("run-1"), "status": "completed", "finished_at": "2026-01-01T00:01:00"})
    s.create({**_run("run-2"), "started_at": "2026-01-02T00:00:00"})
    s.finalize({**_run("run-2"), "started_at": "2026-01-02T00:00:00",
                "status": "completed", "finished_at": "2026-01-02T00:01:00"})
    items = s.list("sched_a")
    assert [i["run_id"] for i in items] == ["run-2", "run-1"]   # newest first
    assert set(items[0]) == {"run_id", "started_at", "finished_at", "status"}


def test_list_filters_by_task(tmp_path):
    s = TaskRunStore(tmp_path)
    s.create(_run("run-1"))
    s.create({**_run("run-9"), "task_id": "sched_b"})
    assert [i["run_id"] for i in s.list("sched_a")] == ["run-1"]
    assert [i["run_id"] for i in s.list("sched_b")] == ["run-9"]


def test_get_missing_returns_none(tmp_path):
    s = TaskRunStore(tmp_path)
    assert s.get("sched_a", "run-x") is None
