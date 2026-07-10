# Scheduled Tasks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Workspace-scoped scheduled tasks that fire automatically in isolated background sessions (while the app is open), each producing a fully-replayable transcript + artifacts, manageable from a sidebar UI.

**Architecture:** The sidecar wraps the SDK's `ScheduledTaskRuntime` (store + state machine, already present) and adds the missing pieces: a `task_index.json` (task_id→workspace), a `TaskRunStore` (per-run event transcripts), `FloodMindAgent.run_headless` (build a fresh per-task agent + set the task's workspace in the worker thread's contextvars), and a `ScheduledRunner` daemon (poll → claim → spawn worker). Both `WorkspaceService._workspace_var` and `SESSION_CONTEXT._session_ctx_var` are `contextvars.ContextVar`, so background runs are thread-isolated from the foreground chat. The frontend replays a run's stored events through the existing `reduceEvent` → `BlockView`, reusing the conversation renderer.

**Tech Stack:** Python 3 / Flask sidecar (pytest), React 19 / Zustand / Vite / TypeScript frontend (vitest), FloodMind SDK (`ScheduledTaskRuntime`, `create_flood_agent`, `contextvars` workspace/session context).

## Global Constraints

- Sidecar tests run **without the real SDK** where possible. `ScheduledTaskRuntime` is itself SDK-free (pure JSON), so CRUD/runner tests use a real instance rooted at a tmp file. `FloodMindAgent.run_headless` is tested via the `FloodMindAgent.__new__()` + instance-method-monkeypatch pattern (matching `test_floodmind_agent.py`).
- `_app_data_dir()` is `Path.cwd()`; tests isolate it with `monkeypatch.chdir(tmp_path)`.
- Memory/layout (must not drift): SDK task store = `data/scheduled_tasks.json` (or `SCHEDULED_TASKS_FILE`); desktop `task_index.json` = `<cwd>/task_index.json`; run records = `<cwd>/task_runs/<task_id>/<run_id>.json`.
- **Execution isolation** relies on `contextvars`: every worker thread sets its own workspace/session context and must not mutate `FloodMindAgent._agent` (foreground). `run_headless` builds a fresh agent via `_build_agent`.
- Each task's `session_id` is a fresh uuid (desktop-created) → per-task memory isolation.
- After each task: sidecar `python -m pytest sidecar/tests` and frontend `npm run build && npm test` must be green before committing.

---

## File Structure

**Sidecar (Python):**
- **Create** `sidecar/floodmind_desktop_sidecar/task_index.py` — `TaskIndex`: SDK-free JSON map `task_id → workspace_path`.
- **Create** `sidecar/floodmind_desktop_sidecar/task_run_store.py` — `TaskRunStore`: SDK-free per-run transcripts (`events` + `artifacts`).
- **Modify** `sidecar/floodmind_desktop_sidecar/agent.py` — add `run_headless` to the `Agent` Protocol + `StubAgent`.
- **Modify** `sidecar/floodmind_desktop_sidecar/floodmind_agent.py` — implement `run_headless` + helper `_set_workspace_for(path)`.
- **Create** `sidecar/floodmind_desktop_sidecar/scheduled_runner.py` — pure helpers `_due_tasks` / `_execute_task` + the `ScheduledRunner` poll/worker loop + startup reclaim.
- **Modify** `sidecar/floodmind_desktop_sidecar/app.py` — 7 endpoints + construct index/run_store/runner; new `create_app` params.
- **Create** `sidecar/tests/test_task_index.py`, `test_task_run_store.py`, `test_scheduled_runner.py`, `test_scheduled_tasks_api.py`; **Modify** `test_floodmind_agent.py`.

**Frontend (TS/React):**
- **Create** `src/state/scheduled-task-store.ts` (+ test).
- **Modify** `src/state/ui-store.ts` — add view `'tasks'` + `selectedTaskId`.
- **Modify** `src/components/Sidebar.tsx` — replace "最近" with "定时任务"; open create modal.
- **Create** `src/components/TaskEditModal.tsx` — create/edit form.
- **Create** `src/components/ScheduledTasksView.tsx` — run history + replay via `reduceEvent`/`BlockView`.
- **Modify** `src/App.tsx` — render `ScheduledTasksView` when `view === 'tasks'`; load tasks on workspace change.

---

## Task 1: TaskIndex (task_id → workspace_path)

**Files:**
- Create: `sidecar/floodmind_desktop_sidecar/task_index.py`
- Test: `sidecar/tests/test_task_index.py`

**Interfaces:**
- Produces: `TaskIndex(app_data_root: Path)` with `set(task_id, workspace_path)`, `get(task_id) -> str|None`, `remove(task_id)`, `all() -> dict`. Persisted to `<root>/task_index.json`.

- [ ] **Step 1: Write the failing tests**

Create `sidecar/tests/test_task_index.py`:

```python
from floodmind_desktop_sidecar.task_index import TaskIndex


def test_set_get_remove_roundtrip(tmp_path):
    idx = TaskIndex(tmp_path)
    assert idx.get("sched_aaa") is None
    idx.set("sched_aaa", "/ws/A")
    assert idx.get("sched_aaa") == "/ws/A"
    idx.remove("sched_aaa")
    assert idx.get("sched_aaa") is None


def test_persists_to_disk(tmp_path):
    idx = TaskIndex(tmp_path)
    idx.set("sched_aaa", "/ws/A")
    idx.set("sched_bbb", "/ws/B")
    # A fresh instance reads the same file.
    idx2 = TaskIndex(tmp_path)
    assert idx2.all() == {"sched_aaa": "/ws/A", "sched_bbb": "/ws/B"}


def test_remove_missing_is_noop(tmp_path):
    idx = TaskIndex(tmp_path)
    idx.remove("nope")  # must not raise
    assert idx.all() == {}


def test_overwrite_existing(tmp_path):
    idx = TaskIndex(tmp_path)
    idx.set("sched_aaa", "/ws/A")
    idx.set("sched_aaa", "/ws/C")
    assert idx.get("sched_aaa") == "/ws/C"


def test_corrupt_file_degrades_to_empty(tmp_path):
    (tmp_path / "task_index.json").write_text("{not json", encoding="utf-8")
    idx = TaskIndex(tmp_path)
    assert idx.all() == {}   # corrupt -> empty, not a crash
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python -m pytest sidecar/tests/test_task_index.py -v`
Expected: FAIL — `ModuleNotFoundError: floodmind_desktop_sidecar.task_index`.

- [ ] **Step 3: Implement TaskIndex**

Create `sidecar/floodmind_desktop_sidecar/task_index.py`:

