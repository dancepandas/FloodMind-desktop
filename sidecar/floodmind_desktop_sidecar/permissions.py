"""Permission mode + per-workspace trust cache for tool authorization.

Three modes:
- always-trust: every tool call is approved automatically.
- trust-once: the first time a fingerprint is seen, ask; subsequent identical
  fingerprints are auto-approved within the same workspace.
- always-ask: every tool call requires explicit user approval.

The trust cache is persisted per workspace so users can have different trust
boundaries for different projects.
"""
from __future__ import annotations

import hashlib
import json
import threading
from enum import Enum
from pathlib import Path
from typing import Any


class PermissionMode(str, Enum):
    ALWAYS_TRUST = "always-trust"
    TRUST_ONCE = "trust-once"
    ALWAYS_ASK = "always-ask"


class PermissionCache:
    """In-memory trust cache with per-workspace persistence.

    Approved fingerprints are written to
    `<workspace>/.floodmind/permissions.json`. Rejected fingerprints are NOT
    cached — the next identical call will ask again.
    """

    def __init__(self, workspace_path: str | None = None):
        self.workspace = workspace_path
        self._approved: set[str] = set()
        self._load()

    @staticmethod
    def _cache_file(workspace_path: str) -> Path:
        return Path(workspace_path) / ".floodmind" / "permissions.json"

    def _load(self) -> None:
        if not self.workspace:
            return
        path = self._cache_file(self.workspace)
        if not path.exists():
            return
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            if isinstance(data, dict) and isinstance(data.get("approved"), list):
                self._approved = set(data["approved"])
        except Exception:
            self._approved = set()

    def _save(self) -> None:
        if not self.workspace:
            return
        path = self._cache_file(self.workspace)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            json.dumps({"approved": sorted(self._approved)}, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )

    def is_approved(self, fingerprint: str) -> bool:
        return fingerprint in self._approved

    def approve(self, fingerprint: str) -> None:
        if fingerprint not in self._approved:
            self._approved.add(fingerprint)
            self._save()

    def clear(self) -> None:
        if self._approved:
            self._approved.clear()
            self._save()


def _normalize(value: Any) -> str:
    """Stable string representation for fingerprinting."""
    if value is None:
        return ""
    if isinstance(value, str):
        return value.strip()
    try:
        return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    except Exception:
        return str(value)


def permission_fingerprint(tool_name: str, tool_input: Any, workspace_path: str | None = None) -> str:
    """Build a stable fingerprint for a tool call.

    Rules:
    - Bash / Shell / Exec: tool_name + full command string.
    - WriteFile / FileWrite: tool_name + target path.
    - ReadFile: workspace-internal reads are grouped by tool_name only;
      external reads include the path.
    - MCP tools: server + tool_name + serialized arguments.
    - Default: tool_name only.
    """
    name = (tool_name or "").strip()
    inp = tool_input if isinstance(tool_input, dict) else {}

    if name in ("Bash", "Shell", "Exec"):
        key = _normalize(inp.get("command") or inp.get("cmd") or inp.get("input") or "")
        return hashlib.sha256(f"{name}:{key}".encode("utf-8")).hexdigest()

    if name in ("WriteFile", "FileWrite"):
        key = _normalize(inp.get("path") or inp.get("file_path") or "")
        return hashlib.sha256(f"{name}:{key}".encode("utf-8")).hexdigest()

    if name == "ReadFile":
        path = _normalize(inp.get("path") or inp.get("file_path") or "")
        if workspace_path and path:
            try:
                target = Path(path).resolve()
                root = Path(workspace_path).resolve()
                if root in target.parents or target == root:
                    return hashlib.sha256(f"{name}:workspace".encode("utf-8")).hexdigest()
            except Exception:
                pass
        return hashlib.sha256(f"{name}:{path}".encode("utf-8")).hexdigest()

    # MCP and other tools: include the full input so that argument changes
    # produce distinct fingerprints.
    key = _normalize(inp)
    return hashlib.sha256(f"{name}:{key}".encode("utf-8")).hexdigest()


class PendingPermissionAsks:
    """Thread-safe registry of permission asks awaiting user response.

    The SDK executor blocks on a `permission_ask` event until
    `AskService.respond()` is called. While blocked, the stream iterator is
    paused. The frontend POSTs to `/api/permission/respond`; that endpoint
    looks up the ask here, calls `AskService.respond()`, and optionally caches
    the fingerprint for trust-once mode.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._pending: dict[str, dict[str, Any]] = {}

    def register(self, ask_id: str, session_id: str, fingerprint: str, tool_name: str, tool_input: Any) -> None:
        with self._lock:
            self._pending[ask_id] = {
                "session_id": session_id,
                "fingerprint": fingerprint,
                "tool_name": tool_name,
                "tool_input": tool_input,
            }

    def pop(self, ask_id: str) -> dict[str, Any] | None:
        with self._lock:
            return self._pending.pop(ask_id, None)

    def clear(self) -> None:
        with self._lock:
            self._pending.clear()


# Global registry shared by the streaming loop and the respond endpoint.
PENDING_ASKS = PendingPermissionAsks()
