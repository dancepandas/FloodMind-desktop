# 多模态图片输入（Vision）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 FloodMind Desktop 接收图片（粘贴/拖拽/`@`工作区图片），经 SDK 原生 `attachments` 通道送入视觉模型，单轮有效、零 SDK 改动。

**Architecture:** 三种入口在 Composer 汇成统一的 attachment 描述符（workspace / file / clipboard 三种 source），随 `/api/chat` 请求体传给 sidecar；sidecar 在 `attachments.py` 里归一化为 SDK `Attachment(path=...)`，传给 `NativeFloodAgent.stream(user_text, attachments=...)`，SDK 的 `MessageBuilder` 自动 base64 + 拼 OpenAI `image_url` 内容块。图片不入 `DualMemory`（只存文本），因此跨轮次天然不重发。非视觉模型（`resolve_model().supports_vision == False`）禁用所有入口。

**Tech Stack:** Python Flask sidecar / FloodMind SDK（`floodmind.agent.native.types.Attachment`）/ React 19 + TypeScript + Zustand / Tauri 2（DOM `paste` 事件 + `getCurrentWindow().onDragDropEvent`，零新依赖）/ pytest + vitest。

## Global Constraints

- **平台**：Windows 10+；Python ≥ 3.11；Node ≥ 20。
- **图片格式**：`.png .jpg .jpeg .gif .webp .bmp`（与 SDK `_IMAGE_EXTS` 一致）。
- **单张上限**：10 MB（sidecar `os.path.getsize` 权威校验；前端已知 size 时预拒）。
- **生命周期**：图片单轮有效——只随发起轮 `send()` 发送，不入 `DualMemory`，不入会话持久化（仅存 `[已附图片：…]` 文本前缀）；mid-run `appendInstruction` 不支持图片。
- **非视觉模型**：`supports_vision == false` 时粘贴/拖拽/`@`图片三入口禁用 + tooltip。
- **零新依赖**：不装 Tauri clipboard/fs 插件；用 DOM `paste` + `onDragDropEvent`。
- **无配置改动**：CSP 已允许 `img-src ... data: blob:`；`dragDropEnabled` 默认 true；`core:default` 已覆盖拖拽事件；DOM paste 不需 capability。
- **SDK 不改**：仅调用现有 `NativeFloodAgent.stream(attachments=...)` 与 `Attachment`。
- **中文 UI 文案**。

**Spec 参考**：`docs/superpowers/specs/2026-07-18-multimodal-image-input-design.md`

---

## File Structure

**新建**
- `sidecar/floodmind_desktop_sidecar/attachments.py` — 纯逻辑：描述符 → SDK `Attachment` 归一化 + 10MB/扩展名/越界校验 + 剪贴板暂存 + 暂存目录启动清理。独立可单测。
- `sidecar/tests/test_attachments.py` — 归一化的 pytest。
- `sidecar/tests/test_vision_config.py` — `supports_vision` 读写单测。
- `src/lib/image-thumb.ts` — 取缩略图 data URL（clipboard blob / 调 `/api/attachment/thumb`）。
- `src/components/Composer.test.tsx`（若不存在则新建）/ 在现有前端测试里追加图片用例。

**修改（后端）**
- `sidecar/floodmind_desktop_sidecar/config_api.py` — `_model_to_gui` / `read_model_config` / `_gui_model_to_sdk` 透传 `supports_vision`。
- `sidecar/floodmind_desktop_sidecar/app.py` — `/api/chat` 接 `attachments`；新增 `/api/attachment/thumb`；`create_app` 启动清空暂存目录。
- `sidecar/floodmind_desktop_sidecar/agent.py` — `Agent` 协议 + `StubAgent.stream` 加 `attachments=None`。
- `sidecar/floodmind_desktop_sidecar/floodmind_agent.py` — `FloodMindAgent.stream(messages, attachments=None)`：归一化、vision 门禁、传给 SDK。

**修改（前端）**
- `src/lib/providers.ts` — `CuratedModelDef.supportsVision` + 模型标记。
- `src/state/config-store.ts` — `ModelConfig.supportsVision`、`ModelEntry.supportsVision`、`mergeWithCurated`/`save` 透传。
- `src/state/attachment-store.ts` — 新增 `images` 切片（与 `pending` 文件引用并行）。
- `src/lib/chat-stream.ts` — `streamChat(baseUrl, messages, signal, attachments?)` + `ImageAttachment` 线类型。
- `src/state/chat-store.ts` — `send(text, attachments?)`、`Msg.images`、持久化前缀。
- `src/components/Composer.tsx` — 图片 chip、paste、drag-drop、vision 门禁、流式中禁用。
- `src/components/ComposerFilePicker.tsx` + `FilePickerModal.tsx` — 图片文件视觉区分 + 分叉到 images 通道。
- `src/components/Conversation.tsx` — 用户气泡缩略图。
- `src/app.css` — `.image-chip` / `.image-thumb` / `.composer.drag-over` / `.vision-disabled-hint`。

---

### Task 1: 核对并设置各服务商模型的视觉能力标记

**Why first:** 用户明确要求「别自以为是」——视觉能力标记必须基于各服务商官方文档，不能猜。标记过宽会把图发给纯文本模型导致 API 报错；标记过窄只是禁用入口（安全）。所以先核实再写。

**Files:**
- Modify: `src/lib/providers.ts:11-113`

**Interfaces:**
- Produces: `CuratedModelDef.supportsVision?: boolean`（其他任务只读此字段）。

- [ ] **Step 1: 核对各服务商模型是否支持图片输入（chat completions 接口）**

逐家查官方文档（用 `docsURL`），确认 `/v1/chat/completions` 是否接受 `image_url` 内容块。已知起点（需逐一核实，不要照抄）：
- 智谱 GLM-5.x：查 `https://docs.bigmodel.cn/` 是否 GLM-5 系 chat 接口多模态。
- 月之暗面 Kimi K2.x：查 `https://platform.kimi.ai/docs`。
- 通义千问 qwen-plus/flash：注意 dashscope 的多模态通常是 `qwen-vl-*`，`qwen-plus` 多为纯文本——核实。
- MiniMax：查 `https://platform.minimaxi.com/docs/`。
- DeepSeek V4：DeepSeek 历史上 chat 模型非视觉，VL 是独立模型——核实 V4 是否改变。

**保守原则**：拿不准就标 `false`（禁用入口是安全的，发图给非视觉模型会报错）。

- [ ] **Step 2: 给 `CuratedModelDef` 加 `supportsVision` 字段并标记**

在 `src/lib/providers.ts` 的 `CuratedModelDef` 接口加字段：

```ts
export interface CuratedModelDef {
  name: string;
  contextTier?: ContextTier;
  maxTokens?: number | null;
  /** 该模型 /chat/completions 是否接受 image_url 多模态输入。
   *  来自各服务商官方文档；不确定时留 false（禁用入口是安全的）。 */
  supportsVision?: boolean;
}
```

然后给经 Step 1 核实为视觉的模型加 `supportsVision: true`（例如若 Kimi/GLM-5/MiniMax 核实通过，给对应 `name` 条目加）。**未核实的不要加**。

- [ ] **Step 3: 类型检查 + 提交**

Run: `npx tsc --noEmit`
Expected: 无错误。

```bash
git add src/lib/providers.ts
git commit -m "feat(vision): mark curated models' supportsVision per provider docs"
```

---

### Task 2: 后端 `supports_vision` 配置读写

**Files:**
- Modify: `sidecar/floodmind_desktop_sidecar/config_api.py:93-100`（`_model_to_gui`）、`:169-220`（`read_model_config`）、`:225-249`（`_gui_model_to_sdk`）
- Test: `sidecar/tests/test_vision_config.py`（新建）

**Interfaces:**
- Produces: `/api/config/model` GET 返回的 `model.supportsVision: bool`；保存时 settings.json 模型条目带 `supports_vision`。

- [ ] **Step 1: 写失败测试 `sidecar/tests/test_vision_config.py`**