```python
"""task_id -> workspace_path index for scheduled tasks.

The SDK's ScheduledTaskRuntime task record carries no workspace, so the desktop
keeps this side mapping to scope lists and to know where to run each task.
SDK-free (pure filesystem) so it is unit-testable in isolation.
"""
from __future__ import annotations

import json
import threading
from pathlib import Path


class TaskIndex:
    def __init__(self, app_data_root: Path):
        self._path = Path(app_data_root) / "task_index.json"
        self._lock = threading.Lock()

    def _load(self) -> dict:
        try:
            return json.loads(self._path.read_text(encoding="utf-8"))
        except Exception:
            return {}

    def _save(self, data: dict) -> None:
        self._path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")

    def set(self, task_id: str, workspace_path: str) -> None:
        with self._lock:
            data = self._load()
            data[task_id] = workspace_path
            self._save(data)

    def get(self, task_id: str) -> str | None:
        return self._load().get(task_id)

    def remove(self, task_id: str) -> None:
        with self._lock:
            data = self._load()
            if task_id in data:
                del data[task_id]
                self._save(data)

    def all(self) -> dict:
        return self._load()
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `python -m pytest sidecar/tests/test_task_index.py -v`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add sidecar/floodmind_desktop_sidecar/task_index.py sidecar/tests/test_task_index.py
git commit -m "feat(sidecar): TaskIndex (task_id -> workspace_path for scheduled tasks)"
```

---

## Task 2: TaskRunStore (per-run transcripts)

**Files:**
- Create: `sidecar/floodmind_desktop_sidecar/task_run_store.py`
- Test: `sidecar/tests/test_task_run_store.py`

**Interfaces:**
- Produces: `TaskRunStore(app_data_root: Path)` with `create(run: dict)` (write a fresh `status="running"` record), `finalize(run: dict)` (overwrite with events/artifacts/status/finished_at), `list(task_id) -> list[dict]` (summaries `{run_id, started_at, finished_at, status}`, newest first), `get(task_id, run_id) -> dict|None`. Stored at `<root>/task_runs/<task_id>/<run_id>.json`.

- [ ] **Step 1: Write the failing tests**

Create `sidecar/tests/test_task_run_store.py`:

```python
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python -m pytest sidecar/tests/test_task_run_store.py -v`
Expected: FAIL — `ModuleNotFoundError`.

- [ ] **Step 3: Implement TaskRunStore**

Create `sidecar/floodmind_desktop_sidecar/task_run_store.py`:

```python
"""Per-run transcripts for scheduled tasks.

One JSON file per run under <root>/task_runs/<task_id>/<run_id>.json. Each run
stores the ordered sidecar-schema events yielded during execution; the frontend
replays them through reduceEvent to reproduce the full block transcript.
SDK-free (pure filesystem).
"""
from __future__ import annotations

import json
import threading
from pathlib import Path


class TaskRunStore:
    def __init__(self, app_data_root: Path):
        self._root = Path(app_data_root) / "task_runs"
        self._root.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()

    def _dir(self, task_id: str) -> Path:
        d = self._root / task_id
        d.mkdir(parents=True, exist_ok=True)
        return d

    def _path(self, task_id: str, run_id: str) -> Path:
        return self._dir(task_id) / f"{run_id}.json"

    def create(self, run: dict) -> None:
        with self._lock:
            self._path(run["task_id"], run["run_id"]).write_text(
                json.dumps(run, ensure_ascii=False, indent=2), encoding="utf-8"
            )

    def finalize(self, run: dict) -> None:
        # Same path as create; overwrite with the completed record.
        self.create(run)

    def list(self, task_id: str) -> list[dict]:
        out = []
        d = self._root / task_id
        if not d.exists():
            return []
        for p in d.glob("*.json"):
            try:
                rec = json.loads(p.read_text(encoding="utf-8"))
            except Exception:
                continue
            out.append(rec)
        out.sort(key=lambda r: r.get("started_at", ""), reverse=True)
        return [
            {
                "run_id": r["run_id"],
                "started_at": r.get("started_at", ""),
                "finished_at": r.get("finished_at", ""),
                "status": r.get("status", ""),
            }
            for r in out
        ]

    def get(self, task_id: str, run_id: str) -> dict | None:
        try:
            return json.loads(self._path(task_id, run_id).read_text(encoding="utf-8"))
        except FileNotFoundError:
            return None
        except Exception:
            return None
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `python -m pytest sidecar/tests/test_task_run_store.py -v`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add sidecar/floodmind_desktop_sidecar/task_run_store.py sidecar/tests/test_task_run_store.py
git commit -m "feat(sidecar): TaskRunStore (per-run scheduled-task transcripts)"
```

---

## Task 3: FloodMindAgent.run_headless (isolated background execution)

**Files:**
- Modify: `sidecar/floodmind_desktop_sidecar/agent.py` (Protocol + StubAgent)
- Modify: `sidecar/floodmind_desktop_sidecar/floodmind_agent.py` (FloodMindAgent)
- Test: `sidecar/tests/test_floodmind_agent.py` (append)

**Interfaces:**
- Consumes: `FloodMindAgent._memory_target(session_id)`, `_build_agent(session_id, persist_dir)`, `translate_event` (all existing).
- Produces: `Agent.run_headless(session_id: str, workspace_path: str, command: str) -> tuple[list[dict], list[dict], str]` — `(events, artifacts, final_text)`. On the Protocol, StubAgent (returns `([], [], "")`), and FloodMindAgent (real).

- [ ] **Step 1: Add the failing tests**

Append to `sidecar/tests/test_floodmind_agent.py`:

```python
def test_run_headless_collects_events_artifacts_final_text(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)            # _app_data_dir() == cwd
    from floodmind_desktop_sidecar.floodmind_agent import FloodMindAgent

    class FakeAgent:
        def stream(self, command):         # fresh agent .stream takes a string
            yield {"type": "answer_delta", "content": "Hello "}
            yield {"type": "answer_delta", "content": "world"}
            yield {"type": "file_generated", "filename": "r.xlsx", "download_url": "/o/r.xlsx"}

    a = FloodMindAgent.__new__(FloodMindAgent)
    a._agent = "FOREGROUND_AGENT"          # must be left untouched
    a._build_agent = lambda sid, pd: FakeAgent()
    a._set_workspace_for = lambda path: None     # stubbed — no SDK workspace setup

    events, artifacts, final_text = a.run_headless("sess-x", "/ws/A", "do the thing")

    assert a._agent == "FOREGROUND_AGENT"                # foreground untouched
    assert final_text == "Hello world"
    assert any(e["type"] == "text" for e in events)
    assert any(e["type"] == "artifact" and e["name"] == "r.xlsx" for e in events)
    assert artifacts == [{"kind": "file", "name": "r.xlsx", "path": "/o/r.xlsx"}]
    # no 'done' event in the collected list (terminal event is dropped)
    assert all(e.get("type") != "done" for e in events)


def test_run_headless_swallows_errors_into_an_error_event(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    from floodmind_desktop_sidecar.floodmind_agent import FloodMindAgent

    class BoomAgent:
        def stream(self, command):
            yield {"type": "answer_delta", "content": "partial"}
            raise RuntimeError("boom")

    a = FloodMindAgent.__new__(FloodMindAgent)
    a._agent = "FOREGROUND_AGENT"
    a._build_agent = lambda sid, pd: BoomAgent()
    a._set_workspace_for = lambda path: None

    events, artifacts, final_text = a.run_headless("sess-x", "/ws/A", "go")
    assert a._agent == "FOREGROUND_AGENT"
    assert any(e["type"] == "error" and "boom" in e["content"] for e in events)
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python -m pytest sidecar/tests/test_floodmind_agent.py::test_run_headless_collects_events_artifacts_final_text -v`
Expected: FAIL — `AttributeError: run_headless`.

