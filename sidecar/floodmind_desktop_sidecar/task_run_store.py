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
        with self._lock:
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
        with self._lock:
            try:
                return json.loads(self._path(task_id, run_id).read_text(encoding="utf-8"))
            except FileNotFoundError:
                return None
            except Exception:
                return None
