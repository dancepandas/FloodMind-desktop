"""Per-workspace registration of user-authorized external readable paths.

The SDK's folder-first Workspace injects ``readable_roots`` into PathService's
read allow-list; a root can be an exact FILE (only that file) or a FOLDER
(everything under it, via ``PathService._is_relative_to``). Files/folders the
user drags or pastes from OUTSIDE the workspace are registered here and injected
on the next workspace build (``_build_workspace_for_path``), turning the SDK's
read_path DENY ("读取路径 ... 不在允许目录内") into ALLOW — which the desktop's
permission hook then upgrades to ASK so the existing authorization UI fires.
"""
from __future__ import annotations

import json
import os
import threading
from pathlib import Path


_lock = threading.Lock()


def _paths_file(workspace_root: str) -> Path:
    return Path(workspace_root) / ".floodmind" / "external-read-paths.json"


def read_external_paths(workspace_root: str) -> list[str]:
    """Current authorized external readable paths for a workspace (sorted)."""
    try:
        data = json.loads(_paths_file(workspace_root).read_text(encoding="utf-8"))
        if isinstance(data, dict) and isinstance(data.get("paths"), list):
            return [str(p) for p in data["paths"] if isinstance(p, str)]
    except Exception:
        pass
    return []


def _normalize(path: str) -> str:
    # resolve() canonicalizes case/long-path on Windows; abspath/normpath drop
    # relative components. Reads later match case-insensitively via
    # PureWindowsPath.relative_to, so no extra lowercasing is needed.
    return str(Path(str(path).strip()).expanduser().resolve())


def add_external_paths(workspace_root: str, paths: list[str]) -> list[str]:
    """Dedupe, absolutize, keep only paths that still EXIST (files or folders),
    persist. Returns the new list. A dropped folder is kept so the agent can
    Glob/Read its whole tree."""
    with _lock:
        current = set(read_external_paths(workspace_root))
        changed = False
        for raw in paths or []:
            norm = _normalize(raw)
            if norm and os.path.exists(norm) and norm not in current:
                current.add(norm)
                changed = True
        out = sorted(current)
        if changed:
            _write(workspace_root, out)
        return out


def remove_external_path(workspace_root: str, path: str) -> list[str]:
    """Drop one authorized path (idempotent). Returns the new list."""
    with _lock:
        current = set(read_external_paths(workspace_root))
        before = len(current)
        current.discard(_normalize(path))
        if len(current) != before:
            _write(workspace_root, sorted(current))
        return sorted(current)


def _write(workspace_root: str, paths: list[str]) -> None:
    p = _paths_file(workspace_root)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(
        json.dumps({"paths": paths}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