- [ ] **Step 3: Extend the Protocol + StubAgent**

In `sidecar/floodmind_desktop_sidecar/agent.py`, add to the `Agent` Protocol (after `generate_title`):

```python
    def run_headless(self, session_id: str, workspace_path: str, command: str):
        """Run `command` in an isolated background session bound to `session_id`,
        with `workspace_path` set in the calling thread's contextvars. Returns
        (events, artifacts, final_text). Does NOT touch the foreground agent."""
        ...
```

Add to `StubAgent` (after `generate_title`):

```python
    def run_headless(self, session_id, workspace_path, command):
        return [], [], ""
```

- [ ] **Step 4: Implement on FloodMindAgent**

In `sidecar/floodmind_desktop_sidecar/floodmind_agent.py`, add these two methods to `FloodMindAgent` (e.g. after `activate_conversation`):

```python
    def _set_workspace_for(self, workspace_path: str) -> None:
        """Inject `workspace_path` into the CURRENT thread's contextvars.

        Mirrors _set_workspace but for an explicit path (used by run_headless so
        a background task runs in its own workspace without disturbing the
        foreground conversation's contextvars, which are per-thread).
        """
        from .workspace import _app_data_dir, session_id_for
        try:
            from floodmind.agent.runtime.services.workspace_service import (
                build_workspace,
                set_workspace,
            )
            from floodmind.tools import set_session_context

            sid = session_id_for(workspace_path)
            ws = build_workspace(
                sid,
                session_root=_app_data_dir(),
                user_dir=workspace_path,
                sandbox_strategy="user_dir",
            )
            set_workspace(ws.ensure())
            set_session_context(sid, output_dir=str(ws.user_dir))
        except Exception as e:
            print(f"[sidecar] _set_workspace_for failed for {workspace_path}: {e}", file=sys.stderr)

    def run_headless(self, session_id: str, workspace_path: str, command: str):
        """Execute `command` in an isolated background session.

        Builds a FRESH agent (does not touch self._agent), sets the task's
        workspace in this thread's contextvars, streams the command, and returns
        (events, artifacts, final_text). Any failure is folded into an error
        event so the caller can record complete_task(success=False).
        """
        events: list[dict] = []
        artifacts: list[dict] = []
        final_text = ""
        try:
            self._set_workspace_for(workspace_path)
            sid, persist_dir = self._memory_target(session_id)
            agent = self._build_agent(sid, persist_dir)
            for raw in agent.stream(command):
                for ev in translate_event(raw):
                    if ev.get("type") == "done":
                        continue
                    events.append(ev)
                    if ev.get("type") == "artifact":
                        artifacts.append(
                            {"kind": ev.get("kind", "file"),
                             "name": ev.get("name", ""),
                             "path": ev.get("path", "")}
                        )
                    elif ev.get("type") == "text":
                        final_text += ev.get("content", "")
        except Exception as e:
            events.append({"type": "error", "content": f"后台执行出错：{e}"})
        return events, artifacts, final_text
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `python -m pytest sidecar/tests/test_floodmind_agent.py -v`
Expected: PASS (all, including the 2 new run_headless tests).

- [ ] **Step 6: Commit**

```bash
git add sidecar/floodmind_desktop_sidecar/agent.py sidecar/floodmind_desktop_sidecar/floodmind_agent.py sidecar/tests/test_floodmind_agent.py
git commit -m "feat(sidecar): FloodMindAgent.run_headless (isolated background task execution)"
```

---

## Task 4: ScheduledRunner (poll loop + worker + reclaim)

**Files:**
- Create: `sidecar/floodmind_desktop_sidecar/scheduled_runner.py`
- Test: `sidecar/tests/test_scheduled_runner.py`

**Interfaces:**
- Consumes: `ScheduledTaskRuntime` (`list_tasks`, `update_task`, `complete_task`), `TaskIndex` (`get`), `TaskRunStore` (`create`/`finalize`), `Agent.run_headless`.
- Produces: pure helpers `_due_tasks(tasks, now_iso) -> list[dict]` and `_execute_task(runtime, run_store, agent, task, workspace_path, run_id=None) -> dict`; class `ScheduledRunner(runtime, index, run_store, agent, poll_seconds=30)` with `start()` (reclaim + daemon loop) and `run_now(task_id) -> str|None`.

- [ ] **Step 1: Write the failing tests**

Create `sidecar/tests/test_scheduled_runner.py`:

```python
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python -m pytest sidecar/tests/test_scheduled_runner.py -v`
Expected: FAIL — `ModuleNotFoundError`.

- [ ] **Step 3: Implement the runner**

Create `sidecar/floodmind_desktop_sidecar/scheduled_runner.py`:

```python
"""Background runner for scheduled tasks.

Pure helpers (_due_tasks, _execute_task) are unit-tested with fakes; the
ScheduledRunner poll/worker loop is thin glue around them. Execution runs in
isolated threads — run_headless sets the task's workspace in the worker
thread's own contextvars, so it never disturbs the foreground conversation.
"""
from __future__ import annotations

import threading
import uuid
from datetime import datetime
from typing import Callable, Optional


def _now_iso() -> str:
    return datetime.now().replace(microsecond=0).isoformat()


def _due_tasks(tasks: list[dict], now_iso: str) -> list[dict]:
    """Enabled, past-due, not-currently-running tasks (ISO next_run_at <= now)."""
    out = []
    for t in tasks:
        if not t.get("enabled", True):
            continue
        if t.get("status") == "running":
            continue
        nr = str(t.get("next_run_at") or "").strip()
        if nr and nr <= now_iso:
            out.append(t)
    return out


