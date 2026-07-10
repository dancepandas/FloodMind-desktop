# Scheduled Tasks — Design Spec

**Date:** 2026-07-10
**Status:** Approved → ready for implementation plan

## Problem

The FloodMind SDK ships a scheduled-task **store + state machine** (`ScheduledTaskRuntime`) and **agent tools** to create/list/cancel tasks — but **no execution runner exists anywhere**. `claim_due_tasks` and `complete_task` are defined but never called (verified across the SDK and the desktop sidecar). So tasks get created (by the agent, during a chat) and **never fire**. The desktop sidecar has zero scheduled-task code, so users cannot even see them.

The user's intent: scheduled tasks must run **reliably and automatically** (the whole point is unattended execution — "解决用户没法手动点击的问题"), and each run must produce a **fully viewable execution transcript + artifacts** ("点击这个定时任务就可以查看完整执行过程和产物").

## Goal

Workspace-scoped scheduled tasks that fire automatically at their scheduled time (while the app is open), each running in an **isolated background session** that does not disturb the foreground conversation, producing a persisted **full transcript** (thinking / tool / text / artifact blocks — same shape as a chat) the user can replay by clicking the task. Plus a management UI to create / edit / delete / enable / disable / run-now.

## Verified SDK facts (from source)

- **`ScheduledTaskRuntime`** (`research/fm-sdk/floodmind/agent/scheduled_task_runtime.py`): JSON-backed store (`data/scheduled_tasks.json` or `SCHEDULED_TASKS_FILE` env). API: `create_task(session_id, command, repeat, run_time, scheduled_at, timezone, enabled)`, `list_tasks(session_id="")`, `get_task`, `update_task(task_id, **updates)` (allowed keys: command/enabled/run_time/scheduled_at/repeat/status), `cancel_task` (disables), `delete_task`, `claim_due_tasks(lookback, lookahead, limit)`, `complete_task(task_id, success, result, error, artifacts)`, `build_artifact_records`. Singleton via `get_scheduled_task_runtime()`.
- **Schedules:** only `repeat="none"` (one-shot at `scheduled_at`) or `repeat="daily"` (at `run_time` HH:MM). **Not cron.** Timezone defaults `Asia/Shanghai`.
- **Task record fields:** `id` (`sched_<uuid>`), `session_id`, `command`, `repeat`, `enabled`, `run_time`, `scheduled_at`, `timezone`, `next_run_at`, `status` (pending/running/completed/failed/disabled), `last_status`, `last_run_at`, `last_finished_at`, `last_result`, `last_error`, `artifacts`, `attempt_count`, `created_by`, `created_at`, `updated_at`. **No `workspace` field** — the desktop must associate tasks with a workspace itself.
- **`command` is a natural-language task description for the agent** (tool description: "未来执行的业务任务描述,不要包含定时表达"). Running a task = running the agent with `command` as the user prompt.
- **Agent tools** (`base_tools.py`): `CreateScheduledTask` / `ListScheduledTasks` / `CancelScheduledTask` — the agent can create tasks during a chat (with `session_id = get_current_session_id()`).
- **SDK server route** (`server/routes/tasks.py`): exposes GET (list/one), PATCH, DELETE, GET artifacts — but **no create and no run**. The desktop sidecar will talk to the runtime directly (not via this route), matching how it already wraps the SDK.
- **CRITICAL — execution isolation is feasible:** both `WorkspaceService._workspace_var` (`workspace_service.py:21`) and `SESSION_CONTEXT._session_ctx_var` (`tools/session_context.py:15`) are **`contextvars.ContextVar`**, not module globals. A background thread that calls `set_workspace(...)` / `set_session_context(...)` mutates **only its own thread's context** — the foreground conversation's workspace/session context is untouched. **Concurrent background execution is safe.** (New threads do not propagate contextvar mutations across threads.)

## Architecture

**Sidecar owns CRUD + a background runner; the SDK runtime owns task state; a new `TaskRunStore` owns per-run transcripts. Execution runs in isolated threads.**