```python
import json
from unittest.mock import patch
from floodmind_desktop_sidecar import config_api


def _settings(tmp_path, models_with_vision):
    """Build a raw settings dict with one provider + given model vision flags."""
    models = []
    for mid, vis in models_with_vision:
        m = {"id": mid, "context_window": 32768, "default_max_tokens": 8192,
             "default_temperature": 0.3}
        if vis:
            m["supports_vision"] = True
        models.append(m)
    return {"providers": {"p1": {"name": "P1", "base_url": "http://x",
                                  "api_key": "k", "models": models}},
            "desktop": {"activeModel": models_with_vision[0][0], "activeProvider": "p1"}}


def test_read_model_exposes_supports_vision(tmp_path):
    settings_path = tmp_path / "settings.json"
    settings_path.write_text(json.dumps(_settings(tmp_path, [("vision-model", True)])), encoding="utf-8")
    with patch.object(config_api, "_settings_path", return_value=settings_path):
        cfg = config_api.read_model_config()
    assert cfg["model"]["supportsVision"] is True


def test_read_model_defaults_vision_false(tmp_path):
    settings_path = tmp_path / "settings.json"
    settings_path.write_text(json.dumps(_settings(tmp_path, [("text-model", False)])), encoding="utf-8")
    with patch.object(config_api, "_settings_path", return_value=settings_path):
        cfg = config_api.read_model_config()
    assert cfg["model"]["supportsVision"] is False


def test_write_model_persists_supports_vision(tmp_path):
    settings_path = tmp_path / "settings.json"
    settings_path.write_text(json.dumps(_settings(tmp_path, [("m1", False)])), encoding="utf-8")
    payload = {"provider": "p1", "model": "m1", "providers": [
        {"id": "p1", "name": "P1", "baseURL": "http://x",
         "models": [{"name": "m1", "maxTokens": 8192, "supportsVision": True}]}]}
    with patch.object(config_api, "_settings_path", return_value=settings_path):
        with patch("floodmind.config.settings.save_config"):
            config_api.write_model_config(payload)
        cfg = config_api.read_model_config()
    assert cfg["model"]["supportsVision"] is True
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd sidecar && python -m pytest tests/test_vision_config.py -v`
Expected: 3 个 FAIL（`KeyError: 'supportsVision'` / 未写入）。

- [ ] **Step 3: `_model_to_gui` 暴露 `supportsVision`**

`config_api.py:93`，改为：

```python
def _model_to_gui(m: dict) -> dict:
    """SDK model dict → GUI {name, maxTokens, contextSize, temperature, supportsVision}."""
    return {
        "name": m.get("id", ""),
        "maxTokens": m.get("default_max_tokens", m.get("maxTokens")),
        "contextSize": m.get("context_window", m.get("contextSize")),
        "temperature": m.get("default_temperature", m.get("temperature")),
        "supportsVision": bool(m.get("supports_vision", m.get("supportsVision", False))),
    }
```

- [ ] **Step 4: `read_model_config` 在激活模型块加 `supportsVision`**

`config_api.py:192-215`，`found` 分支里读出 vision 标志并放进 `model`：

```python
    if found:
        pid, pdata, m = found
        active_provider, active_base = pid, pdata.get("base_url", "")
        api_key_present = bool(pdata.get("api_key"))
        temperature = m.get("default_temperature", DEFAULT_TEMPERATURE)
        max_tokens = m.get("default_max_tokens", DEFAULT_MAX_TOKENS)
        supports_vision = bool(m.get("supports_vision", m.get("supportsVision", False)))
    else:
        active_provider = active_base = ""
        api_key_present = False
        temperature = DEFAULT_TEMPERATURE
        max_tokens = DEFAULT_MAX_TOKENS
        supports_vision = False
```

返回的 `model` dict 加键：

```python
    return {
        "model": {
            "provider": active_provider,
            "model": active_id,
            "temperature": temperature,
            "maxTokens": max_tokens,
            "enableReasoning": bool(desktop_cfg.get("enableReasoning", False)),
            "enableSearch": bool(desktop_cfg.get("enableSearch", False)),
            "supportsVision": supports_vision,
        },
        "apiKeyPresent": api_key_present,
        "baseURL": active_base,
        "providers": providers,
        "envOverrides": [v for v in _ENV_VARS if os.getenv(v)],
    }
```

- [ ] **Step 5: `_gui_model_to_sdk` 写回 `supports_vision`**

`config_api.py:225`，在 `sdk = dict(prev_model)` 之后、`return sdk` 之前加：

```python
    # Preserve the GUI's vision flag (curated models seed it; custom default false).
    if "supportsVision" in mi:
        sdk["supports_vision"] = bool(mi.get("supportsVision"))
    elif "supports_vision" not in sdk and "supportsVision" not in sdk:
        sdk["supports_vision"] = False
```

- [ ] **Step 6: 运行测试确认通过**

Run: `cd sidecar && python -m pytest tests/test_vision_config.py -v`
Expected: 3 PASS。

- [ ] **Step 7: 跑全量后端测试 + 提交**

Run: `cd sidecar && python -m pytest tests/ -q`
Expected: 全过（无回归）。

```bash
git add sidecar/floodmind_desktop_sidecar/config_api.py sidecar/tests/test_vision_config.py
git commit -m "feat(vision): persist and expose supports_vision in model config"
```

---

### Task 3: 后端附件归一化模块（纯逻辑，TDD）

**Files:**
- Create: `sidecar/floodmind_desktop_sidecar/attachments.py`
- Test: `sidecar/tests/test_attachments.py`

**Interfaces:**
- Produces: `normalize_attachments(descriptors, workspace_root, staging_dir) -> (List[Attachment], List[str])`（attachments + 错误消息列表）；`cleanup_staging(staging_dir)`；常量 `MAX_IMAGE_BYTES`、`IMAGE_EXTS`。

- [ ] **Step 1: 写失败测试 `sidecar/tests/test_attachments.py`**

```python
import base64
from pathlib import Path
from floodmind_desktop_sidecar.attachments import (
    normalize_attachments, MAX_IMAGE_BYTES, IMAGE_EXTS,
)


def _png_bytes():
    # 1x1 PNG.
    return base64.b64decode(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC"
    )


def test_workspace_image_resolves_to_abs_path(tmp_path):
    ws = tmp_path / "ws"; ws.mkdir()
    (ws / "chart.png").write_bytes(_png_bytes())
    atts, errs = normalize_attachments(
        [{"source": "workspace", "name": "chart.png", "mime": "image/png"}],
        str(ws), tmp_path / "stage")
    assert errs == []
    assert len(atts) == 1
    assert atts[0].kind == "image"
    assert atts[0].mime_type == "image/png"
    assert atts[0].path.endswith("chart.png")


def test_workspace_path_escape_rejected(tmp_path):
    ws = tmp_path / "ws"; ws.mkdir()
    (tmp_path / "secret.png").write_bytes(_png_bytes())
    atts, errs = normalize_attachments(
        [{"source": "workspace", "name": "../secret.png", "mime": "image/png"}],
        str(ws), tmp_path / "stage")
    assert atts == []
    assert len(errs) == 1


def test_file_source_uses_abs_path(tmp_path):
    img = tmp_path / "drop.png"; img.write_bytes(_png_bytes())
    atts, errs = normalize_attachments(
        [{"source": "file", "path": str(img), "name": "drop.png", "mime": "image/png"}],
        None, tmp_path / "stage")
    assert errs == [] and len(atts) == 1
    assert atts[0].path == str(img)


def test_clipboard_stages_to_file(tmp_path):
    stage = tmp_path / "stage"
    atts, errs = normalize_attachments(
        [{"source": "clipboard", "data": base64.b64encode(_png_bytes()).decode(),
          "mime": "image/png", "name": "pasted.png"}],
        None, stage)
    assert errs == [] and len(atts) == 1
    assert Path(atts[0].path).exists()
    assert atts[0].size == len(_png_bytes())


def test_oversized_image_rejected(tmp_path):
    img = tmp_path / "big.png"; img.write_bytes(b"\0" * (MAX_IMAGE_BYTES + 1))
    atts, errs = normalize_attachments(
        [{"source": "file", "path": str(img), "name": "big.png", "mime": "image/png"}],
        None, tmp_path / "stage")
    assert atts == [] and len(errs) == 1


def test_non_image_ext_rejected(tmp_path):
    img = tmp_path / "note.txt"; img.write_bytes(b"hi")
    atts, errs = normalize_attachments(
        [{"source": "file", "path": str(img), "name": "note.txt", "mime": "text/plain"}],
        None, tmp_path / "stage")
    assert atts == [] and len(errs) == 1


def test_multiple_attachments_partial_failure(tmp_path):
    img = tmp_path / "ok.png"; img.write_bytes(_png_bytes())
    atts, errs = normalize_attachments(
        [{"source": "file", "path": str(img), "name": "ok.png", "mime": "image/png"},
         {"source": "file", "path": str(tmp_path / "missing.png"), "name": "missing.png",
          "mime": "image/png"}],
        None, tmp_path / "stage")
    assert len(atts) == 1 and len(errs) == 1
```

- [ ] **Step 2: 运行确认失败**

