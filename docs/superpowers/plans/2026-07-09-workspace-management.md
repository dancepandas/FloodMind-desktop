# FloodMind Desktop — Plan 3: Workspace Management

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Let the user open a local folder as a **Workspace**; bind the agent to it so artifacts/outputs land in that folder and memory/checkpoints isolate per workspace; switch between recent workspaces; first-run picker.

**Architecture:** The SDK already models this — `Workspace(user_dir=<folder>, session_root=<app-data>, sandbox_base=<folder>/.floodmind/sandboxes)` (`floodmind/agent/runtime/contracts/workspace.py`), injected via `build_workspace()` + `set_workspace()` before the agent runs (pattern from `server/agent_factory.py`). Plan 3 surfaces it: a sidecar `WorkspaceManager` holds the current `user_dir` + recent list (persisted to app-data), `FloodMindAgent.stream()` sets the workspace before each run, and the frontend shows a workspace switcher (with a native folder picker via `tauri-plugin-dialog`).

**Tech Stack:** Python (Flask, floodmind SDK workspace_service), React 19 + Zustand, Tauri 2 dialog plugin.

## Global Constraints

- Repo root `D:\chengs\9.project\Agent_desktop`, conda env `Agent_desktop`, npm.
- The sidecar already runs with cwd = `<app-data>/FloodMindDesktop` (Plan 2 fix). Workspace **session_root** = that app-data dir; **user_dir** = the user-chosen folder.
- `~/.floodmind/settings.json` (LLM key) is home-relative — unaffected by workspace.
- Follow the review→fix→review→fix loop after each task.
- TDD the pure parts (path derivation, session-id hashing); probe the workspace↔agent wiring empirically in Task 1.

## SDK facts this plan depends on (verified from research/fm-sdk)

- `from floodmind.agent.runtime.services.workspace_service import build_workspace, set_workspace`
- `build_workspace(session_id, *, session_root=None, user_dir=None, sandbox_strategy=None, ...)` → resolves absolute paths; with `user_dir=<folder>` + `sandbox_strategy="user_dir"`, sandbox_base = `<folder>/.floodmind/sandboxes`.
- `set_workspace(ws)` injects it (contextvars); the agent reads `get_workspace()` at runtime for output/upload paths.
- Wiring pattern (agent_factory.py): build + set_workspace right before creating/running the agent.

---

## Task 1: Sidecar workspace state + wiring (TDD + probe)

**Files:**
- Create: `sidecar/floodmind_desktop_sidecar/workspace.py` (WorkspaceManager: current user_dir + recent list, persist to `<app-data>/FloodMindDesktop/config.json`; pure helpers `session_id_for(path)` + `resolve_user_dir(path)`).
- Modify: `sidecar/floodmind_desktop_sidecar/app.py` (add `GET /api/workspace`, `POST /api/workspace/open`).
- Modify: `sidecar/floodmind_desktop_sidecar/floodmind_agent.py` (`stream()` sets the workspace via build_workspace+set_workspace before running).
- Create: `sidecar/tests/test_workspace.py`.

**Interfaces:**
- Produces: `GET /api/workspace` → `{current: {path, name}|null, recent: [{path,name}]}`. `POST /api/workspace/open` body `{path}` → sets current, persists, returns the workspace summary. `FloodMindAgent.stream()` builds+sets the workspace so artifacts go to `user_dir`.

- [ ] **Step 1: Write failing tests for the pure helpers**

`sidecar/tests/test_workspace.py`:
```python
import tempfile, os
from pathlib import Path
from floodmind_desktop_sidecar.workspace import session_id_for, resolve_user_dir


def test_session_id_for_is_stable_and_path_like():
    a = session_id_for("D:/work/foo")
    b = session_id_for("D:/work/foo")
    c = session_id_for("D:/work/bar")
    assert a == b and a != c and len(a) <= 32


def test_resolve_user_dir_normalizes(tmp_path):
    p = resolve_user_dir(str(tmp_path))
    assert p == tmp_path.resolve()
```

- [ ] **Step 2: Run → fail (module missing).**

- [ ] **Step 3: Implement `workspace.py`**

```python
from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Optional


def _app_data_dir() -> Path:
    # cwd is <app-data>/FloodMindDesktop (set by the Rust spawn).
    return Path.cwd()


def _config_path() -> Path:
    return _app_data_dir() / "config.json"


def resolve_user_dir(path: str) -> Path:
    """Resolve + validate a user-chosen workspace folder (must exist & be a dir)."""
    p = Path(path).expanduser().resolve()
    if not p.is_dir():
        raise ValueError(f"not a directory: {p}")
    return p


def session_id_for(path: str) -> str:
    """Stable, filesystem-safe session id derived from the workspace path."""
    h = hashlib.sha1(str(Path(path).resolve()).encode("utf-8")).hexdigest()
    return f"ws-{h[:24]}"


class WorkspaceManager:
    """Holds the current workspace + recent list, persisted to app-data/config.json."""

    def __init__(self):
        self._cfg = self._load()

    def _load(self) -> dict:
        try:
            return json.loads(_config_path().read_text(encoding="utf-8"))
        except Exception:
            return {"current": None, "recent": []}

    def _save(self) -> None:
        _app_data_dir().mkdir(parents=True, exist_ok=True)
        _config_path().write_text(json.dumps(self._cfg, ensure_ascii=False, indent=2), encoding="utf-8")

    @staticmethod
    def _summary(path: str) -> dict:
        return {"path": path, "name": Path(path).name or path}

    def current(self) -> Optional[dict]:
        c = self._cfg.get("current")
        return self._summary(c) if c else None

    def recent(self) -> list[dict]:
        return [self._summary(p) for p in self._cfg.get("recent", [])]

    def open(self, path: str) -> dict:
        resolved = resolve_user_dir(path)
        rp = str(resolved)
        self._cfg["current"] = rp
        recent = [p for p in self._cfg.get("recent", []) if p != rp]
        recent.insert(0, rp)
        self._cfg["recent"] = recent[:10]
        self._save()
        return self._summary(rp)

    def current_path(self) -> Optional[str]:
        return self._cfg.get("current")
```

