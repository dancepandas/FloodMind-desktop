"""Filesystem-backed conversation store for the desktop sidecar.

One JSON file per conversation under <app_data_root>/conversations/<id>.json, plus
an index.json mapping workspace path -> that workspace's last-active conversation id.

SDK-free (pure filesystem) so it is unit-testable without the FloodMind SDK. The
`turns` field is stored opaque — the sidecar never interprets block structure; the
frontend rehydrates it verbatim.
"""
from __future__ import annotations

import json
import shutil
import threading
import uuid
from datetime import datetime
from pathlib import Path
from typing import Callable, Optional


def _now() -> datetime:
    return datetime.now()


class ConversationStore:
    def __init__(self, app_data_root: Path, clock: Callable[[], datetime] = _now):
        self._root = Path(app_data_root) / "conversations"
        self._root.mkdir(parents=True, exist_ok=True)
        self._index_path = self._root / "index.json"
        self._clock = clock
        self._lock = threading.Lock()

    # ── paths ────────────────────────────────────────────────
    def _record_path(self, conv_id: str) -> Path:
        return self._root / f"{conv_id}.json"

    def _memory_dir(self, session_id: str) -> Path:
        # Parent of <root>/conversations == app_data_root; matches
        # FloodMindAgent._memory_target: <app_data>/<session_id>/memory.
        return self._root.parent / session_id

    # ── index (workspace -> active conv id) ──────────────────
    def _load_index(self) -> dict:
        try:
            return json.loads(self._index_path.read_text(encoding="utf-8"))
        except Exception:
            return {}

    def _save_index(self, data: dict) -> None:
        self._index_path.write_text(
            json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8"
        )

    def _set_active(self, workspace: str, conv_id: str) -> None:
        idx = self._load_index()
        idx[workspace] = conv_id
        self._save_index(idx)

    def set_active(self, workspace: str, conv_id: str) -> None:
        with self._lock:
            self._set_active(workspace, conv_id)

    def get_active(self, workspace: str) -> Optional[str]:
        return self._load_index().get(workspace)

    # ── CRUD ─────────────────────────────────────────────────
    def create(self, workspace: str, title: str = "") -> dict:
        with self._lock:
            conv_id = "conv-" + uuid.uuid4().hex[:12]
            session_id = uuid.uuid4().hex
            now = self._clock().isoformat()
            record = {
                "id": conv_id,
                "session_id": session_id,
                "workspace": workspace,
                "title": title or "新会话",
                "created_at": now,
                "updated_at": now,
                "turns": [],
            }
            self._record_path(conv_id).write_text(
                json.dumps(record, ensure_ascii=False, indent=2), encoding="utf-8"
            )
            self._set_active(workspace, conv_id)
            return record

    def get(self, conv_id: str) -> Optional[dict]:
        try:
            return json.loads(self._record_path(conv_id).read_text(encoding="utf-8"))
        except FileNotFoundError:
            return None
        except Exception:
            return None

    def list(self, workspace: str) -> list[dict]:
        active = self._load_index().get(workspace)
        out = []
        for p in self._root.glob("conv-*.json"):
            try:
                rec = json.loads(p.read_text(encoding="utf-8"))
            except Exception:
                continue
            if rec.get("workspace") != workspace:
                continue
            out.append(rec)
        # Most-recently-updated first (ISO strings sort chronologically).
        out.sort(key=lambda r: r.get("updated_at", ""), reverse=True)
        return [
            {
                "id": r["id"],
                "title": r.get("title") or "新会话",
                "updated_at": r.get("updated_at", ""),
                "active": r["id"] == active,
            }
            for r in out
        ]

    def append_turns(self, conv_id: str, turns: list) -> Optional[dict]:
        with self._lock:
            rec = self.get(conv_id)
            if rec is None:
                return None
            rec["turns"] = (rec.get("turns") or []) + list(turns)
            rec["updated_at"] = self._clock().isoformat()
            self._record_path(conv_id).write_text(
                json.dumps(rec, ensure_ascii=False, indent=2), encoding="utf-8"
            )
            return rec

    def update_title(self, conv_id: str, title: str) -> bool:
        with self._lock:
            rec = self.get(conv_id)
            if rec is None:
                return False
            rec["title"] = title
            rec["updated_at"] = self._clock().isoformat()
            self._record_path(conv_id).write_text(
                json.dumps(rec, ensure_ascii=False, indent=2), encoding="utf-8"
            )
            return True

    def delete(self, conv_id: str) -> Optional[str]:
        """Remove record + its SDK memory dir. Returns the removed session_id, or None."""
        with self._lock:
            rec = self.get(conv_id)
            if rec is None:
                return None
            try:
                self._record_path(conv_id).unlink()
            except FileNotFoundError:
                pass
            mem = self._memory_dir(rec["session_id"])
            if mem.exists():
                shutil.rmtree(mem, ignore_errors=True)
            idx = self._load_index()
            for ws, cid in list(idx.items()):
                if cid == conv_id:
                    idx.pop(ws, None)
            self._save_index(idx)
            return rec["session_id"]