def _execute_task(runtime, run_store, agent, task: dict, workspace_path: str,
                  run_id: Optional[str] = None) -> dict:
    """Run one task synchronously: record run, run_headless, complete_task, finalize.

    The caller is responsible for having claimed the task (status='running').
    """
    run_id = run_id or ("run-" + uuid.uuid4().hex[:12])
    run = {
        "run_id": run_id,
        "task_id": task["id"],
        "started_at": _now_iso(),
        "finished_at": "",
        "status": "running",
        "events": [],
        "artifacts": [],
    }
    run_store.create(run)
    try:
        events, artifacts, final_text = agent.run_headless(
            task.get("session_id", ""), workspace_path, task.get("command", "")
        )
    except Exception as e:  # run_headless already folds errors, but be defensive
        events = [{"type": "error", "content": f"后台执行出错：{e}"}]
        artifacts = []
        final_text = ""

    success = not any(e.get("type") == "error" for e in events)
    if success:
        runtime.complete_task(task["id"], success=True, result=final_text[:4000], artifacts=artifacts)
    else:
        err = next((e.get("content", "") for e in events if e.get("type") == "error"), "")
        runtime.complete_task(task["id"], success=False, error=err[:4000])

    run["events"] = events
    run["artifacts"] = artifacts
    run["status"] = "completed" if success else "failed"
    run["finished_at"] = _now_iso()
    run_store.finalize(run)
    return run


class ScheduledRunner:
    def __init__(self, runtime, index, run_store, agent, poll_seconds: int = 30):
        self._runtime = runtime
        self._index = index
        self._run_store = run_store
        self._agent = agent
        self._poll_seconds = poll_seconds
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None

    def start(self) -> None:
        # Reclaim tasks stuck in 'running' from a prior sidecar crash.
        for t in self._runtime.list_tasks(""):
            if t.get("status") == "running":
                try:
                    self._runtime.update_task(t["id"], status="pending")
                except Exception:
                    pass
        self._thread = threading.Thread(target=self._loop, daemon=True, name="sched-runner")
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()

    def _loop(self) -> None:
        while not self._stop.is_set():
            try:
                self._tick()
            except Exception as e:  # pragma: no cover - defensive
                import sys
                print(f"[sidecar] scheduled-runner tick failed: {e}", file=sys.stderr)
            self._stop.wait(self._poll_seconds)

    def _tick(self) -> None:
        now = _now_iso()
        for task in _due_tasks(self._runtime.list_tasks(""), now):
            workspace_path = self._index.get(task["id"])
            if not workspace_path:
                try:
                    self._runtime.complete_task(task["id"], success=False, error="workspace unknown")
                except Exception:
                    pass
                continue
            # Claim synchronously (single-threaded poll -> no double-spawn race).
            try:
                self._runtime.update_task(task["id"], status="running")
            except Exception:
                continue
            threading.Thread(
                target=_execute_task,
                args=(self._runtime, self._run_store, self._agent, task, workspace_path),
                daemon=True,
                name=f"task-{task['id'][:8]}",
            ).start()

    def run_now(self, task_id: str) -> Optional[str]:
        """Trigger a task immediately. Returns run_id, or None if not runnable."""
        task = self._runtime.get_task(task_id)
        if not task or task.get("status") == "running":
            return None
        workspace_path = self._index.get(task_id)
        if not workspace_path:
            return None
        try:
            self._runtime.update_task(task_id, status="running")
        except Exception:
            return None
        run_id = "run-" + uuid.uuid4().hex[:12]
        threading.Thread(
            target=_execute_task,
            args=(self._runtime, self._run_store, self._agent, task, workspace_path, run_id),
            daemon=True,
            name=f"task-now-{task_id[:8]}",
        ).start()
        return run_id
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `python -m pytest sidecar/tests/test_scheduled_runner.py -v`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add sidecar/floodmind_desktop_sidecar/scheduled_runner.py sidecar/tests/test_scheduled_runner.py
git commit -m "feat(sidecar): ScheduledRunner (poll loop + isolated worker + reclaim)"
```

---

## Task 5: Scheduled-task API endpoints + runner wiring

**Files:**
- Modify: `sidecar/floodmind_desktop_sidecar/app.py`
- Create: `sidecar/tests/test_scheduled_tasks_api.py`

**Interfaces:**
- Consumes: `ScheduledTaskRuntime`, `TaskIndex`, `TaskRunStore`, `ScheduledRunner` (Tasks 1-4).
- Produces: 7 endpoints (see table); `create_app` gains params `task_runtime=None`, `task_index=None`, `task_run_store=None`, `task_runner=None`, `start_runner=True`. `__main__.py` unchanged (defaults).

- [ ] **Step 1: Write the failing endpoint tests**

Create `sidecar/tests/test_scheduled_tasks_api.py`:

```python
import json

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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python -m pytest sidecar/tests/test_scheduled_tasks_api.py -v`
Expected: FAIL — 404 on `/api/scheduled-tasks`.

- [ ] **Step 3: Add endpoints + wiring to create_app**

In `sidecar/floodmind_desktop_sidecar/app.py`:

Change the `create_app` signature to:

```python
def create_app(agent: Agent, workspace_manager=None, conversation_store=None,
               title_spawner=None, task_runtime=None, task_index=None,
               task_run_store=None, task_runner=None, start_runner=True) -> Flask:
```

Right after the `CORS(...)` call (and after the conversation_store/title_spawner default block), add:

```python
    if task_runtime is None:
        from floodmind.agent.scheduled_task_runtime import get_scheduled_task_runtime
        task_runtime = get_scheduled_task_runtime()
    if task_index is None:
        from .task_index import TaskIndex
        from .workspace import _app_data_dir
        task_index = TaskIndex(_app_data_dir())
    if task_run_store is None:
        from .task_run_store import TaskRunStore
        from .workspace import _app_data_dir
        task_run_store = TaskRunStore(_app_data_dir())
    if task_runner is None and start_runner:
        from .scheduled_runner import ScheduledRunner
        task_runner = ScheduledRunner(task_runtime, task_index, task_run_store, agent)
        task_runner.start()