- [ ] **Step 4: Run → green.**

- [ ] **Step 5: Wire the workspace into `FloodMindAgent.stream()`**

In `floodmind_agent.py`, set the workspace before running the agent:
```python
def stream(self, messages):
    user_text = messages[-1]["content"] if messages else ""
    try:
        self._set_workspace()  # bind outputs/memory to the current workspace
        for raw in self._agent.stream(user_text):
            for ev in translate_event(raw):
                yield ev
    except Exception as e:
        yield {"type": "error", "content": f"代理执行出错：{e}"}
    yield {"type": "done"}

def _set_workspace(self):
    from floodmind.agent.runtime.services.workspace_service import build_workspace, set_workspace
    from .workspace import _app_data_dir, session_id_for
    user_dir = self._workspace_path  # injected at construction or per-request
    if not user_dir:
        return  # no workspace open → SDK falls back to its default layout
    sid = session_id_for(user_dir)
    ws = build_workspace(sid, session_root=_app_data_dir(), user_dir=user_dir, sandbox_strategy="user_dir")
    set_workspace(ws.ensure())
```
(`FloodMindAgent` gains a `workspace_path` attribute, settable via a module-level setter or constructor; the `/api/workspace/open` endpoint updates it.)

- [ ] **Step 6: Probe the wiring** — write a throwaway check that opens a temp folder as workspace, runs a tiny task that produces a file, and asserts the file landed in the temp folder (not app-data). If it doesn't propagate (contextvar/thread issue), fall back to rebuilding the agent per workspace. Record the result.

- [ ] **Step 7: Add the endpoints in `app.py`** (`GET /api/workspace`, `POST /api/workspace/open`) using a shared `WorkspaceManager`.

- [ ] **Step 8: pytest green; commit.**

---

## Task 2: Frontend workspace store + switcher UI

**Files:**
- Create: `src/state/workspace-store.ts`, `src/components/WorkspaceSwitcher.tsx`
- Modify: `src/App.tsx` (put switcher in the header/sidebar), `src/app.css`

- [ ] Workspace store: `current`, `recent`, `load()` (GET /api/workspace), `open(path)` (POST /api/workspace/open), `pickAndOpen()` (Tauri dialog → open).
- [ ] `WorkspaceSwitcher`: shows current workspace name + dropdown of recent + "打开工作区…" button.
- [ ] On app mount, call `load()`; if no current workspace, prompt to pick one (don't block chat — workspace is optional, agent works with fallback).
- [ ] Build + vitest green; commit.

---

## Task 3: Tauri dialog integration (folder picker)

**Files:**
- Modify: `package.json` (add `@tauri-apps/plugin-dialog`), `src-tauri/Cargo.toml` + `lib.rs` (register `tauri_plugin_dialog`), `src-tauri/capabilities/default.json` (allow `dialog:allow-open`).
- Modify: `src/lib/sidecar-client.ts` or a new `tauri-bridge.ts` (`openFolderPicker()` → `@tauri-apps/plugin-dialog` `open({directory:true})`).

- [ ] Add the plugin (npm + cargo), register it, grant the capability.
- [ ] `openFolderPicker()` returns the chosen path or null.
- [ ] Build + manual: click "打开工作区", pick a folder, confirm it's set (GET /api/workspace shows it). Commit.

---

## Task 4: Per-workspace isolation + manual verification

- [ ] Confirm session_id is derived from the workspace path (Task 1) so memory/checkpoints don't bleed across workspaces.
- [ ] Manual: open workspace A, ask for a doc; confirm the artifact file appears **in workspace A's folder**. Switch to workspace B; confirm B starts fresh and A's artifact isn't in B.
- [ ] Review loop + commit.

---

## Plan 3 Done — Definition of Done

- [ ] User can open/switch a local folder as a workspace via a native picker.
- [ ] Agent artifacts land in the chosen workspace folder; memory/checkpoints isolate per workspace.
- [ ] Recent workspaces list persists across restarts.
- [ ] `npm test`, sidecar pytest, cargo test all green; GUI verified.
- [ ] Chat still works with no workspace open (SDK default-layout fallback).

## Carry-overs

- **Plan 4:** per-workspace AGENTS.md loading, memory search panel, artifact file-explorer + "open in system app" (desktop fs), thinking-pane.
- **Plan 5:** bundle; restrict CORS; Job Object kill; graceful startup dialog.