- **`ScheduledTaskRuntime`** (SDK) — unchanged; holds task definitions + state machine. The sidecar calls it directly.
- **`task_index.json`** (desktop, new) — maps `task_id → workspace_path`, because the SDK task record carries no workspace. The desktop scopes lists/execution through this index.
- **`TaskRunStore`** (desktop, new) — `<app_data>/task_runs/<task_id>/<run_id>.json`, one file per run: `{run_id, task_id, started_at, finished_at, status, events:[], artifacts:[]}`. `events` is the ordered list of **sidecar-schema events** yielded during the run (the same events the frontend already reduces into blocks). Replaying them through the existing `reduceEvent` reproduces the full transcript — **zero reducer duplication**.
- **Runner** (desktop, new) — a daemon thread started by the sidecar; polls due tasks and spawns one worker thread per execution. Each worker is contextvar-isolated, builds a fresh agent, sets the task's workspace, streams `command`, captures events + artifacts, calls `complete_task`, and writes a run record.
- **Frontend** — sidebar "定时任务" list (replaces "最近") + create/edit modal + main-area task-detail view (run history → replay a run's events through `reduceEvent` → `BlockView`).

## Data model

```python
# SDK task record (unchanged shape); desktop adds workspace via the index:
Task = { id, session_id(uuid per task), command, repeat, enabled, run_time,
          scheduled_at, timezone, next_run_at, status, last_status, last_run_at,
          last_finished_at, last_result, last_error, artifacts, attempt_count,
          created_by, created_at, updated_at }

# Desktop index (task_index.json): { "<task_id>": "<workspace_path>" }

# Desktop run record (<app_data>/task_runs/<task_id>/<run_id>.json):
Run = { run_id, task_id, started_at, finished_at,
        status: "running"|"completed"|"failed",
        events: [<sidecar-schema ChatEvent>...],   # replayed via reduceEvent
        artifacts: [{kind, name, path}...] }        # summary, also present in events
```

- Each task gets its **own `session_id` (uuid)** at creation → task A and task B do not share memory. (Agent-created tasks keep the SDK's conversation `session_id`; desktop-created tasks get a fresh uuid.)
- Workspace scoping is via `task_index`, **not** `session_id`.

## Execution model (the runner)

1. **Daemon poll thread** (started at sidecar startup, single-threaded): every ~30 s, calls `runtime.list_tasks("")` (all), filters to enabled tasks with `next_run_at <= now` and `status != "running"`. For each due task it **claims synchronously** (`runtime.update_task(id, status="running")`, set `last_run_at`) **before** spawning a worker — the poll is single-threaded, so there is no spawn-to-claim race and a task can never be double-spawned across cycles. Then it **spawns a worker thread** (so multiple tasks / a task + a foreground chat run concurrently).
2. **Worker thread** (one per execution):
   - Look up `workspace_path` from `task_index`; on miss, `complete_task(success=False, error="workspace unknown")` and exit.
   - ` FloodMindAgent.run_headless(session_id, workspace_path, command)` — builds a **fresh** agent via `_build_agent(session_id, persist_dir)` (does NOT touch the foreground `self._agent`), sets the task's workspace in **this thread's** contextvars (`build_workspace` + `set_workspace` + `set_session_context`), then `stream([{"role":"user","content":command}])`, collecting every yielded sidecar event (excluding the terminal `done`).
   - Capture artifacts from the artifact events in the stream (and the output-dir diff, as today).
   - On success: `complete_task(id, success=True, result=<final text>, artifacts=[...])`. On exception: `complete_task(id, success=False, error=<msg>)`. (Daily tasks auto-reschedule to the next `run_time`; one-shot tasks disable themselves — both handled by `complete_task`.)
   - Write a `Run` record to `TaskRunStore` with the captured `events` + `artifacts`.
3. **Catch-up on launch:** at startup (before the first poll), the runner runs the same due-check once so tasks whose time passed while the app was closed fire shortly after opening.
4. **Residual constraint (unavoidable):** the sidecar lives only while the Tauri app is open. Tasks cannot fire while the app is closed. Catch-up-on-launch covers the "open it later that day" case. Surfaced clearly in the UI.

### Concurrency & isolation

- Workspace + session context are `contextvars` → per-thread. The worker thread's `set_workspace`/`set_session_context` do not affect the foreground conversation thread. Safe.
- Each worker builds its own agent + `DualMemory` (per `session_id`) → isolated memory. Safe.
- `ScheduledTaskRuntime` uses an `RLock`; `TaskRunStore` will too. Safe for concurrent CRUD + runs.
- The foreground chat path (`FloodMindAgent.stream` + `self._agent`) is untouched by the runner.

## FloodMindAgent additions

- **`run_headless(session_id, workspace_path, command) -> (events: list[dict], artifacts: list[dict], final_text: str)`** — the worker-facing entry point. Builds a fresh agent (reuses `_build_agent` + `_memory_target`), sets up `workspace_path` in the **current thread's** contextvars (a variant of `_set_workspace` that takes an explicit path instead of `workspace_manager.current_path()`), streams the command, collects events + artifacts + final text. Does not mutate `self._agent` or foreground state. Errors are caught and returned as an error event + empty final_text (the caller decides `complete_task(success=...)`).

## API (sidecar)

| Method | Path | Body / Query | Effect |
|---|---|---|---|
| GET | `/api/scheduled-tasks` | `?workspace=<path>` | list tasks for the workspace (via `task_index`) + last run summary |
| POST | `/api/scheduled-tasks` | `{workspace, command, repeat, run_time?, scheduled_at?, timezone?, enabled?}` | create (fresh uuid `session_id`) + write `task_index` |
| PATCH | `/api/scheduled-tasks/<id>` | `{command?, enabled?, run_time?, scheduled_at?, repeat?}` | update via `runtime.update_task` |
| DELETE | `/api/scheduled-tasks/<id>` | — | `runtime.delete_task` + remove `task_index` entry |
| POST | `/api/scheduled-tasks/<id>/run` | — | trigger a run now (same worker path, returns `{run_id}`) |
| GET | `/api/scheduled-tasks/<id>/runs` | — | run history `[{run_id, started_at, finished_at, status}]` |
| GET | `/api/scheduled-tasks/<id>/runs/<run_id>` | — | full run record incl. `events` |

Notes:
- `POST .../run` claims the task (sets `running`) then runs the worker in a background thread (non-blocking); returns `{run_id}` immediately. If the task is already `running`, returns 409. The UI polls `GET .../runs` / the task's `status` to see completion.
- All endpoints degrade gracefully (500 → `{error}`); runner errors never crash the sidecar.
- `task_index` is a small JSON (`<app_data>/task_index.json`) owned by the sidecar, with an `RLock`.

## Frontend changes

- **`src/state/scheduled-task-store.ts` (new)** — wraps the 7 endpoints: `list(workspace)`, `create`, `update`, `remove`, `runNow(id)`, `runs(id)`, `runDetail(id, runId)`. Holds `tasks`, `selectedTaskId`, `runs`, `currentRun`.
- **`src/state/ui-store.ts`** — add view `'tasks'` and a `selectedTaskId` + `selectedRunId` for the detail view; `setView` already exists.
- **`src/components/Sidebar.tsx`** — replace the "最近" (recent workspaces) section with a "定时任务" section: compact list (command snippet + status dot + `next_run_at`); "+" → open create modal; click a task → `setView('tasks')` + `selectedTaskId`.
- **`src/components/ScheduledTasksView.tsx` (new)** — main-area view: header (back-to-chat + "任务在 app 开启时自动执行;关闭期间错过的会在下次开启时补跑" note) + run-history list; selecting a run replays its `events` through `chat-store.reduceEvent` into `Msg[]` and renders with the existing `BlockView` components + an artifacts list. Reuses the conversation rendering verbatim.
- **`src/components/TaskEditModal.tsx` (new)** — create/edit form: `command` textarea, `repeat` (none/daily), `run_time` (HH:MM) or `scheduled_at` (datetime), `timezone`, `enabled`. Validation: command non-empty; daily requires `run_time`; one-shot requires `scheduled_at`.
- **`src/App.tsx`** — render `<ScheduledTasksView/>` when `view === 'tasks'`.
- **`src/state/chat-store.ts`** — export `reduceEvent` (already exported) for reuse by the task run replay. No other change.

## Error handling

- Missing `task_index` entry (orphan task): runner skips + logs; UI shows it as "workspace unknown".
- `run_headless` failure (agent build error, SDK exception): worker catches, writes a run record with an error event, calls `complete_task(success=False)`. The task is not left stuck in "running".
- Sidecar restart mid-run: a task stuck in "running" (no worker alive) — on startup, the runner reclaims any `status=="running"` tasks (set back to `pending`, or mark failed) so they aren't permanently stuck.
- `task_index` / run-file read failures: logged + skipped (degrade gracefully), mirroring `ConversationStore`.

## Testing

**Sidecar (pytest, SDK-free where possible):**
- `task_index` CRUD round-trip + consistency on delete.
- CRUD endpoints (create/list/update/delete) using the real `ScheduledTaskRuntime` rooted at a tmp `SCHEDULED_TASKS_FILE` (monkeypatch the env var / `get_scheduled_task_runtime` to a tmp-backed instance).
- `run_headless`: build a fake agent whose `.stream()` yields canned events; assert the collected events + final_text + artifacts, and that `self._agent` (foreground) is untouched.
- Runner scheduling logic (pure helper): given a list of tasks + "now", returns the correct due set; catch-up-on-launch path.
- Stuck-run reclamation on startup.

**Frontend (vitest):**
- `scheduled-task-store`: endpoint calls + graceful null/false on failure (mirror conversation-store tests).
- Run replay: feed canned `events` through `reduceEvent` → assert the expected block list (proves transcript reuse).

**Real-SDK smoke (Agent_desktop conda env, `npm run tauri dev`):**
- Create a one-shot task ~1 min out → it fires automatically, a run record appears, clicking it shows the full block transcript + artifacts.
- Create a daily task → fires at the run_time (if the app is open); confirm foreground chat is unaffected during the run.
- Run-now button → immediate run + transcript.
- Close + reopen the app past a task's time → catch-up fires it.

## Out of scope (later)

- **OS-level scheduling** (fire while the app is closed) — requires a platform daemon/installer hook; large separate effort.
- **Cron schedules** (the SDK only supports none/daily) — would need SDK changes.
- Editing an agent-created task's workspace binding.
- Run retention policy / pruning old runs.
- Notifications when a task completes.
