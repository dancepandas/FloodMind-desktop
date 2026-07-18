"""Normalize front-end image-attachment descriptors into SDK Attachment objects.

Three sources (front-end wire format):
  - {"source":"workspace", "name": "<rel>",  "mime": ...}  → resolved against workspace root
  - {"source":"file",      "path": "<abs>",  "name"?, "mime": ...}  → used as-is (drag-drop)
  - {"source":"clipboard", "data": "<base64>", "name"?, "mime": ...}  → staged to a temp file

All are turned into a real on-disk path the SDK MessageBuilder can base64-encode.
Pure-ish: file IO only (no agent, no network), so unit-testable with tmp_path.
"""
from __future__ import annotations

import base64
import mimetypes
import os
import uuid
from pathlib import Path
from typing import List, Tuple

IMAGE_EXTS = (".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp")
MAX_IMAGE_BYTES = 10 * 1024 * 1024


def _ext_ok(name: str) -> bool:
    return name.lower().endswith(IMAGE_EXTS)


def _mime_for(path_or_name: str, fallback: str = "") -> str:
    guess, _ = mimetypes.guess_type(path_or_name)
    return guess or fallback or "image/png"


def _within_workspace(abs_path: str, workspace_root: str) -> bool:
    if not workspace_root:
        return False
    try:
        root = Path(workspace_root).resolve()
        p = Path(abs_path).resolve()
    except Exception:
        return False
    return p == root or root in p.parents


def normalize_attachment(desc: dict, workspace_root: str | None,
                         staging_dir: Path) -> Tuple[object, None] | Tuple[None, str]:
    """One descriptor → (Attachment, None) | (None, error_message).

    Returns a real SDK Attachment on success, or an error string the caller can
    surface as an NDJSON error event. Never raises — failures become errors so a
    single bad attachment does not abort the whole send.
    """
    from floodmind.agent.native.types import Attachment

    source = desc.get("source")
    abs_path = ""
    display_name = ""

    if source == "workspace":
        name = str(desc.get("name", "")).strip().replace("\\", "/")
        if not name or name.startswith("/") or ".." in name.split("/"):
            return None, f"无效的图片路径：{name or '(空)'}"
        if not _ext_ok(name):
            return None, f"不支持的图片格式：{name}"
        ws = workspace_root or ""
        try:
            abs_path = str((Path(ws) / name).resolve())
        except Exception:
            return None, f"无效的图片路径：{name}"
        if not _within_workspace(abs_path, ws):
            return None, f"图片不在工作区内：{name}"
        display_name = name
    elif source == "file":
        abs_path = str(desc.get("path", "")).strip()
        display_name = str(desc.get("name", os.path.basename(abs_path) or "image"))
        if not abs_path or not os.path.isabs(abs_path):
            return None, "图片路径必须是绝对路径"
        if not _ext_ok(display_name):
            return None, f"不支持的图片格式：{display_name}"
    elif source == "clipboard":
        display_name = str(desc.get("name", "")).strip() or "pasted.png"
        if not _ext_ok(display_name):
            return None, f"不支持的图片格式：{display_name}"
        try:
            raw = base64.b64decode(str(desc.get("data", ""))) if desc.get("data") else b""
        except Exception:
            return None, f"剪贴板图片解码失败：{display_name}"
        try:
            staging_dir.mkdir(parents=True, exist_ok=True)
            abs_path = str(staging_dir / f"{uuid.uuid4().hex}{Path(display_name).suffix.lower()}")
            Path(abs_path).write_bytes(raw)
        except OSError:
            return None, f"剪贴板图片写入失败：{display_name}"
    else:
        return None, "未知的附件来源"

    try:
        size = os.path.getsize(abs_path)
    except OSError:
        return None, f"无法读取图片：{display_name}"
    if size > MAX_IMAGE_BYTES:
        return None, f"图片过大（>10MB）：{display_name}"
    if size == 0:
        return None, f"图片为空：{display_name}"

    mime = desc.get("mime") or _mime_for(abs_path)
    attachment = Attachment(
        file_id=uuid.uuid4().hex,
        name=os.path.basename(str(abs_path)) or display_name,
        path=abs_path,
        kind="image",
        mime_type=mime,
        size=size,
    )
    return attachment, None


def normalize_attachments(descriptors, workspace_root: str | None,
                          staging_dir: Path) -> Tuple[List[object], List[str]]:
    """All descriptors → (attachments, error_messages). One bad item doesn't abort the rest."""
    attachments: List[object] = []
    errors: List[str] = []
    for d in descriptors or []:
        if not isinstance(d, dict):
            continue
        att, err = normalize_attachment(d, workspace_root, staging_dir)
        if att is not None:
            attachments.append(att)
        else:
            errors.append(err or "附件处理失败")
    return attachments, errors


def cleanup_staging(staging_dir: Path) -> None:
    """Empty the clipboard-image staging dir on sidecar start (orphans from last session)."""
    try:
        if not staging_dir.exists():
            return
        for p in staging_dir.iterdir():
            try:
                if p.is_file():
                    p.unlink()
            except OSError:
                pass
    except OSError:
        pass
