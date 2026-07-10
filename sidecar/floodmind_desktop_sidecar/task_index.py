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
