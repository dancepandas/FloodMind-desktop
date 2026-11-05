"""Filesystem-backed conversation store for the desktop sidecar.

One JSON file per conversation under <app_data_root>/conversations/<id>.json, plus
an index.json mapping workspace path -> that workspace's last-active conversation id.

SDK-free (pure filesystem) so it is unit-testable without the FloodMind SDK. The
`turns` field is stored opaque — the sidecar never interprets block structure; the
frontend rehydrates it verbatim.
"""
from __future__ import annotations

import json
import re
import shutil
import threading
import uuid
from datetime import datetime
from pathlib import Path
from typing import Callable, Optional


def _now() -> datetime:
    return datetime.now()


# Conversation ids are always "conv-" + 12 hex chars (see create()). Validating
# the shape on every lookup closes a path-traversal vector: a conv_id arrives
# straight from the URL path segment (<conv_id>) and was previously concatenated
# into a filesystem path with no sanitization, so "/api/conversations/../../x"
# could read/write/delete arbitrary JSON under the app-data root.
_CONV_ID_RE = re.compile(r"^conv-[0-9a-f]{12}$")


def _is_valid_conv_id(conv_id: str) -> bool:
    return isinstance(conv_id, str) and _CONV_ID_RE.fullmatch(conv_id) is not None


class ConversationStore:
    def __init__(self, app_data_root: Path, clock: Callable[[], datetime] = _now):
        self._root = Path(app_data_root) / "conversations"
        self._root.mkdir(parents=True, exist_ok=True)
        self._index_path = self._root / "index.json"
        self._clock = clock
        self._lock = threading.Lock()

    # ── paths ────────────────────────────────────────────────
    def _record_path(self, conv_id: str) -> Path:
        # Defense-in-depth: even a valid-format id must resolve inside the
        # store root. The format check above already rules out traversal, but
        # this backstop keeps _record_path safe if it is ever called directly.
        p = (self._root / f"{conv_id}.json").resolve()
        root = self._root.resolve()
        if p != root and root not in p.parents:
            raise ValueError("conversation id escapes store root")
        return p

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
        if not _is_valid_conv_id(conv_id):
            return None
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
                # 空会话判定：无任何 turns 即未发起对话（用于前端新建任务时清理空会话）。
                "turns_count": len(r.get("turns") or []),
            }
            for r in out
        ]

    def search(self, workspace: str, query: str, limit: int = 20) -> list[dict]:
        """跨会话关键词搜索：在当前工作区的所有会话 turn 内容里匹配 query。

        返回命中的 turn 片段（会话 id/标题 + role + 命中内容片段 + 会话时间），
        按会话更新时间倒序。turns 存储是 opaque 的（sidecar 不解释 block 结构），
        这里只匹配 role/user 的 content 字符串与 assistant 的 text 块 content。
        """
        q = (query or "").strip()
        if not q:
            return []
        hits: list[dict] = []
        for p in self._root.glob("conv-*.json"):
            try:
                rec = json.loads(p.read_text(encoding="utf-8"))
            except Exception:
                continue
            if rec.get("workspace") != workspace:
                continue
            for turn in rec.get("turns") or []:
                content = turn.get("content", "") if isinstance(turn, dict) else ""
                if not isinstance(content, str):
                    continue
                idx = content.find(q)
                if idx < 0:
                    continue
                start = max(0, idx - 40)
                snippet = content[start:idx + len(q) + 80]
                hits.append({
                    "conv_id": rec.get("id", ""),
                    "title": rec.get("title") or "新会话",
                    "role": turn.get("role", ""),
                    "snippet": snippet,
                    "updated_at": rec.get("updated_at", ""),
                })
        # 去重（同一会话多命中只留首条）+ 按更新时间倒序 + 限流。
        seen: set[str] = set()
        uniq = []
        for h in sorted(hits, key=lambda r: r["updated_at"], reverse=True):
            if h["conv_id"] in seen:
                continue
            seen.add(h["conv_id"])
            uniq.append(h)
            if len(uniq) >= limit:
                break
        return uniq

    def append_turns(self, conv_id: str, turns: list) -> Optional[dict]:
        if not _is_valid_conv_id(conv_id):
            return None
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
        if not _is_valid_conv_id(conv_id):
            return False
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
        if not _is_valid_conv_id(conv_id):
            return None
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
