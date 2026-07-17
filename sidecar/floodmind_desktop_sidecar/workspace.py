"""Workspace state for the desktop sidecar.

A Workspace binds the agent to a user-chosen local folder: artifacts/outputs
land there, memory/checkpoints isolate per workspace. The folder is surfaced to
the SDK via build_workspace()+set_workspace() (see floodmind_agent.py).
"""
from __future__ import annotations

import hashlib
import json
import threading
from pathlib import Path
from typing import Optional


def _app_data_dir() -> Path:
    """The sidecar's app-data root. The Rust spawn sets cwd to this dir."""
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
        self._lock = threading.Lock()
        self._cfg = self._load()

    def _load(self) -> dict:
        try:
            return json.loads(_config_path().read_text(encoding="utf-8"))
        except Exception:
            return {"current": None, "recent": []}

    def _save(self) -> None:
        _app_data_dir().mkdir(parents=True, exist_ok=True)
        _config_path().write_text(
            json.dumps(self._cfg, ensure_ascii=False, indent=2), encoding="utf-8"
        )

    @staticmethod
    def _summary(path: str) -> dict:
        return {"path": path, "name": Path(path).name or path}

    def current(self) -> Optional[dict]:
        c = self._cfg.get("current")
        return self._summary(c) if c else None

    def recent(self) -> list[dict]:
        return [self._summary(p) for p in self._cfg.get("recent", [])]

    def current_path(self) -> Optional[str]:
        return self._cfg.get("current")

    def open(self, path: str) -> dict:
        rp = str(resolve_user_dir(path))
        # Flask is threaded=True: an /api/workspace/open POST can race a concurrent
        # open or a chat thread reading current_path(). Serialize the RMW + persist.
        with self._lock:
            self._cfg["current"] = rp
            recent = [p for p in self._cfg.get("recent", []) if p != rp]
            recent.insert(0, rp)
            self._cfg["recent"] = recent[:10]
            self._save()
        return self._summary(rp)

    def forget(self, path: str) -> tuple[dict, bool]:
        """Unpin ``path`` from the recent list (remove it from the sidebar).

        Does NOT delete anything on disk — the folder and its per-workspace
        memory/conversations stay intact and reappear if the user reopens it. If
        ``path`` is the current workspace, current switches to the most-recent
        remaining entry (or None when none remain). Returns ``(summary,
        current_changed)`` so the caller can rebind the agent. Never raises:
        forgetting a folder that no longer exists on disk must still work.
        """
        target = str(path or "").strip()
        with self._lock:
            self._cfg["recent"] = [p for p in self._cfg.get("recent", []) if p != target]
            current_changed = False
            if target and target == self._cfg.get("current"):
                remaining = self._cfg["recent"]
                self._cfg["current"] = remaining[0] if remaining else None
                current_changed = True
            self._save()
        return self.summary(), current_changed

    def summary(self) -> dict:
        return {"current": self.current(), "recent": self.recent()}
