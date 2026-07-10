"""Background runner for scheduled tasks.

Pure helpers (_due_tasks, _execute_task) are unit-tested with fakes; the
ScheduledRunner poll/worker loop is thin glue around them. Execution runs in
isolated threads — run_headless sets the task's workspace in the worker
thread's own contextvars, so it never disturbs the foreground conversation.
"""
from __future__ import annotations

import threading
import uuid
from datetime import datetime, timezone
from zoneinfo import ZoneInfo


def _now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def _due_tasks(tasks: list[dict], now_iso: str) -> list[dict]:
    """Enabled, past-due, not-currently-running tasks (next_run_at <= now).

    `next_run_at` is produced by the SDK in the task's `timezone`. `now_iso`
    is UTC. Both are normalized to UTC before comparison so the runner fires at
    the correct wall-clock time regardless of the system timezone.
    """
    now = datetime.fromisoformat(now_iso)
    if now.tzinfo is None:
        now = now.replace(tzinfo=timezone.utc)
    now_utc = now.astimezone(timezone.utc)

    out = []
    for t in tasks:
        if not t.get("enabled", True):
            continue
        if t.get("status") == "running":
            continue
        nr = str(t.get("next_run_at") or "").strip()
        if not nr:
            continue
        try:
            next_run = datetime.fromisoformat(nr)
        except ValueError:
            continue
        tz_name = t.get("timezone") or "UTC"
        try:
            tz = ZoneInfo(tz_name)
        except Exception:
            tz = timezone.utc
        if next_run.tzinfo is None:
            next_run = next_run.replace(tzinfo=tz)
        if next_run.tzinfo != timezone.utc:
            next_run = next_run.astimezone(timezone.utc)
        if next_run <= now_utc:
            out.append(t)
    return out


def _execute_task(runtime, run_store, agent, task: dict, workspace_path: str,
                  run_id: str | None = None) -> dict:
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
        self._thread: threading.Thread | None = None

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

    def run_now(self, task_id: str) -> str | None:
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