Run: `cd sidecar && python -m pytest tests/test_attachments.py -v`
Expected: 全 FAIL（模块不存在）。

- [ ] **Step 3: 实现 `sidecar/floodmind_desktop_sidecar/attachments.py`**

```python
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
        staging_dir.mkdir(parents=True, exist_ok=True)
        abs_path = str(staging_dir / f"{uuid.uuid4().hex}{Path(display_name).suffix.lower()}")
        Path(abs_path).write_bytes(raw)
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
```

- [ ] **Step 4: 运行确认通过**

Run: `cd sidecar && python -m pytest tests/test_attachments.py -v`
Expected: 7 PASS。

- [ ] **Step 5: 提交**

```bash
git add sidecar/floodmind_desktop_sidecar/attachments.py sidecar/tests/test_attachments.py
git commit -m "feat(vision): attachment descriptor normalization (3 sources, 10MB cap)"
```

---

### Task 4: 后端缩略图端点 + 暂存目录启动清理

**Files:**
- Modify: `sidecar/floodmind_desktop_sidecar/app.py:77`（`create_app` 开头加清理）、`:708` 附近（新增 `/api/attachment/thumb`）
- Test: `sidecar/tests/test_attachments.py`（追加 `cleanup_staging` 用例）+ 端点用例放 `test_app.py`（若已存在则追加）

**Interfaces:**
- Produces: `GET /api/attachment/thumb?path=<rel-or-abs>` → `{content: base64, mime, size}`（仅图片、≤10MB）；`create_app` 启动清空 `<app_data>/image-staging/`。

- [ ] **Step 1: 追加 `cleanup_staging` 测试到 `test_attachments.py`**

```python
from floodmind_desktop_sidecar.attachments import cleanup_staging


def test_cleanup_staging_removes_files(tmp_path):
    stage = tmp_path / "stage"; stage.mkdir()
    (stage / "a.png").write_bytes(b"x"); (stage / "b.png").write_bytes(b"y")
    cleanup_staging(stage)
    assert list(stage.iterdir()) == []


def test_cleanup_staging_missing_dir_ok(tmp_path):
    cleanup_staging(tmp_path / "does-not-exist")  # must not raise
```

Run: `cd sidecar && python -m pytest tests/test_attachments.py -v -k cleanup`
Expected: 2 PASS（`cleanup_staging` 已在 Task 3 实现）。

- [ ] **Step 2: 写缩略图端点失败测试（追加到 `test_app.py`，仿其现有 Flask test client 模式）**

先看 `test_app.py` 顶部如何构造 `client`（通常 `from floodmind_desktop_sidecar.app import create_app` + `StubAgent`/真实 agent + `workspace_manager` mock）。在文件末尾追加：

```python
def test_attachment_thumb_returns_base64_for_workspace_image(client_with_ws, tmp_path):
    # client_with_ws fixture: a Flask test client whose workspace_manager.current_path()
    # returns tmp_path. Adjust to your existing fixture/helper in test_app.py.
    (tmp_path / "pic.png").write_bytes(b"\x89PNG\r\n\x1a\n")  # tiny png-ish bytes
    r = client_with_ws.get("/api/attachment/thumb?path=pic.png")
    assert r.status_code == 200
    data = r.get_json()
    assert data["mime"] == "image/png"
    assert data["content"]  # base64 non-empty


def test_attachment_thumb_rejects_non_image(client_with_ws, tmp_path):
    (tmp_path / "note.txt").write_text("hi")
    r = client_with_ws.get("/api/attachment/thumb?path=note.txt")
    assert r.status_code == 400


def test_attachment_thumb_rejects_oversized(client_with_ws, tmp_path):
    from floodmind_desktop_sidecar.attachments import MAX_IMAGE_BYTES
    (tmp_path / "big.png").write_bytes(b"\0" * (MAX_IMAGE_BYTES + 1))
    r = client_with_ws.get("/api/attachment/thumb?path=big.png")
    assert r.status_code == 413
```

**注**：若 `test_app.py` 没有带 workspace 的现成 fixture，照其现有创建工作区测试的方式新增一个 `client_with_ws` fixture（参考该文件里已有的「打开工作区」用例的 mock 写法）。

- [ ] **Step 3: `create_app` 开头清空暂存目录**

`app.py:80`（`app = Flask(__name__)` 之后）加：

```python
    # Clear clipboard-image staging orphans left by a previous session.
    try:
        from .attachments import cleanup_staging
        from .workspace import _app_data_dir
        cleanup_staging(_app_data_dir() / "image-staging")
    except Exception as e:  # pragma: no cover - never block startup over cleanup
        print(f"[sidecar] image-staging cleanup failed: {e}", file=sys.stderr)
```

- [ ] **Step 4: 实现 `/api/attachment/thumb` 端点**

在 `app.py` 的 `/api/workspace/file` 路由（`:708`）之后、`if workspace_manager is not None:`（`:766`）之前加：

```python
    @app.get("/api/attachment/thumb")
    def attachment_thumb():
        """Return base64 + mime of an image for thumbnail display.

        ``path`` may be workspace-relative (resolved against the current
        workspace) or absolute (a drag-drop target the user explicitly attached).
        Image extensions only, 10MB cap. CORS is already restricted to the Tauri
        webview origins, and only images are returned — reading a file the user
        is actively attaching for display is intended.
        """
        from .attachments import IMAGE_EXTS, MAX_IMAGE_BYTES
        raw_path = request.args.get("path", "").strip()
        if not raw_path:
            return jsonify({"error": "需要提供路径"}), 400
        if os.path.isabs(raw_path):
            target = Path(raw_path)
        else:
            workspace = _require_workspace()
            if not workspace:
                return jsonify({"error": "未打开工作区"}), 400
            target = (Path(workspace) / raw_path).resolve()
            root = Path(workspace).resolve()
            if root not in target.parents and target != root:
                return jsonify({"error": "禁止访问"}), 403
        target = target.resolve()
        ext = target.suffix.lower()
        if ext not in IMAGE_EXTS:
            return jsonify({"error": "仅支持图片"}), 400
        if not target.exists() or not target.is_file():
            return jsonify({"error": "未找到"}), 404
        try:
            size = target.stat().st_size
        except OSError:
            return jsonify({"error": "无法读取"}), 500
        if size > MAX_IMAGE_BYTES:
            return jsonify({"error": "图片过大（>10MB）"}), 413
        mime = f"image/{ext.lstrip('.').lower()}" if ext != ".jpg" else "image/jpeg"
        if ext == ".jpg":
            mime = "image/jpeg"
        content = base64.b64encode(target.read_bytes()).decode()
        return jsonify({"content": content, "mime": mime, "size": size})
```

- [ ] **Step 5: 运行确认通过**

Run: `cd sidecar && python -m pytest tests/test_app.py tests/test_attachments.py -v`
Expected: 全 PASS（含新端点 3 + cleanup 2）。

- [ ] **Step 6: 提交**

```bash
git add sidecar/floodmind_desktop_sidecar/app.py sidecar/tests/test_app.py sidecar/tests/test_attachments.py
git commit -m "feat(vision): /api/attachment/thumb endpoint + staging cleanup on start"
```

---

### Task 5: 后端把 attachments 接入 `/api/chat` → SDK

**Files:**
- Modify: `sidecar/floodmind_desktop_sidecar/agent.py:13-16`（Protocol）、`:82-92`（StubAgent）
- Modify: `sidecar/floodmind_desktop_sidecar/floodmind_agent.py:1024-1099`（`stream`）
- Modify: `sidecar/floodmind_desktop_sidecar/app.py:116-134`（`/api/chat`）
- Test: `sidecar/tests/test_floodmind_agent.py`（追加）

**Interfaces:**
- Consumes: `attachments.normalize_attachments`、`Attachment`（SDK）。
- Produces: `FloodMindAgent.stream(messages, attachments=None)`；`/api/chat` body 接 `attachments`。

- [ ] **Step 1: 写失败测试（追加到 `test_floodmind_agent.py`）**

需要一个能驱动 `FloodMindAgent.stream` 但不真实跑 SDK 的方式——用 `FloodMindAgent.__new__` 裸实例 + 替换 `self._agent` 为假对象（沿用该文件已有的「bare instance」测试惯例，或新增）：