```

Add the routes (e.g. after the conversation routes, before the Skills section):

```python
    # ── Scheduled tasks ───────────────────────────────────────
    @app.get("/api/scheduled-tasks")
    def scheduled_tasks_list():
        ws = request.args.get("workspace", "")
        tasks = task_runtime.list_tasks("")
        if ws:
            index = task_index.all()
            tasks = [t for t in tasks if index.get(t["id"]) == ws]
        return jsonify({"tasks": tasks})

    @app.post("/api/scheduled-tasks")
    def scheduled_tasks_create():
        body = request.get_json(silent=True) or {}
        ws = body.get("workspace", "")
        command = str(body.get("command", "")).strip()
        repeat = str(body.get("repeat", "none")).strip().lower()
        run_time = body.get("run_time", "")
        scheduled_at = body.get("scheduled_at", "")
        if not ws or not command:
            return jsonify({"error": "workspace and command required"}), 400
        if repeat == "daily" and not run_time:
            return jsonify({"error": "daily tasks require run_time"}), 400
        if repeat == "none" and not scheduled_at:
            return jsonify({"error": "one-shot tasks require scheduled_at"}), 400
        try:
            import uuid
            task = task_runtime.create_task(
                session_id=uuid.uuid4().hex,
                command=command,
                repeat=repeat,
                run_time=run_time,
                scheduled_at=scheduled_at,
                timezone=body.get("timezone", "Asia/Shanghai"),
                enabled=bool(body.get("enabled", True)),
            )
        except Exception as e:
            return jsonify({"error": str(e)}), 400
        task_index.set(task["id"], ws)
        return jsonify(task)

    @app.get("/api/scheduled-tasks/<task_id>")
    def scheduled_tasks_get(task_id):
        task = task_runtime.get_task(task_id)
        if not task:
            return jsonify({"error": "not found"}), 404
        return jsonify(task)

    @app.patch("/api/scheduled-tasks/<task_id>")
    def scheduled_tasks_update(task_id):
        body = request.get_json(silent=True) or {}
        updates = {k: body[k] for k in
                   ("command", "enabled", "run_time", "scheduled_at", "repeat", "status")
                   if k in body}
        try:
            task = task_runtime.update_task(task_id, **updates)
        except Exception as e:
            return jsonify({"error": str(e)}), 400
        return jsonify({"task": task})

    @app.delete("/api/scheduled-tasks/<task_id>")
    def scheduled_tasks_delete(task_id):
        try:
            task_runtime.delete_task(task_id)
        except Exception as e:
            return jsonify({"error": str(e)}), 400
        task_index.remove(task_id)
        return jsonify({"ok": True})

    @app.post("/api/scheduled-tasks/<task_id>/run")
    def scheduled_tasks_run_now(task_id):
        if task_runner is None:
            return jsonify({"error": "runner not available"}), 503
        run_id = task_runner.run_now(task_id)
        if run_id is None:
            return jsonify({"error": "task not runnable (missing, already running, or no workspace)"}), 409
        return jsonify({"run_id": run_id})

    @app.get("/api/scheduled-tasks/<task_id>/runs")
    def scheduled_tasks_runs(task_id):
        return jsonify({"runs": task_run_store.list(task_id)})

    @app.get("/api/scheduled-tasks/<task_id>/runs/<run_id>")
    def scheduled_tasks_run_detail(task_id, run_id):
        run = task_run_store.get(task_id, run_id)
        if run is None:
            return jsonify({"error": "not found"}), 404
        return jsonify(run)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `python -m pytest sidecar/tests/test_scheduled_tasks_api.py sidecar/tests -v`
Expected: PASS (new tests + all existing sidecar tests green).

- [ ] **Step 5: Commit**

```bash
git add sidecar/floodmind_desktop_sidecar/app.py sidecar/tests/test_scheduled_tasks_api.py
git commit -m "feat(sidecar): scheduled-task CRUD/run-now/run-history endpoints + runner wiring"
```

---

## Task 6: Frontend scheduled-task-store

**Files:**
- Create: `src/state/scheduled-task-store.ts`
- Create: `src/state/scheduled-task-store.test.ts`

**Interfaces:**
- Consumes: `getBaseUrl`.
- Produces: `useScheduledTaskStore` with `tasks`, `runs`, `currentRun`, and actions `load(workspace)`, `create(body)`, `update(id, patch)`, `remove(id)`, `runNow(id)`, `loadRuns(id)`, `loadRun(id, runId)`. Types `SchedTask`, `RunSummary`, `RunDetail`.

- [ ] **Step 1: Write the failing tests**

Create `src/state/scheduled-task-store.test.ts`:

```typescript
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
    expect(String(fetchMock.mock.calls[0][0])).toContain("/api/scheduled-tasks?workspace=");
    vi.unstubAllGlobals();
  });

  it("create POSTs and returns the task", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ id: "sched_b", command: "x" }), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);
    const t = await useScheduledTaskStore.getState().create({ workspace: "/ws/A", command: "x", repeat: "none", scheduled_at: "2099-01-01T00:00:00" });
    expect(t?.id).toBe("sched_b");
    const init = fetchMock.mock.calls[0][1] as RequestInit;
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- scheduled-task-store`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the store**

Create `src/state/scheduled-task-store.ts`:

```typescript
import { create } from "zustand";
import { getBaseUrl } from "../lib/sidecar-client";

export interface SchedTask {
  id: string;
  session_id: string;
  command: string;
  repeat: "none" | "daily";
  enabled: boolean;
  run_time: string;
  scheduled_at: string;
  timezone: string;
  next_run_at: string;
  status: string;
  last_status: string;
  last_run_at: string;
  last_finished_at: string;
  last_result: string;
  last_error: string;
  artifacts: { kind: string; name: string; path: string }[];
  attempt_count: number;
  created_at: string;
  updated_at: string;
}
export interface RunSummary {
  run_id: string;
  started_at: string;
  finished_at: string;
  status: string;
}
export interface RunDetail extends RunSummary {
  task_id: string;
  events: unknown[];
  artifacts: { kind: string; name: string; path: string }[];
}

export interface TaskCreateBody {
  workspace: string;
  command: string;
  repeat: "none" | "daily";
  run_time?: string;
  scheduled_at?: string;
  timezone?: string;
  enabled?: boolean;
}

interface State {
  tasks: SchedTask[];
  runs: RunSummary[];
  currentRun: RunDetail | null;
  load: (workspace: string) => Promise<SchedTask[]>;
  create: (body: TaskCreateBody) => Promise<SchedTask | null>;
  update: (id: string, patch: Record<string, unknown>) => Promise<SchedTask | null>;
  remove: (id: string) => Promise<boolean>;
  runNow: (id: string) => Promise<string | null>;
  loadRuns: (id: string) => Promise<RunSummary[]>;
  loadRun: (id: string, runId: string) => Promise<RunDetail | null>;
}

async function getJson(url: string, init?: RequestInit): Promise<any | null> {
  try {
    const b = await getBaseUrl();
    const r = await fetch(`${b}${url}`, init);
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

export const useScheduledTaskStore = create<State>((set) => ({
  tasks: [],
  runs: [],
  currentRun: null,

  async load(workspace) {
    const data = await getJson(`/api/scheduled-tasks?workspace=${encodeURIComponent(workspace)}`);
    const tasks: SchedTask[] = (data && data.tasks) || [];
    set({ tasks });
    return tasks;
  },

  create(body) {
    return getJson("/api/scheduled-tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  },

  async update(id, patch) {
    const v = await getJson(`/api/scheduled-tasks/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    return v?.task ?? null;
  },

  async remove(id) {
    const v = await getJson(`/api/scheduled-tasks/${encodeURIComponent(id)}`, { method: "DELETE" });
    return v !== null;
  },

  async runNow(id) {
    const v = await getJson(`/api/scheduled-tasks/${encodeURIComponent(id)}/run`, { method: "POST" });
    return v?.run_id ?? null;
  },

  async loadRuns(id) {
    const data = await getJson(`/api/scheduled-tasks/${encodeURIComponent(id)}/runs`);
    const runs: RunSummary[] = (data && data.runs) || [];
    set({ runs });
    return runs;
  },

  async loadRun(id, runId) {
    const run = await getJson(`/api/scheduled-tasks/${encodeURIComponent(id)}/runs/${encodeURIComponent(runId)}`);
    set({ currentRun: run });
    return run;
  },
}));
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- scheduled-task-store`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/state/scheduled-task-store.ts src/state/scheduled-task-store.test.ts
git commit -m "feat(ui): scheduled-task-store (sidecar scheduled-task API client)"
```