```python
def test_stream_passes_attachments_to_agent(monkeypatch, tmp_path):
    """stream() normalizes descriptors and forwards SDK Attachments to agent.stream."""
    import base64
    from floodmind_desktop_sidecar import floodmind_agent as fa

    captured = {}

    class FakeAgent:
        def stream(self, user_text, attachments=None, abort_check=None):
            captured["text"] = user_text
            captured["attachments"] = list(attachments or [])
            yield {"type": "text", "content": "ok"}
            yield {"type": "done"}

    agent = fa.FloodMindAgent.__new__(fa.FloodMindAgent)
    agent._agent = FakeAgent()
    agent._workspace_manager = None
    agent._stream_lock = None
    agent._fg_lock = __import__("contextlib").nullcontext().__class__
    agent._abort = __import__("threading").Event()
    agent._abort.clear()
    agent._output_dir = None
    monkeypatch.setattr(fa.FloodMindAgent, "_active_supports_vision", lambda self: True)
    monkeypatch.setattr(fa.FloodMindAgent, "_current_workspace_path", lambda self: None)

    png = base64.b64decode(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC")
    img = tmp_path / "x.png"; img.write_bytes(png)
    desc = [{"source": "file", "path": str(img), "name": "x.png", "mime": "image/png"}]
    events = list(agent.stream([{"role": "user", "content": "看图"}], attachments=desc))
    assert captured["text"] == "看图"
    assert len(captured["attachments"]) == 1
    assert captured["attachments"][0].kind == "image"
    assert any(e.get("type") == "done" for e in events)


def test_stream_non_vision_model_yields_error_and_drops_attachments(monkeypatch, tmp_path):
    import base64
    from floodmind_desktop_sidecar import floodmind_agent as fa

    captured = {}

    class FakeAgent:
        def stream(self, user_text, attachments=None, abort_check=None):
            captured["attachments"] = list(attachments or [])
            yield {"type": "done"}

    agent = fa.FloodMindAgent.__new__(fa.FloodMindAgent)
    agent._agent = FakeAgent()
    agent._workspace_manager = None
    agent._stream_lock = None
    agent._abort = __import__("threading").Event(); agent._abort.clear()
    agent._output_dir = None
    monkeypatch.setattr(fa.FloodMindAgent, "_active_supports_vision", lambda self: False)
    monkeypatch.setattr(fa.FloodMindAgent, "_current_workspace_path", lambda self: None)

    png = base64.b64decode(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC")
    img = tmp_path / "x.png"; img.write_bytes(png)
    events = list(agent.stream([{"role": "user", "content": "hi"}],
                               attachments=[{"source": "file", "path": str(img), "name": "x.png"}]))
    assert captured["attachments"] == []
    assert any("不支持图片" in e.get("content", "") for e in events if e.get("type") == "error")
```

**注**：若 `FloodMindAgent.__new__` 裸实例在 `_fg` / `getattr` 守卫下仍缺属性，按报错补 `agent.<attr> = ...`（参考 `stream()` 里 `getattr(self, "_stream_lock", None)` 等守卫，使其对裸实例安全）。

- [ ] **Step 2: 运行确认失败**

Run: `cd sidecar && python -m pytest tests/test_floodmind_agent.py -v -k "attachments or vision_model"`
Expected: FAIL（`stream()` 不接 `attachments` / 无 vision 检查）。

- [ ] **Step 3: 更新 `Agent` 协议与 `StubAgent`**

`agent.py:14` 协议签名：

```python
    def stream(self, messages: list[Message], attachments: list | None = None) -> Iterator[dict]:
        """Yield event dicts. ``attachments`` is an optional list of front-end
        image descriptors (workspace/file/clipboard) to attach to this turn."""
        ...
```

`StubAgent.stream`（`:85`）签名同步加 `attachments=None`（忽略即可）。

- [ ] **Step 4: 给 `FloodMindAgent` 加 `_active_supports_vision`**

`floodmind_agent.py`，在 `_resolve_llm` 附近加：

```python
    def _active_supports_vision(self) -> bool:
        """Whether the desktop's active model accepts image input.

        resolve_model() is the SDK's single source of truth; falling back to
        False on any error disables the image path rather than sending images to
        a model that would error out."""
        try:
            from floodmind.config.model_resolver import resolve_model
            desktop = self._desktop_block()
            rm = resolve_model(model_key=desktop.get("activeModel") or None,
                               provider_id=desktop.get("activeProvider") or None)
            return bool(getattr(rm, "supports_vision", False))
        except Exception:
            return False
```

- [ ] **Step 5: 改 `FloodMindAgent.stream` 接 attachments + vision 门禁**

`floodmind_agent.py:1024`，签名改为：

```python
    def stream(self, messages: list[Message], attachments: list | None = None) -> Iterator[dict]:
```

在 `abort_check = abort.is_set ...`（`:1052`）之后、`try:` 之前插入归一化 + 门禁：

```python
            # Normalize any image attachments into SDK Attachment objects with a
            # real on-disk path. Errors are surfaced as NDJSON error events but
            # do not abort the whole turn (one bad image shouldn't kill the run).
            sdk_attachments: list = []
            if attachments:
                from .attachments import normalize_attachments
                from .workspace import _app_data_dir
                staging_dir = _app_data_dir() / "image-staging"
                ws_root = self._current_workspace_path()
                sdk_attachments, att_errors = normalize_attachments(attachments, ws_root, staging_dir)
                # Non-vision model: drop ALL images and tell the user. The
                # front-end also disables entry; this is the authoritative
                # back-stop so a stale GUI can't send images to a text model.
                if sdk_attachments and not self._active_supports_vision():
                    for _ in sdk_attachments:
                        pass
                    sdk_attachments = []
                    yield {"type": "error",
                           "content": "当前模型不支持图片输入，请在设置中切换到视觉模型。"}
                for msg in att_errors:
                    yield {"type": "error", "content": f"⚠️ {msg}"}
```

然后把 `agent.stream(user_text, **stream_kwargs)`（`:1071`）改为把 attachments 合进 kwargs：

```python
                stream_kwargs = {"abort_check": abort_check} if abort_check is not None else {}
                if sdk_attachments:
                    stream_kwargs["attachments"] = sdk_attachments
                for raw in agent.stream(user_text, **stream_kwargs):
```

- [ ] **Step 6: 改 `/api/chat` 路由读 attachments**

`app.py:116`：

```python
    @app.post("/api/chat")
    def chat():
        body = request.get_json(silent=True) or {}
        messages: list[Message] = body.get("messages", [])
        attachments = body.get("attachments") or None
        if not messages:
            return jsonify({"error": "messages must be a non-empty list"}), 400

        def generate():
            gen = agent.stream(messages, attachments=attachments)
            try:
                for event in gen:
                    yield json.dumps(event, ensure_ascii=False) + "\n"
            finally:
                gen.close()

        return Response(generate(), mimetype="application/x-ndjson")
```

- [ ] **Step 7: 运行确认通过**

Run: `cd sidecar && python -m pytest tests/ -q`
Expected: 全 PASS。

- [ ] **Step 8: 提交**

```bash
git add sidecar/floodmind_desktop_sidecar/agent.py sidecar/floodmind_desktop_sidecar/floodmind_agent.py sidecar/floodmind_desktop_sidecar/app.py sidecar/tests/test_floodmind_agent.py
git commit -m "feat(vision): wire attachments through /api/chat to NativeFloodAgent.stream"
```

---

### Task 6: 前端 `supportsVision` 透传（config-store + providers）

**Files:**
- Modify: `src/state/config-store.ts:5-42`（类型）、`:49-88`（mergeWithCurated）、`:149-170`（load）、`:185-203`（save）
- Test: 现有 `config-store` 测试（若没有则新增 `src/state/config-store.test.ts`）

**Interfaces:**
- Produces: `ModelConfig.supportsVision: boolean`、`ModelEntry.supportsVision?: boolean`；`load()` 读出、`save()` 写入。

- [ ] **Step 1: 写失败测试 `src/state/config-store.test.ts`（若已存在则追加）**

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { useConfigStore } from "./config-store";

const baseUrl = "http://x";
vi.mock("../lib/sidecar-client", () => ({ getBaseUrl: async () => baseUrl }));

function mockGetModel(payload: unknown) {
  global.fetch = vi.fn(async (url: string) => {
    if (String(url).endsWith("/api/config/model")) {
      return { ok: true, json: async () => payload } as any;
    }
    return { ok: true, json: async () => ({}) } as any;
  }) as any;
}

beforeEach(() => useConfigStore.setState({ model: null, providers: [] }));