---

## Task 7: UI routing + Sidebar "定时任务" (replaces 最近) + TaskEditModal

**Files:**
- Modify: `src/state/ui-store.ts`
- Modify: `src/components/Sidebar.tsx`
- Create: `src/components/TaskEditModal.tsx`
- Modify: `src/App.tsx`

**Interfaces:**
- Consumes: `useScheduledTaskStore` (Task 6), `useWorkspaceStore`, `useChatStore`.
- Produces: ui-store view `'tasks'` + `selectedTaskId`; Sidebar 定时任务 section (list + open-create-modal + click→open detail); `TaskEditModal` (create/edit).

- [ ] **Step 1: Extend ui-store**

In `src/state/ui-store.ts`, replace the file with:

```typescript
import { create } from "zustand";

export type View = "chat" | "skills" | "mcp" | "settings" | "tasks";

interface UiState {
  view: View;
  selectedTaskId: string | null;
  setView: (v: View) => void;
  setSelectedTaskId: (id: string | null) => void;
}

export const useUiStore = create<UiState>((set) => ({
  view: "chat",
  selectedTaskId: null,
  setView: (view) => set({ view }),
  setSelectedTaskId: (selectedTaskId) => set({ selectedTaskId }),
}));
```

- [ ] **Step 2: Create TaskEditModal**

Create `src/components/TaskEditModal.tsx`:

```typescript
import { useState } from "react";
import { useScheduledTaskStore, type SchedTask, type TaskCreateBody } from "../state/scheduled-task-store";

interface Props {
  workspace: string;
  editing: SchedTask | null;   // null = create mode
  onClose: () => void;
}

export default function TaskEditModal({ workspace, editing, onClose }: Props) {
  const create = useScheduledTaskStore((s) => s.create);
  const update = useScheduledTaskStore((s) => s.update);
  const [command, setCommand] = useState(editing?.command ?? "");
  const [repeat, setRepeat] = useState<"none" | "daily">(editing?.repeat ?? "none");
  const [runTime, setRunTime] = useState(editing?.run_time ?? "09:00");
  const [scheduledAt, setScheduledAt] = useState(
    editing?.scheduled_at ?? new Date(Date.now() + 3600_000).toISOString().slice(0, 16)
  );
  const [enabled, setEnabled] = useState(editing?.enabled ?? true);
  const [error, setError] = useState("");

  async function save() {
    if (!command.trim()) return setError("请填写任务描述");
    if (repeat === "daily" && !runTime) return setError("每日任务需要运行时间");
    if (repeat === "none" && !scheduledAt) return setError("一次性任务需要执行时间");
    if (editing) {
      await update(editing.id, { command, repeat, run_time: runTime, scheduled_at: scheduledAt, enabled });
    } else {
      const body: TaskCreateBody = { workspace, command, repeat, enabled };
      if (repeat === "daily") body.run_time = runTime;
      else body.scheduled_at = scheduledAt;
      await create(body);
    }
    onClose();
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-title">{editing ? "编辑定时任务" : "新建定时任务"}</div>
        <label className="modal-label">任务描述（给 FloodMind 的指令）</label>
        <textarea className="modal-textarea" rows={4} value={command}
          onChange={(e) => setCommand(e.target.value)} placeholder="例如：生成上周销售周报" />
        <div className="modal-row">
          <label><input type="radio" checked={repeat === "none"} onChange={() => setRepeat("none")} /> 一次性</label>
          <label><input type="radio" checked={repeat === "daily"} onChange={() => setRepeat("daily")} /> 每日</label>
        </div>
        {repeat === "daily" ? (
          <label className="modal-label">运行时间
            <input type="time" value={runTime} onChange={(e) => setRunTime(e.target.value)} />
          </label>
        ) : (
          <label className="modal-label">执行时间
            <input type="datetime-local" value={scheduledAt} onChange={(e) => setScheduledAt(e.target.value)} />
          </label>
        )}
        <label className="modal-row">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> 启用
        </label>
        {error && <div className="modal-error">{error}</div>}
        <div className="modal-actions">
          <button className="btn-secondary" onClick={onClose} type="button">取消</button>
          <button className="btn-primary" onClick={save} type="button">保存</button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Replace 最近 with 定时任务 in Sidebar**

In `src/components/Sidebar.tsx`:

Add imports:

```typescript
import { useScheduledTaskStore } from "../state/scheduled-task-store";
import TaskEditModal from "./TaskEditModal";
```

Inside the component, replace the existing `switchable`/recent logic with scheduled-task hooks (and remove the now-unused `recent`/`openPath` if they are only used by 最近 — but keep `openPath` if used elsewhere; read the file and only remove the 最近 JSX block). Add:

```typescript
  const tasks = useScheduledTaskStore((s) => s.tasks);
  const loadTasks = useScheduledTaskStore((s) => s.load);
  const setView = useUiStore((s) => s.setView);
  const setSelectedTaskId = useUiStore((s) => s.setSelectedTaskId);
  const [taskModalOpen, setTaskModalOpen] = useState(false);
```

Add an effect to load tasks for the current workspace (alongside the existing workspace effects):

```typescript
  useEffect(() => {
    if (current) loadTasks(current.path);
  }, [current?.path]);
```

**Remove the entire `{/* 最近 — above 工作区 per user preference */}` section** (the `switchable.length > 0` block with the 最近 label and workspace-switch buttons) and **replace it** with:

```tsx
      {current && (
        <div className="sidebar-section">
          <div className="sidebar-label">
            定时任务
            <button className="label-add" onClick={() => setTaskModalOpen(true)} type="button" title="新建定时任务">＋</button>
          </div>
          {tasks.length === 0 && <div className="tree-empty">暂无定时任务</div>}
          {tasks.map((t) => (
            <button
              key={t.id}
              className="sidebar-item task-item"
              onClick={() => { setSelectedTaskId(t.id); setView("tasks"); }}
              title={t.command}
              type="button"
            >
              <span className={"task-dot task-" + t.status} aria-hidden="true" />
              <span className="item-name">{t.command}</span>
            </button>
          ))}
        </div>
      )}
```

At the end of the returned `<aside>`, mount the modal:

```tsx
      {taskModalOpen && current && (
        <TaskEditModal workspace={current.path} editing={null} onClose={() => setTaskModalOpen(false)} />
      )}
```

- [ ] **Step 4: Wire App routing + load tasks on workspace change**

In `src/App.tsx`, add the scheduled-task load to the existing workspace effect and render the view. The effect currently loads conversations on `currentPath`; extend it to also load scheduled tasks, and add the `view === "tasks"` branch:

```typescript
import { useEffect } from "react";
import Composer from "./components/Composer";
import Conversation from "./components/Conversation";
import McpView from "./components/McpView";
import ScheduledTasksView from "./components/ScheduledTasksView";
import SettingsView from "./components/SettingsView";
import Sidebar from "./components/Sidebar";
import SkillsView from "./components/SkillsView";
import TopBar from "./components/TopBar";
import { useUiStore } from "./state/ui-store";
import { useWorkspaceStore } from "./state/workspace-store";
import { useConversationStore } from "./state/conversation-store";
import { useChatStore } from "./state/chat-store";
import { useScheduledTaskStore } from "./state/scheduled-task-store";

export default function App() {
  const view = useUiStore((s) => s.view);
  const currentPath = useWorkspaceStore((s) => s.current?.path);

  useEffect(() => {
    if (!currentPath) return;
    useScheduledTaskStore.getState().load(currentPath);   // sidebar list
    let stale = false;
    (async () => {
      const items = await useConversationStore.getState().loadList(currentPath);
      if (stale) return;
      const active = items.find((i) => i.active);
      if (active) await useChatStore.getState().loadConversation(active.id);
      else if (items.length > 0) await useChatStore.getState().loadConversation(items[0].id);
      else await useChatStore.getState().startNew(currentPath);
    })();
    return () => { stale = true; };
  }, [currentPath]);

  return (
    <div className="app">
      <Sidebar />
      <div className="main">
        {view === "chat" && (
          <>
            <TopBar />
            <Conversation />
            <Composer />
          </>
        )}
        {view === "tasks" && <ScheduledTasksView />}
        {view === "skills" && <SkillsView />}
        {view === "mcp" && <McpView />}
        {view === "settings" && <SettingsView />}
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Add CSS**

Append to `src/app.css`:

```css
.label-add {
  margin-left: auto;
  background: none;
  border: none;
  color: var(--muted, #9ca3af);
  cursor: pointer;
  font-size: 14px;
  line-height: 1;
  padding: 0 2px;
}
.label-add:hover { color: var(--accent, #0d9488); }
.task-item { gap: 6px; }
.task-dot {
  flex: 0 0 7px;
  width: 7px; height: 7px;
  border-radius: 50%;
  background: #9ca3af;
}
.task-dot.task-running { background: #0d9488; }
.task-dot.task-completed { background: #22c55e; }
.task-dot.task-failed { background: #ef4444; }
.task-dot.task-disabled { background: #d1d5db; }
.modal-overlay {
  position: fixed; inset: 0;
  background: rgba(0,0,0,0.4);
  display: flex; align-items: center; justify-content: center;
  z-index: 50;
}
.modal-card {
  background: var(--surface, #fff);
  color: var(--text, #111);
  border-radius: 12px;
  padding: 20px;
  width: 460px;
  max-width: calc(100vw - 32px);
  box-shadow: 0 10px 40px rgba(0,0,0,0.2);
  display: flex; flex-direction: column; gap: 10px;
}
.modal-title { font-weight: 600; font-size: 16px; }
.modal-label { font-size: 13px; display: flex; flex-direction: column; gap: 4px; }
.modal-textarea { resize: vertical; font: inherit; padding: 8px; border: 1px solid var(--border, #e5e7eb); border-radius: 8px; }
.modal-row { display: flex; gap: 16px; font-size: 13px; }
.modal-error { color: #ef4444; font-size: 13px; }
.modal-actions { display: flex; justify-content: flex-end; gap: 8px; }
.modal-actions .btn-primary { background: var(--accent, #0d9488); color: #fff; border: none; padding: 8px 14px; border-radius: 8px; cursor: pointer; }
.modal-actions .btn-secondary { background: transparent; border: 1px solid var(--border, #e5e7eb); padding: 8px 14px; border-radius: 8px; cursor: pointer; }
```

- [ ] **Step 6: Build + test**

Run: `npm run build && npm test`
Expected: build succeeds; all vitest green. (`ScheduledTasksView` is referenced by App — create a placeholder import in Step 4 only if Task 8 hasn't run; but since Task 8 follows this task, **defer the `view === "tasks"` branch + the `ScheduledTasksView` import to Task 8**, or create a stub `ScheduledTasksView` here. To keep this task independently buildable, create a minimal placeholder `src/components/ScheduledTasksView.tsx` now:)

Create `src/components/ScheduledTasksView.tsx` (placeholder, replaced in Task 8):

```typescript
export default function ScheduledTasksView() {
  return <div className="tasks-view"><div className="empty-hint"><div className="big">定时任务</div></div></div>;
}
```

Then the build passes; Task 8 fills it in.

- [ ] **Step 7: Commit**

```bash
git add src/state/ui-store.ts src/components/Sidebar.tsx src/components/TaskEditModal.tsx src/components/ScheduledTasksView.tsx src/App.tsx src/app.css
git commit -m "feat(ui): sidebar 定时任务 (replaces 最近) + create/edit modal + tasks view route"
```

---

## Task 8: ScheduledTasksView — run history + transcript replay

**Files:**
- Modify: `src/components/ScheduledTasksView.tsx` (replace placeholder)

**Interfaces:**
- Consumes: `useScheduledTaskStore` (tasks/runs/currentRun + loadRuns/loadRun/runNow/update), `useUiStore` (selectedTaskId/setView), `reduceEvent` + `AssistantTurn` from chat-store, `BlockView`, `Logo`.

- [ ] **Step 1: Replace the placeholder with the full view**

Replace `src/components/ScheduledTasksView.tsx`:

```typescript
import { useEffect, useMemo, useState } from "react";
import { useScheduledTaskStore, type SchedTask } from "../state/scheduled-task-store";
import { useUiStore } from "../state/ui-store";
import { useWorkspaceStore } from "../state/workspace-store";
import { reduceEvent, type AssistantTurn, type Block } from "../state/chat-store";
import BlockView from "./BlockView";
import TaskEditModal from "./TaskEditModal";

function emptyTurn(): AssistantTurn {
  return { role: "assistant", blocks: [], usage: null, done: false };
}

/** Replay a run's stored events through reduceEvent → blocks (reuses chat rendering). */
function replay(events: unknown[]): Block[] {
  let turn = emptyTurn();
  for (const ev of events as any[]) turn = reduceEvent(turn, ev) as AssistantTurn;
  return turn.blocks;
}

export default function ScheduledTasksView() {
  const selectedTaskId = useUiStore((s) => s.selectedTaskId);
  const setSelectedTaskId = useUiStore((s) => s.setSelectedTaskId);
  const setView = useUiStore((s) => s.setView);
  const currentPath = useWorkspaceStore((s) => s.current?.path);
  const tasks = useScheduledTaskStore((s) => s.tasks);
  const runs = useScheduledTaskStore((s) => s.runs);
  const currentRun = useScheduledTaskStore((s) => s.currentRun);
  const loadRuns = useScheduledTaskStore((s) => s.loadRuns);
  const loadRun = useScheduledTaskStore((s) => s.loadRun);
  const runNow = useScheduledTaskStore((s) => s.runNow);
  const update = useScheduledTaskStore((s) => s.update);
  const [editing, setEditing] = useState<SchedTask | null>(null);

  const task = useMemo(() => tasks.find((t) => t.id === selectedTaskId) ?? null, [tasks, selectedTaskId]);

  useEffect(() => {
    if (selectedTaskId) loadRuns(selectedTaskId);
  }, [selectedTaskId, task?.status]);

  const blocks = useMemo(
    () => (currentRun ? replay(currentRun.events) : []),
    [currentRun]
  );

  return (
    <div className="tasks-view">
      <div className="tasks-header">
        <button className="btn-secondary" onClick={() => setView("chat")} type="button">← 返回对话</button>
        <span className="tasks-note">任务在 app 开启时自动执行；关闭期间错过的会在下次开启时补跑。</span>
      </div>

      {!task && <div className="empty-hint"><div className="big">选择左侧一个定时任务</div></div>}

      {task && (
        <>
          <div className="task-detail-head">
            <div className="task-detail-command">{task.command}</div>
            <div className="task-detail-meta">
              {task.repeat === "daily" ? `每日 ${task.run_time}` : `一次性 ${task.scheduled_at}`}
              {" · 状态 "}<strong>{task.status}</strong>
              {task.last_error && <span className="task-err"> · {task.last_error}</span>}
            </div>
            <div className="task-detail-actions">
              <button onClick={() => runNow(task.id)} type="button" className="btn-primary">立即运行</button>
              <button onClick={() => setEditing(task)} type="button" className="btn-secondary">编辑</button>
              <button onClick={() => update(task.id, { enabled: !task.enabled })} type="button" className="btn-secondary">
                {task.enabled ? "停用" : "启用"}
              </button>
            </div>
          </div>

          <div className="task-runs">
            <div className="sidebar-label">运行历史</div>
            {runs.length === 0 && <div className="tree-empty">还没有运行记录</div>}
            {runs.map((r) => (
              <button
                key={r.run_id}
                className={currentRun?.run_id === r.run_id ? "sidebar-item active" : "sidebar-item"}
                onClick={() => loadRun(task.id, r.run_id)}
                type="button"
              >
                <span className={"task-dot task-" + r.status} />
                <span className="item-name">{r.started_at} · {r.status}</span>
              </button>
            ))}
          </div>

          {currentRun && (
            <div className="task-run-transcript">
              <div className="sidebar-label">执行过程</div>
              {blocks.length === 0 && <div className="tree-empty">（无内容）</div>}
              {blocks.map((b) => <BlockView key={(b as any).id} block={b as Block} isLive={false} />)}
              {currentRun.artifacts.length > 0 && (
                <div className="task-artifacts">
                  <div className="sidebar-label">产物</div>
                  {currentRun.artifacts.map((a) => (
                    <div key={a.path} className="task-artifact">{a.name}</div>
                  ))}
                </div>
              )}
            </div>
          )}
        </>
      )}

      {editing && currentPath && (
        <TaskEditModal workspace={currentPath} editing={editing} onClose={() => setEditing(null)} />
      )}
    </div>
  );
}
```

- [ ] **Step 2: Add view CSS**

Append to `src/app.css`:

```css
.tasks-view { padding: 16px 20px; overflow-y: auto; height: 100%; display: flex; flex-direction: column; gap: 12px; }
.tasks-header { display: flex; align-items: center; gap: 12px; }
.tasks-note { font-size: 12px; color: var(--muted, #9ca3af); }
.task-detail-head { display: flex; flex-direction: column; gap: 6px; padding-bottom: 10px; border-bottom: 1px solid var(--border, #e5e7eb); }
.task-detail-command { font-weight: 600; font-size: 15px; }
.task-detail-meta { font-size: 13px; color: var(--muted, #6b7280); }
.task-err { color: #ef4444; }
.task-detail-actions { display: flex; gap: 8px; }
.task-detail-actions .btn-primary { background: var(--accent, #0d9488); color: #fff; border: none; padding: 6px 12px; border-radius: 8px; cursor: pointer; }
.task-detail-actions .btn-secondary { background: transparent; border: 1px solid var(--border, #e5e7eb); padding: 6px 12px; border-radius: 8px; cursor: pointer; }
.task-runs, .task-run-transcript { display: flex; flex-direction: column; gap: 4px; }
.task-artifacts { margin-top: 8px; }
.task-artifact { font-family: var(--mono, monospace); font-size: 13px; padding: 2px 0; }
```

- [ ] **Step 3: Build + test**

Run: `npm run build && npm test`
Expected: build succeeds; all vitest green.

- [ ] **Step 4: Commit**

```bash
git add src/components/ScheduledTasksView.tsx src/app.css
git commit -m "feat(ui): ScheduledTasksView — run history + transcript replay via BlockView"
```

---

## Task 9: End-to-end verification

**Files:** none (verification only).

- [ ] **Step 1: Full sidecar suite**

Run: `python -m pytest sidecar/tests -v`
Expected: all green (existing + new task-index/run-store/runner/api/agent tests).

- [ ] **Step 2: Full frontend build + tests**

Run: `npm run build && npm test`
Expected: build OK; all vitest green.

- [ ] **Step 3: Real-SDK smoke (`npm run tauri dev`, Agent_desktop conda env)**

Manual checklist (isolation + reliability can only be proven with the real SDK):
1. Open a workspace → sidebar shows "定时任务" (replacing 最近); "暂无定时任务" until you create one.
2. Create a one-shot task ~1 min out → at its time it fires automatically; a run record appears; clicking it shows the full block transcript + artifacts. The foreground chat was unaffected during the run.
3. Create a daily task (e.g., run_time = next minute) → it fires at the time; confirm it reschedules to tomorrow (next_run_at updated).
4. "立即运行" → runs immediately + transcript appears.
5. Close the app before a due one-shot, reopen after its time → catch-up fires it shortly after launch.
6. While a task is running, send a foreground chat message → both proceed without corrupting each other (contextvar isolation).

- [ ] **Step 4: Commit smoke-fixes if any**

Only if Step 3 surfaced a bug — fix under a focused commit and re-run the relevant tier.

---

## Out of scope (later)

- OS-level scheduling (fire while the app is closed) — platform daemon, separate effort.
- Cron schedules (SDK supports only none/daily).
- Run retention / pruning.
- Completion notifications.