describe("config-store supportsVision", () => {
  it("reads active model supportsVision from /api/config/model", async () => {
    mockGetModel({ model: { provider: "zhipu", model: "glm-5.2", supportsVision: true },
                   providers: [], apiKeyPresent: true, baseURL: "" });
    await useConfigStore.getState().load();
    expect(useConfigStore.getState().model?.supportsVision).toBe(true);
  });

  it("defaults supportsVision to false when absent", async () => {
    mockGetModel({ model: { provider: "deepseek", model: "deepseek-v4-flash" },
                   providers: [], apiKeyPresent: true, baseURL: "" });
    await useConfigStore.getState().load();
    expect(useConfigStore.getState().model?.supportsVision).toBe(false);
  });

  it("includes supportsVision in save payload", async () => {
    let sent: any = null;
    global.fetch = vi.fn(async (url: string, init?: any) => {
      if (String(url).endsWith("/api/config/model") && init?.method === "POST") {
        sent = JSON.parse(init.body);
      }
      return { ok: true, json: async () => ({ model: { model: "glm-5.2", supportsVision: true } }) } as any;
    }) as any;
    await useConfigStore.getState().save({
      provider: "zhipu", model: "glm-5.2",
      providers: [{ id: "zhipu", name: "智谱", baseURL: "x", apiKey: "",
                    models: [{ name: "glm-5.2", maxTokens: 131072, supportsVision: true }] }],
    });
    expect(sent.providers[0].models[0].supportsVision).toBe(true);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run src/state/config-store.test.ts`
Expected: FAIL（类型缺 `supportsVision`）。

- [ ] **Step 3: 类型加字段**

`config-store.ts`：

```typescript
export interface ModelConfig {
  provider: string;
  model: string;
  temperature: number;
  maxTokens: number;
  enableReasoning: boolean;
  enableSearch: boolean;
  supportsVision: boolean;
}
export interface ModelEntry {
  name: string;
  maxTokens: number | null;
  contextSize?: number | null;
  temperature?: number | null;
  supportsVision?: boolean;
}
```

- [ ] **Step 4: `mergeWithCurated` 透传 supportsVision**

`config-store.ts:54-78`，`mergedModels` 与 extra 都带上：

```typescript
      const mergedModels = def.models.map((dm) => {
        const savedModel = savedModelMap.get(dm.name);
        const defaultTokens = getTierDefaultTokens(dm);
        return {
          name: dm.name,
          maxTokens: savedModel?.maxTokens ?? defaultTokens ?? null,
          supportsVision: dm.supportsVision ?? false,
        };
      });
      const fixedNames = new Set(def.models.map((m) => m.name));
      const extraModels = (savedProvider.models || [])
        .filter((m) => !fixedNames.has(m.name))
        .map((m) => ({
          name: m.name,
          maxTokens: m.maxTokens ?? null,
          contextSize: m.contextSize ?? null,
          temperature: m.temperature ?? null,
          supportsVision: m.supportsVision ?? false,
        }));
```

未命中 curated 的 fallback 分支（`:80-86`）也加 `supportsVision: dm.supportsVision ?? false`。

- [ ] **Step 5: `load()` 读出 supportsVision**

`config-store.ts:159-166`：

```typescript
      set({
        model: { ...data.model, supportsVision: !!data.model?.supportsVision } as any,
        providers: mergeWithCurated(data.providers || []),
        apiKeyPresent: !!data.apiKeyPresent,
        baseURL: data.baseURL || "",
        envOverrides: data.envOverrides || [],
        loading: false,
      });
```

- [ ] **Step 6: `save()` 发送 supportsVision**

`config-store.ts:194-199`，模型条目加字段：

```typescript
              .map((m) => {
                const entry: Record<string, unknown> = { name: m.name.trim(), maxTokens: m.maxTokens };
                if (m.contextSize != null) entry.contextSize = m.contextSize;
                if (m.temperature != null) entry.temperature = m.temperature;
                entry.supportsVision = !!m.supportsVision;
                return entry;
              }),
```

- [ ] **Step 7: 运行确认通过**

Run: `npx vitest run src/state/config-store.test.ts && npx tsc --noEmit`
Expected: 3 PASS + 类型干净。

- [ ] **Step 8: 提交**

```bash
git add src/state/config-store.ts src/state/config-store.test.ts
git commit -m "feat(vision): thread supportsVision through config-store load/save"
```

---

### Task 7: 前端 attachment-store 图片切片

**Files:**
- Modify: `src/state/attachment-store.ts`
- Test: `src/state/attachment-store.test.ts`（新建）

**Interfaces:**
- Produces: `useAttachmentStore.images: ImageItem[]`；`addImages(items)`、`removeImage(id)`、`clearImages()`。
  - `ImageItem = { id: string; name: string; mime: string; thumb: string; source: "workspace"|"file"|"clipboard"; rel?: string; absPath?: string; data?: string }`

- [ ] **Step 1: 写失败测试 `src/state/attachment-store.test.ts`**

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { useAttachmentStore } from "./attachment-store";

beforeEach(() => useAttachmentStore.getState().clear());

describe("attachment-store images", () => {
  it("adds and removes image items by id", () => {
    const { addImages, removeImage } = useAttachmentStore.getState();
    addImages([{ id: "i1", name: "a.png", mime: "image/png", thumb: "data:x",
                source: "clipboard", data: "AAAA" }]);
    expect(useAttachmentStore.getState().images).toHaveLength(1);
    removeImage("i1");
    expect(useAttachmentStore.getState().images).toHaveLength(0);
  });

  it("clearImages empties images but leaves pending file refs", () => {
    const s = useAttachmentStore.getState();
    s.add(["foo.txt"]);
    s.addImages([{ id: "i1", name: "a.png", mime: "image/png", thumb: "",
                  source: "workspace", rel: "a.png" }]);
    s.clearImages();
    expect(useAttachmentStore.getState().images).toHaveLength(0);
    expect(useAttachmentStore.getState().pending).toEqual(["foo.txt"]);
  });

  it("toWire maps each source to its descriptor shape", () => {
    const s = useAttachmentStore.getState();
    s.addImages([
      { id: "w", name: "w.png", mime: "image/png", thumb: "", source: "workspace", rel: "sub/w.png" },
      { id: "f", name: "d.png", mime: "image/png", thumb: "", source: "file", absPath: "D:/d.png" },
      { id: "c", name: "p.png", mime: "image/png", thumb: "", source: "clipboard", data: "AAAA" },
    ]);
    const wire = useAttachmentStore.getState().toWire();
    expect(wire).toEqual([
      { source: "workspace", name: "sub/w.png", mime: "image/png" },
      { source: "file", path: "D:/d.png", mime: "image/png" },
      { source: "clipboard", data: "AAAA", mime: "image/png" },
    ]);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run src/state/attachment-store.test.ts`
Expected: FAIL（无 images 字段）。

- [ ] **Step 3: 实现**

替换 `src/state/attachment-store.ts` 全文：

```typescript
import { create } from "zustand";

export type ImageSource = "workspace" | "file" | "clipboard";

export interface ImageItem {
  id: string;
  name: string;
  mime: string;
  /** data: URL or blob: URL for display (CSP allows both). */
  thumb: string;
  source: ImageSource;
  /** workspace-relative path (source=workspace). */
  rel?: string;
  /** absolute path (source=file, drag-drop). */
  absPath?: string;
  /** base64 without prefix (source=clipboard). */
  data?: string;
}

/** Wire descriptor sent to /api/chat (matches sidecar normalize_attachment). */
export type ImageAttachmentWire =
  | { source: "workspace"; name: string; mime: string }
  | { source: "file"; path: string; mime: string }
  | { source: "clipboard"; data: string; mime: string };

interface AttachmentState {
  pending: string[];            // workspace file references (@ non-image)
  images: ImageItem[];          // image attachments (visual channel)
  add: (paths: string[]) => void;
  remove: (path: string) => void;
  clear: () => void;
  addImages: (items: ImageItem[]) => void;
  removeImage: (id: string) => void;
  clearImages: () => void;
  toWire: () => ImageAttachmentWire[];
}

export const useAttachmentStore = create<AttachmentState>((set, get) => ({
  pending: [],
  images: [],
  add: (paths) => set((s) => ({ pending: Array.from(new Set([...s.pending, ...paths])) })),
  remove: (path) => set((s) => ({ pending: s.pending.filter((p) => p !== path) })),
  clear: () => set({ pending: [], images: [] }),
  addImages: (items) => set((s) => ({ images: [...s.images, ...items] })),
  removeImage: (id) => set((s) => ({ images: s.images.filter((i) => i.id !== id) })),
  clearImages: () => set((s) => ({ images: [] })),
  toWire: () =>
    get().images.map((i) => {
      if (i.source === "workspace") return { source: "workspace", name: i.rel ?? i.name, mime: i.mime };
      if (i.source === "file") return { source: "file", path: i.absPath ?? "", mime: i.mime };
      return { source: "clipboard", data: i.data ?? "", mime: i.mime };
    }),
}));
```

**注意**：原来 `clear()` 同时清 pending——保持不变（发送后全清）。新增 `clearImages` 仅清图片，但 `doSend` 用 `clear()`（两者都清）。

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run src/state/attachment-store.test.ts`
Expected: 3 PASS。

- [ ] **Step 5: 跑现有 attachment 相关测试 + 提交**

Run: `npx vitest run && npx tsc --noEmit`
Expected: 无回归 + 类型干净。

```bash
git add src/state/attachment-store.ts src/state/attachment-store.test.ts
git commit -m "feat(vision): image attachments slice in attachment-store"
```

---

### Task 8: 前端 chat-stream + chat-store 传 attachments + Msg.images + 持久化前缀

**Files:**
- Modify: `src/lib/chat-stream.ts:1-2,49-59`
- Modify: `src/state/chat-store.ts:35,58-74,222-247,286-300`
- Test: 现有 `src/state/chat-store.test.ts`（追加）

**Interfaces:**
- Consumes: `attachment-store.toWire()`、`ImageItem`。
- Produces: `streamChat(baseUrl, messages, signal, attachments?)`；`useChatStore.send(text, attachments?, images?)`；`Msg`（user）带 `images?`。

- [ ] **Step 1: 写失败测试（追加到 `chat-store.test.ts`，仿其现有 mock 模式）**

```typescript
it("send forwards attachments in /api/chat body and tags the user turn with images", async () => {
  const calls: any[] = [];
  global.fetch = vi.fn(async (url: string, init?: any) => {
    if (String(url).endsWith("/api/chat")) calls.push(JSON.parse(init.body));
    // NDJSON stream: a single done event.
    const enc = new TextEncoder();
    const stream = new ReadableStream({ start(c) { c.enqueue(enc.encode(JSON.stringify({ type: "done" }) + "\n")); c.close(); } });
    return { ok: true, body: stream } as any;
  }) as any;

  await useChatStore.getState().send("看图",
    [{ source: "file", path: "D:/x.png", mime: "image/png" }],
    [{ name: "x.png", thumb: "data:..." }]);

  expect(calls[0].attachments).toEqual([{ source: "file", path: "D:/x.png", mime: "image/png" }]);
  const userTurn = useChatStore.getState().turns.find((t) => t.role === "user");
  expect((userTurn as any).images).toEqual([{ name: "x.png", thumb: "data:..." }]);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run src/state/chat-store.test.ts`
Expected: FAIL（`send` 签名不匹配）。

- [ ] **Step 3: `chat-stream.ts` 加 attachments**

`chat-stream.ts:1`（类型）+ `:49`（签名）+ body：

```typescript
export type ChatMessage = { role: string; content: string };

export type ImageAttachmentWire =
  | { source: "workspace"; name: string; mime: string }
  | { source: "file"; path: string; mime: string }
  | { source: "clipboard"; data: string; mime: string };

// ...

export async function* streamChat(
  baseUrl: string,
  messages: ChatMessage[],
  signal?: AbortSignal,
  attachments?: ImageAttachmentWire[],
): AsyncGenerator<ChatEvent> {
  const res = await fetch(`${baseUrl}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages, attachments: attachments ?? [] }),
    signal,
  });
  // …（其余读取循环不变）
```

- [ ] **Step 4: `chat-store.ts` 类型 + `send` 签名**

`chat-store.ts:35`（user Msg 加 images）：

```typescript
export type Msg =
  | { id: string; role: "user"; content: string; images?: { name: string; thumb: string }[] }
  | AssistantTurn;
```

`ChatState.send`（`:67`）：

```typescript
  send: (text: string, attachments?: import("../lib/chat-stream").ImageAttachmentWire[],
         images?: { name: string; thumb: string }[]) => Promise<void>;
```

`send` 实现（`:222`）：把 user turn 带 images，并传 attachments 给 streamChat：

```typescript
  async send(text: string, attachments?: any[], images?: { name: string; thumb: string }[]) {
    if (!text.trim()) return;
    if (get().streaming) return get().appendInstruction(text);

    const controller = new AbortController();
    const startLen = get().turns.length;
    set((s) => ({
      turns: [
        ...s.turns,
        { id: nextTurnId(), role: "user", content: text, images },
        { id: nextTurnId(), role: "assistant", blocks: [], usage: null, done: false },
      ],
      streaming: true,
      abortController: controller,
    }));

    let errored = false;
    try {
      const baseUrl = await getBaseUrl();
      for await (const ev of streamChat(baseUrl, [{ role: "user", content: text }], controller.signal, attachments)) {
        // …（不变）
      }
    } catch (e) {
      // …（不变）
    } finally {
      // …（finalize 不变，但持久化 pair 时把 user turn 的 images 剥离并加前缀 —— 见 Step 5）
    }
  },
```

- [ ] **Step 5: 持久化时剥离 images、加文本前缀**

`chat-store.ts` 的 `/turns` POST 处（`:293-300`），把 `pair` 序列化成「无 images、content 带前缀」的版本再发：

```typescript
                const persistedPair = pair.map((t) => {
                  if (t.role === "user" && (t as any).images?.length) {
                    const names = (t as any).images.map((i: any) => i.name).join(", ");
                    return { id: t.id, role: "user",
                             content: `[已附图片：${names}]\n${t.content}` };
                  }
                  // assistant turns + image-less user turns as-is (drop any images key)
                  const { images: _drop, ...rest }: any = t;
                  return rest;
                });
                const r = await fetch(`${b}/api/conversations/${cid}/turns`, {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ turns: persistedPair }),
                });
```

- [ ] **Step 6: 运行确认通过**

Run: `npx vitest run src/state/chat-store.test.ts && npx tsc --noEmit`
Expected: PASS + 类型干净。

- [ ] **Step 7: 提交**

```bash
git add src/lib/chat-stream.ts src/state/chat-store.ts src/state/chat-store.test.ts
git commit -m "feat(vision): send attachments + Msg.images + persistence prefix"
```

---

### Task 9: 前端 Composer 图片 chip + 粘贴 + 拖拽 + vision 门禁

**Files:**
- Modify: `src/components/Composer.tsx`
- Create: `src/lib/image-thumb.ts`
- Modify: `src/app.css`（图片 chip / drag-over / disabled hint）
- Test: `src/components/Composer.test.tsx`（若已有则追加 vision-gate / paste 用例）

**Interfaces:**
- Consumes: `attachment-store`（images 切片）、`config-store`（`model.supportsVision`）、`chat-store`（`send`）、`chat-stream`（`ImageAttachmentWire`）。

- [ ] **Step 1: 写 `src/lib/image-thumb.ts`（取缩略图 data URL）**

```typescript
import { getBaseUrl } from "./sidecar-client";

const IMAGE_EXTS = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"];
export const isImageName = (name: string): boolean =>
  IMAGE_EXTS.some((e) => name.toLowerCase().endsWith(e));

export function mimeForName(name: string): string {
  const n = name.toLowerCase();
  if (n.endsWith(".jpg") || n.endsWith(".jpeg")) return "image/jpeg";
  if (n.endsWith(".png")) return "image/png";
  if (n.endsWith(".gif")) return "image/gif";
  if (n.endsWith(".webp")) return "image/webp";
  if (n.endsWith(".bmp")) return "image/bmp";
  return "image/png";
}

/** Clipboard File → data URL (bytes already in hand, no round-trip). */
export function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

/** Workspace-relative or absolute image path → data URL via sidecar thumb endpoint. */
export async function pathToDataUrl(path: string): Promise<string> {
  const b = await getBaseUrl();
  const r = await fetch(`${b}/api/attachment/thumb?path=${encodeURIComponent(path)}`);
  if (!r.ok) throw new Error(`缩略图获取失败 (${r.status})`);
  const { content, mime } = await r.json();
  return `data:${mime};base64,${content}`;
}
```

- [ ] **Step 2: 写失败测试（追加到 `Composer.test.tsx`）**

测试三件事：vision 关闭时 `＋` 按钮 disabled + 有提示；粘贴图片事件调用 `addImages`；vision 开启时图片 chip 渲染并带移除按钮。仿该文件现有「渲染 Composer + 模拟 store」的写法。示例骨架（按现有 mock 方式补全 fetch / store 初始态）：

```typescript
it("disables image affordances when model lacks vision", () => {
  useConfigStore.setState({ model: { provider: "deepseek", model: "deepseek-v4-flash",
    temperature: 0.3, maxTokens: 8192, enableReasoning: false, enableSearch: false,
    supportsVision: false } as any });
  render(<Composer />);
  const addBtn = screen.getByLabelText("引用工作区文件");
  expect(addBtn).toBeDisabled();
});

it("paste image adds to image store", async () => {
  useConfigStore.setState({ model: { /* …supportsVision: true */ } as any });
  const blob = new Blob([new Uint8Array([1])], { type: "image/png" });
  render(<Composer />);
  const ta = screen.getByLabelText("任务输入");
  const file = new File([blob], "shot.png", { type: "image/png" });
  const dt = new DataTransfer();
  Object.defineProperty(dt, "items", { value: [{ kind: "file", type: "image/png", getAsFile: () => file }] });
  fireEvent.paste(ta, { clipboardData: dt });
  await waitFor(() => expect(useAttachmentStore.getState().images.length).toBe(1));
});
```

- [ ] **Step 3: 运行确认失败**

Run: `npx vitest run src/components/Composer.test.tsx`
Expected: FAIL。

- [ ] **Step 4: 改 `Composer.tsx` —— 加 vision 选择器 + 图片 store 绑定**

在现有 hooks 区（`:32-38` 附近）加：

```typescript
  const supportsVision = useConfigStore((s) => !!s.model?.supportsVision);
  const images = useAttachmentStore((s) => s.images);
  const addImages = useAttachmentStore((s) => s.addImages);
  const removeImage = useAttachmentStore((s) => s.removeImage);
```

- [ ] **Step 5: `buildMessage` 旁加 `buildSendArgs`，`doSend` 传 attachments + images 快照**

```typescript
  function doSend() {
    const msg = buildMessage();
    if (!msg) return;
    const wire = useAttachmentStore.getState().toWire();
    const imageSnap = images.map((i) => ({ name: i.name, thumb: i.thumb }));
    send(msg, wire.length ? wire : undefined, imageSnap.length ? imageSnap : undefined);
    setText("");
    setSlashItem(null);
    clearAttachments();
    if (textareaRef.current) textareaRef.current.style.height = "auto";
  }
```

- [ ] **Step 6: 图片 chip 渲染（在 `.composer-attachments` 旁）**

在 `attachments.length > 0` 块之后加：

```tsx
        {images.length > 0 && (
          <div className="composer-attachments">
            {images.map((im) => (
              <span key={im.id} className="image-chip" title={im.name}>
                <img className="image-thumb" src={im.thumb} alt={im.name} />
                <span className="attachment-name">{im.name}</span>
                <button
                  type="button"
                  className="attachment-remove"
                  onClick={() => removeImage(im.id)}
                  aria-label={`移除 ${im.name}`}
                >✕</button>
              </span>
            ))}
          </div>
        )}
```

- [ ] **Step 7: 粘贴处理（textarea onPaste）**

```tsx
  async function onPaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    if (!supportsVision) return;
    const items = Array.from(e.clipboardData?.items ?? []);
    const imageItems = items.filter((it) => it.kind === "file" && it.type.startsWith("image/"));
    if (!imageItems.length) return;
    e.preventDefault();
    const next = [];
    for (const it of imageItems) {
      const file = it.getAsFile();
      if (!file) continue;
      if (file.size > 10 * 1024 * 1024) continue; // 10MB cap
      const dataUrl = await fileToDataUrl(file);
      const name = file.name || `pasted-${Date.now()}.png`;
      next.push({ id: `paste-${Date.now()}-${name}`, name, mime: file.type || mimeForName(name),
                  thumb: dataUrl, source: "clipboard" as const,
                  data: dataUrl.slice(dataUrl.indexOf(",") + 1) });
    }
    if (next.length) addImages(next);
  }
```

textarea 加 `onPaste={onPaste}`。

- [ ] **Step 8: 拖拽处理（整窗 `onDragDropEvent`）**

文件顶部 import：`import { getCurrentWindow } from "@tauri-apps/api/window";`（Tauri 2）。组件内加 effect：

```typescript
  const [dragOver, setDragOver] = useState(false);
  useEffect(() => {
    const win = getCurrentWindow();
    let unlisten: (() => void) | undefined;
    let active = true;
    (async () => {
      unlisten = await win.onDragDropEvent(async (ev) => {
        if (!supportsVision) return;
        const payload = ev.payload as { type: string; paths?: string[] };
        if (payload.type === "enter" || payload.type === "over") {
          if ((payload.paths ?? []).some((p) => isImageName(p))) setDragOver(true);
        } else {
          setDragOver(false);
          if (payload.type === "drop") {
            const imgs = (payload.paths ?? []).filter((p) => isImageName(p));
            const next = [];
            for (const p of imgs) {
              try {
                const thumb = await pathToDataUrl(p);
                next.push({ id: `drop-${Date.now()}-${p}`, name: p.split(/[\\/]/).pop() || p,
                  mime: mimeForName(p), thumb, source: "file" as const, absPath: p });
              } catch { /* skip unreadable */ }
            }
            if (next.length) addImages(next);
          }
        }
      });
      if (!active && unlisten) unlisten();
    })();
    return () => { active = false; if (unlisten) unlisten(); };
  }, [supportsVision, addImages]);
```

`<form className="composer">` 改为 `<form className={dragOver ? "composer drag-over" : "composer"}>`。

- [ ] **Step 9: vision 门禁：`＋` 按钮 disabled + tooltip**

`＋` 按钮（`:233-242`）：

```tsx
            <button
              className="ctx-pill"
              type="button"
              disabled={!current || streaming || !supportsVision}
              onClick={() => setFilePickerOpen(true)}
              title={!supportsVision ? "当前模型不支持图片输入，请在设置中切换视觉模型"
                     : current ? "引用工作区文件" : "请先打开一个工作区"}
              aria-label="引用工作区文件"
            >
              ＋
            </button>
```

- [ ] **Step 10: CSS（追加到 `src/app.css` 末尾的 composer 区）**

```css
.image-chip {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  max-width: 200px;
  padding: 0.15rem 0.4rem 0.15rem 0.15rem;
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: 8px;
  font-size: 12px;
  color: var(--fg-secondary);
}
.image-thumb {
  width: 28px;
  height: 28px;
  object-fit: cover;
  border-radius: 4px;
  display: block;
}
.composer.drag-over {
  outline: 2px dashed var(--accent, #4c8bf5);
  outline-offset: -2px;
  background: var(--surface-2);
}
```

- [ ] **Step 11: 运行确认通过 + 类型**

Run: `npx vitest run src/components/Composer.test.tsx && npx tsc --noEmit`
Expected: PASS + 类型干净。

- [ ] **Step 12: 提交**

```bash
git add src/components/Composer.tsx src/lib/image-thumb.ts src/app.css src/components/Composer.test.tsx
git commit -m "feat(vision): composer image chips, paste, drag-drop, vision gate"
```

---

### Task 10: 前端 `@` 选择器图片分叉

**Files:**
- Modify: `src/components/ComposerFilePicker.tsx:88-98`
- Modify: `src/components/FilePickerModal.tsx:30,69,100-105`
- Modify: `src/components/Composer.tsx:91-101`（`insertFile`）、`:332-340`（modal onConfirm）

**Goal:** 选中图片文件 → 进 `images` 通道（视觉）；非图片 → 维持 `pending` 文件引用。vision 关闭时图片文件不可选。

- [ ] **Step 1: 写失败测试（追加到相关测试文件）**

`ComposerFilePicker`：选中 `.png` 时 `onSelect` 收到的路径仍返回（由 Composer 决定分流）；只断言图片行带 `image` 标记 class（可选）。重点测 Composer 的分流：mock `ComposerFilePicker` 后调用 `insertFile("chart.png")` → `useAttachmentStore.getState().images` 增长、`pending` 不增长。

```typescript
it("insertFile routes images to the image channel", async () => {
  useConfigStore.setState({ model: { /* supportsVision: true */ } as any });
  // render Composer, drive insertFile via the @ picker (mock listFiles to return chart.png)
  // … then:
  expect(useAttachmentStore.getState().images.some((i) => i.name === "chart.png")).toBe(true);
  expect(useAttachmentStore.getState().pending).not.toContain("chart.png");
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run`
Expected: 相关用例 FAIL。

- [ ] **Step 3: `ComposerFilePicker` 行加图片标记**

`ComposerFilePicker.tsx:88`，import `isImageName` from `../lib/image-thumb`，行渲染加 class：

```tsx
      {files.map((f) => (
        <button
          key={f}
          className={`composer-picker-row${isImageName(f) ? " is-image" : ""}`}
          onClick={() => onSelect(f)}
          type="button"
          role="option"
        >
          {isImageName(f) ? "🖼 " : ""}{f}
        </button>
      ))}
```

- [ ] **Step 4: `Composer.insertFile` 按图片分叉**

`Composer.tsx:91`，改为：

```typescript
  async function insertFile(name: string) {
    const at = findTriggerIndex(text, "@");
    if (at < 0) return;
    const before = text.slice(0, at);
    const after = text.slice(at + 1 + pickerQuery.length);
    setText(before + after);
    setPickerOpen(false);
    resize();
    textareaRef.current?.focus();

    if (isImageName(name) && supportsVision) {
      try {
        const thumb = await pathToDataUrl(name); // workspace-relative path works server-side
        addImages([{ id: `ws-${Date.now()}-${name}`, name: name.split(/[\\/]/).pop() || name,
          mime: mimeForName(name), thumb, source: "workspace", rel: name }]);
      } catch { /* ignore unreadable */ }
    } else if (isImageName(name) && !supportsVision) {
      // vision off: image files can't be attached; fall back to a text reference.
      addAttachments([name]);
    } else {
      addAttachments([name]);
    }
  }
```

顶部 import `isImageName, mimeForName, pathToDataUrl` from `./image-thumb`（路径按实际相对位置：`../lib/image-thumb`）。

- [ ] **Step 5: `FilePickerModal` 的 `onConfirm` 分叉（Composer 侧处理）**

Composer 里 modal 的 `onConfirm`（`:333`）目前直接 `addAttachments(paths)`。改为逐个走与 `insertFile` 相同的分叉：

```tsx
        onConfirm={async (paths) => {
          for (const p of paths) {
            if (isImageName(p) && supportsVision) {
              try {
                const thumb = await pathToDataUrl(p);
                addImages([{ id: `ws-${Date.now()}-${p}`, name: p.split(/[\\/]/).pop() || p,
                  mime: mimeForName(p), thumb, source: "workspace", rel: p }]);
              } catch { addAttachments([p]); }
            } else {
              addAttachments([p]);
            }
          }
          setFilePickerOpen(false);
        }}
```

- [ ] **Step 6: 运行确认通过 + 类型**

Run: `npx vitest run && npx tsc --noEmit`
Expected: 全 PASS + 类型干净。

- [ ] **Step 7: 提交**

```bash
git add src/components/ComposerFilePicker.tsx src/components/Composer.tsx src/components/FilePickerModal.tsx
git commit -m "feat(vision): route @ image files into the visual attachment channel"
```

---

### Task 11: 前端对话气泡缩略图

**Files:**
- Modify: `src/components/Conversation.tsx:42-48`
- Modify: `src/app.css`
- Test: `src/components/Conversation.test.tsx`（若已有则追加）

- [ ] **Step 1: 写失败测试（追加到 `Conversation.test.tsx`）**

```typescript
it("renders image thumbnails on a user turn that carried images", () => {
  useChatStore.setState({ turns: [
    { id: "u1", role: "user", content: "看图",
      images: [{ name: "chart.png", thumb: "data:image/png;base64,AAAA" }] },
  ] as any });
  render(<Conversation />);
  const imgs = screen.getAllByRole("img");
  expect(imgs.some((i) => (i as HTMLImageElement).src.startsWith("data:image/png"))).toBe(true);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run src/components/Conversation.test.tsx`
Expected: FAIL（无 img）。

- [ ] **Step 3: `TurnView` user 分支渲染缩略图**

`Conversation.tsx:42`：

```tsx
  if (turn.role === "user") {
    const imgs = (turn as any).images as { name: string; thumb: string }[] | undefined;
    return (
      <div className="turn user-turn">
        <div className="msg-user">{turn.content}</div>
        {imgs && imgs.length > 0 && (
          <div className="user-images">
            {imgs.map((im, idx) => (
              <img key={idx} className="user-image-thumb" src={im.thumb} alt={im.name} title={im.name} />
            ))}
          </div>
        )}
      </div>
    );
  }
```

- [ ] **Step 4: CSS**

```css
.user-images {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
  margin-top: 0.4rem;
}
.user-image-thumb {
  width: 120px;
  height: 120px;
  object-fit: cover;
  border-radius: 8px;
  border: 1px solid var(--border);
  cursor: zoom-in;
}
```

- [ ] **Step 5: 运行确认通过 + 类型**

Run: `npx vitest run src/components/Conversation.test.tsx && npx tsc --noEmit`
Expected: PASS + 类型干净。

- [ ] **Step 6: 提交**

```bash
git add src/components/Conversation.tsx src/app.css src/components/Conversation.test.tsx
git commit -m "feat(vision): render image thumbnails in user message bubbles"
```

---

### Task 12: 集成验证 + 文档 + 重新打包

**Files:**
- Modify: `README.md`（功能概览加「图片输入」一行）

- [ ] **Step 1: 全量后端测试**

Run: `cd sidecar && python -m pytest tests/ -q`
Expected: 全 PASS。

- [ ] **Step 2: 全量前端测试 + 类型 + 构建**

Run: `npx vitest run && npx tsc --noEmit && npm run build`
Expected: 全 PASS，构建干净。

- [ ] **Step 3: 手动集成（`npm run tauri dev`）**

逐项验证：
1. 设置选 GLM-5（或 Task 1 标了 vision 的模型）→ 在 Composer 粘贴一张水文图表截图 + 输入「分析这张图的洪峰流量」→ 模型正确读图作答。
2. 拖一张 workspace 内 PNG 到输入框 → 出现 chip → 发送 → 模型识别。
3. `@` 引用 workspace 内 `.png` → 进图片通道（chip 带缩略图）而非文本引用。
4. 切到 DeepSeek（vision=false）→ `＋` 置灰、tooltip 出现、粘贴无反应。
5. 发送带图消息后切换会话再切回 → 用户气泡显示 `[已附图片：…]` 文本 + 当轮缩略图（重载后仅文本前缀，无图——符合单轮有效）。
6. 粘贴 >10MB 图 → 不入栈（前端拦截）；后端对 file/workspace 超 10MB 返回 error 事件。

- [ ] **Step 4: 更新 README**

在「AI 对话与工具调用」下加一条：

```markdown
- 支持向视觉模型发送图片：**粘贴截图 / 拖拽图片 / `@工作区图片`** 三种入口；图片单轮有效（不随会话持久化），非视觉模型自动禁用入口
```

- [ ] **Step 5: 提交文档**

```bash
git add README.md
git commit -m "docs: image input (vision) support"
```

- [ ] **Step 6: 重新打包**

Run: `bash pack.sh`
Expected: 产出 `src-tauri/target/release/bundle/nsis/FloodMind Desktop_0.1.0_x64-setup.exe`（含后端 attachment 改动）。

---

## Self-Review（写完后自查结果）

1. **Spec 覆盖**：
   - 三入口（粘贴/拖拽/`@`）→ Task 9（paste/drop）+ Task 10（`@` 分叉）。✅
   - 单轮有效、跨轮不重发 → Task 8（不入库、前缀）+ Task 5（仅发起轮 attachments）。✅
   - 非视觉模型禁用+提示 → Task 6（透传）+ Task 9（门禁）+ Task 5（后端兜底）。✅
   - 10MB 硬上限、原图直发 → Task 3（归一化校验）+ Task 9（前端预拒）。✅
   - `supports_vision` 链路（4 处）→ Task 1（providers 标记）+ Task 2（后端读写）+ Task 6（前端透传）。✅
   - 暂存目录启动清理 → Task 4。✅
   - 缩略图（chip + 气泡）→ Task 9（chip）+ Task 11（气泡）+ Task 4（thumb 端点）。✅
   - 错误处理矩阵 → Task 3/4/5 各类拒绝 + Task 9 前端。✅
   - 测试计划（后端+前端+集成）→ Task 2-11 单测 + Task 12 集成。✅

2. **Placeholder 扫描**：无 TBD/TODO；每个 code step 都给了实际代码。Task 1 的模型标记值依赖 WebSearch 核实（故为独立 research task，非占位）。

3. **类型一致性**：
   - 线类型 `ImageAttachmentWire` 三 source 在 `chat-stream.ts`、`attachment-store.ts.toWire()`、后端 `attachments.py.normalize_attachment` 三处一致（workspace=name/file=path/clipboard=data + mime）。✅
   - `Msg.images = {name, thumb}[]` 在 chat-store 定义、send 写入、Conversation 读取一致。✅
   - `ModelConfig.supportsVision`、`ModelEntry.supportsVision`、`CuratedModelDef.supportsVision` 命名统一。✅
   - 后端 `attachments.py` 返回 SDK `Attachment`（file_id/name/path/kind/mime_type/size）与 SDK `types.py:33` 一致。✅
