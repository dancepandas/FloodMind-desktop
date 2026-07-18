# 模型管理与切换重构 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把模型切换从"设置页深埋、全局唯一、composer 标签死元素"重构为"composer 输入框下方一键向上菜单切换 + 设置页可定制供应商/模型目录（任意 provider 增删模型 + 启用集多选 + 每会话粘性）"。

**Architecture:** 后端在 `~/.floodmind/settings.json` 的 `desktop` 块新增 `enabledModels`，providers 模型目录改为用户权威（可增删）；新增轻量 `POST /api/config/active-model` 只切活动模型+reload，不重写目录；每会话模型绑定存桌面侧 `<app_data>/conversation_meta.json`。前端 config-store 负责活动模型解析与切换编排，新增 `ModelPicker` 向上弹出菜单挂到 composer，SettingsView 模型 tab 改 checkbox 多选 + 全员增删 + 元数据编辑 + 恢复官方推荐。

**Tech Stack:** Python Flask sidecar (pytest)；React 19 + TypeScript + Zustand + vitest；Tauri 2。

## Global Constraints

- 配置文件 `~/.floodmind/settings.json`：`desktop.enabledModels: [{provider, model}]`（扁平列表，desktop 专属）；`providers.<id>.models[]` 为用户权威目录（首轮从 `CURATED_PROVIDERS` 播种）。
- 每会话模型存 `<app_data>/conversation_meta.json`，全局 map `convId → {provider, model, updatedAt}`，不碰 SDK session 存储。
- 新端点 `POST /api/config/active-model` body `{provider, model}` —— 只写 `desktop.activeModel/activeProvider` + `agent.reload_model()`，**绝不重写 providers 段/密钥**。
- **响应契约（关键，勿改）：**
  - `GET /api/config/model` → 直接返回 `read_model_config()` 快照：顶层 `{model: <ModelConfig>, apiKeyPresent, baseURL, providers, envOverrides, enabledModels}`。即 `data.model` = `ModelConfig`，`data.enabledModels` = 启用集。
  - `POST /api/config/model` 与 `POST /api/config/active-model` → `{ok, reloaded, model: <snapshot>}`，**快照裹在 `"model"` 字段下**。即 `data.model` = 快照（含其自身 `model` 键=ModelConfig、`enabledModels`、`providers`…），`data.model.model` = `ModelConfig`。
- 切换语义"总是顺带"：下拉选一个 = 写本会话绑定 + 写全局默认，无确认弹窗。
- `ModelPicker` **朝上展开**（composer 在屏幕底部）；`max-height` 约 320–360px，列表区 `overflow-y:auto`，过滤框与底部固定。
- 活动模型解析优先级：会话绑定 > `desktop.activeModel` > `enabledModels` 首个 > null。
- 删模型 = 真删（含官方默认），"恢复官方推荐"按钮按 `CURATED_PROVIDERS` 补回缺失项。
- 用户可见文案用中文；主题为 light，**无 `--fg-primary` token**（用 `--fg`）。
- TDD（RED→GREEN），每任务独立测试周期 + 提交；分支 `feat/model-switching-redesign`。
- 测试：sidecar `cd sidecar && python -m pytest tests/`；前端 `npx vitest run` + `npm run build`（含 tsc）。

---

## File Structure

**后端（sidecar/floodmind_desktop_sidecar/）：**
- `conversation_meta.py` — 新建。每会话模型绑定 JSON 读写（单一职责，纯文件 IO）。
- `config_api.py` — 改。`read_model_config` 返回 `enabledModels`；`write_model_config` 持久化 `enabledModels` + active 失效回退；新增 `write_active_model`（轻量）。
- `app.py` — 改。新增 `GET/PUT /api/conversations/<id>/model`、`POST /api/config/active-model` 路由。

**前端（src/）：**
- `state/config-store.ts` — 改。`enabledModels` 状态/threading、`resolveActiveModel`、`switchActive`、`loadConversationModel`、`mergeWithCurated` 权威化、save() 从快照刷新 providers/enabledModels。
- `lib/providers.ts` — 改。新增 `getCuratedModels(providerId)` 供"恢复官方推荐"。
- `components/ModelPicker.tsx` — 新建。向上弹出菜单。
- `components/Composer.tsx` — 改。模型标签 `<span>`→`<button>`，挂 ModelPicker，接 switchActive。
- `components/SettingsView.tsx` — 改。ModelTab：checkbox 启用集 + 全员增删 + 每行元数据 + 恢复推荐 + 只读默认标签。
- `state/chat-store.ts` — 改。加载会话时取绑定模型并按需 reload。
- `app.css` — 改。`.model-picker*` 菜单 + `.model-pill-wrap` + checkbox 行样式。

**测试：** `sidecar/tests/test_conversation_meta.py`（新）、`test_config.py`（扩）、`test_active_model.py`（新）；`src/state/config-store.test.ts`（新）、`src/components/ModelPicker.test.tsx`（新）、`src/components/SettingsView.test.tsx`（扩）、`src/components/Composer.test.tsx`（扩）、`src/state/chat-store.test.ts`（扩）。

---

### Task 1: 后端 — 每会话模型绑定模块 + GET/PUT 路由

**Files:**
- Create: `sidecar/floodmind_desktop_sidecar/conversation_meta.py`
- Modify: `sidecar/floodmind_desktop_sidecar/app.py`（在 `conversations_delete` 路由之后、`# ── Scheduled tasks` 之前插入两个路由）
- Test: `sidecar/tests/test_conversation_meta.py`

**Interfaces:**
- Produces: `read_conversation_model(conv_id: str) -> dict | None`（返回 `{provider, model}` 或 None）；`write_conversation_model(conv_id: str, provider: str, model: str) -> dict`。路由 `GET/PUT /api/conversations/<conv_id>/model`。
- Consumes: `.workspace._app_data_dir()`（已存在，CWD-based，测试用 `monkeypatch.chdir(tmp_path)`）。

- [ ] **Step 1: 写失败测试** — 创建 `sidecar/tests/test_conversation_meta.py`：

```python
"""Per-conversation model binding (desktop-side meta file)."""
import json

import pytest

from floodmind_desktop_sidecar import conversation_meta
from floodmind_desktop_sidecar.agent import StubAgent
from floodmind_desktop_sidecar.app import create_app


def test_write_then_read_round_trip(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)  # _app_data_dir() == cwd
    assert conversation_meta.read_conversation_model("conv-1") is None
    bound = conversation_meta.write_conversation_model("conv-1", "qwen", "qwen3.7-plus")
    assert bound == {"provider": "qwen", "model": "qwen3.7-plus"}
    assert conversation_meta.read_conversation_model("conv-1") == {"provider": "qwen", "model": "qwen3.7-plus"}
    on_disk = json.loads((tmp_path / "conversation_meta.json").read_text(encoding="utf-8"))
    assert on_disk["conv-1"]["provider"] == "qwen"
    assert on_disk["conv-1"]["model"] == "qwen3.7-plus"
    assert "updatedAt" in on_disk["conv-1"]


def test_read_returns_none_for_empty_or_missing(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    assert conversation_meta.read_conversation_model("") is None
    assert conversation_meta.read_conversation_model("conv-missing") is None


def test_write_rejects_empty_args(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    with pytest.raises(ValueError):
        conversation_meta.write_conversation_model("conv-1", "", "m")
    with pytest.raises(ValueError):
        conversation_meta.write_conversation_model("", "qwen", "m")


def test_routes_get_put(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    client = create_app(StubAgent()).test_client()
    r = client.get("/api/conversations/conv-9/model")
    assert r.status_code == 200
    assert r.get_json() == {"model": None}
    r = client.put("/api/conversations/conv-9/model", json={"provider": "qwen", "model": "qwen3.7-plus"})
    assert r.status_code == 200
    assert r.get_json()["model"] == {"provider": "qwen", "model": "qwen3.7-plus"}
    assert client.get("/api/conversations/conv-9/model").get_json()["model"] == {"provider": "qwen", "model": "qwen3.7-plus"}


def test_route_put_rejects_missing_fields(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    client = create_app(StubAgent()).test_client()
    assert client.put("/api/conversations/conv-9/model", json={}).status_code == 400
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd sidecar && python -m pytest tests/test_conversation_meta.py -v`
Expected: FAIL — `ModuleNotFoundError: floodmind_desktop_sidecar.conversation_meta`，路由 404。

- [ ] **Step 3: 实现 `conversation_meta.py`**

```python
"""Per-conversation model binding (desktop-side, decoupled from the SDK session store).

A flat JSON map ``<app_data>/conversation_meta.json`` keyed by conversation id →
``{provider, model, updatedAt}``. Each conversation remembers which model it was
last used with, so reopening it restores that model (Roo Code "sticky per-task"
pattern). The SDK session store is untouched.
"""
from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any


def _meta_path():
    from .workspace import _app_data_dir
    return _app_data_dir() / "conversation_meta.json"


def _load() -> dict[str, dict[str, Any]]:
    path = _meta_path()
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(data, dict):
            return {str(k): v for k, v in data.items() if isinstance(v, dict)}
    except Exception:
        pass
    return {}


def _save(meta: dict[str, dict[str, Any]]) -> None:
    path = _meta_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")


def read_conversation_model(conv_id: str) -> dict | None:
    """Return ``{provider, model}`` for conv_id, or None if unbound/invalid."""
    if not conv_id:
        return None
    entry = _load().get(conv_id)
    if not isinstance(entry, dict):
        return None
    provider = entry.get("provider")
    model = entry.get("model")
    if not (provider and model):
        return None
    return {"provider": str(provider), "model": str(model)}


def write_conversation_model(conv_id: str, provider: str, model: str) -> dict:
    """Bind conv_id → {provider, model}. Returns the bound entry."""
    if not conv_id:
        raise ValueError("conv_id required")
    if not provider or not model:
        raise ValueError("provider and model required")
    meta = _load()
    meta[conv_id] = {
        "provider": provider,
        "model": model,
        "updatedAt": datetime.now(timezone.utc).isoformat(),
    }
    _save(meta)
    return {"provider": provider, "model": model}
```

- [ ] **Step 4: 在 `app.py` 加路由** — 在 `conversations_delete` 路由（约第 288 行 `return jsonify({"ok": True})`）之后、`# ── Scheduled tasks` 之前插入：

```python
    @app.get("/api/conversations/<conv_id>/model")
    def conversation_model_get(conv_id):
        from .conversation_meta import read_conversation_model
        try:
            return jsonify({"model": read_conversation_model(conv_id)})
        except Exception as e:  # pragma: no cover - defensive
            return jsonify({"error": str(e)}), 500

    @app.put("/api/conversations/<conv_id>/model")
    def conversation_model_set(conv_id):
        from .conversation_meta import write_conversation_model
        body = request.get_json(silent=True) or {}
        provider = str(body.get("provider", "")).strip()
        model = str(body.get("model", "")).strip()
        if not provider or not model:
            return jsonify({"error": "provider and model required"}), 400
        try:
            bound = write_conversation_model(conv_id, provider, model)
        except ValueError as e:
            return jsonify({"error": str(e)}), 400
        except Exception as e:  # pragma: no cover - defensive
            return jsonify({"error": str(e)}), 500
        return jsonify({"ok": True, "model": bound})
```

- [ ] **Step 5: 跑测试确认通过**

Run: `cd sidecar && python -m pytest tests/test_conversation_meta.py -v`
Expected: PASS（5/5）。

- [ ] **Step 6: 提交**

```bash
git add sidecar/floodmind_desktop_sidecar/conversation_meta.py sidecar/floodmind_desktop_sidecar/app.py sidecar/tests/test_conversation_meta.py
git commit -m "feat(model-switch): 每会话模型绑定模块 + GET/PUT 路由"
```

---

### Task 2: 后端 — enabledModels 读写 + active 失效回退

**Files:**
- Modify: `sidecar/floodmind_desktop_sidecar/config_api.py`（`read_model_config`、`write_model_config`，新增 `_resolve_enabled_models` / `_normalize_enabled` / `_all_catalog_models` 辅助）
- Test: `sidecar/tests/test_config.py`（扩，沿用其 `isolated_home` fixture）

**Interfaces:**
- Produces: `read_model_config()` 返回值顶层新增 `enabledModels: [{provider, model}]`（缺失时默认 = 全部目录模型）；active 不在 enabled 集 → 解析为首个 enabled。`write_model_config(body)` 读取 `body["enabledModels"]` 持久化。
- Consumes: 现有 `_load_raw_settings` / `save_config` / `_iter_models` / `_active_model_key` / `_active_provider`。

- [ ] **Step 1: 写失败测试** — 在 `sidecar/tests/test_config.py` 末尾追加：

```python
def test_read_returns_enabled_models_defaulting_to_all(isolated_home):
    """enabledModels 缺失时默认等于当前所有模型（升级不丢可用模型）。"""
    _write_settings(isolated_home, {
        "providers": {
            "deepseek": {"base_url": "u", "api_key": "sk",
                         "models": [{"id": "deepseek-v4-pro", "default_max_tokens": 131072},
                                    {"id": "deepseek-v4-flash", "default_max_tokens": 65536}]},
            "qwen": {"base_url": "u2", "api_key": "sk2",
                     "models": [{"id": "qwen3.7-plus", "default_max_tokens": 131072}]},
        },
        "desktop": {"activeModel": "deepseek-v4-pro"},
    })
    cfg = read_model_config()
    enabled = {(e["provider"], e["model"]) for e in cfg["enabledModels"]}
    assert enabled == {("deepseek", "deepseek-v4-pro"), ("deepseek", "deepseek-v4-flash"), ("qwen", "qwen3.7-plus")}


def test_read_returns_explicit_enabled_models(isolated_home):
    _write_settings(isolated_home, {
        "providers": {
            "deepseek": {"base_url": "u", "api_key": "sk",
                         "models": [{"id": "deepseek-v4-pro", "default_max_tokens": 131072},
                                    {"id": "deepseek-v4-flash", "default_max_tokens": 65536}]},
        },
        "desktop": {"activeModel": "deepseek-v4-pro",
                    "enabledModels": [{"provider": "deepseek", "model": "deepseek-v4-flash"}]},
    })
    cfg = read_model_config()
    assert cfg["enabledModels"] == [{"provider": "deepseek", "model": "deepseek-v4-flash"}]


def test_write_persists_enabled_models(isolated_home):
    write_model_config({
        "provider": "deepseek", "model": "deepseek-v4-pro",
        "enabledModels": [{"provider": "deepseek", "model": "deepseek-v4-pro"},
                          {"provider": "qwen", "model": "qwen3.7-plus"}],
        "providers": [
            {"id": "deepseek", "baseURL": "u", "apiKey": "sk",
             "models": [{"name": "deepseek-v4-pro", "maxTokens": 131072}]},
            {"id": "qwen", "baseURL": "u2", "apiKey": "sk2",
             "models": [{"name": "qwen3.7-plus", "maxTokens": 131072}]},
        ],
    })
    on_disk = json.loads((isolated_home / "settings.json").read_text(encoding="utf-8"))
    assert on_disk["desktop"]["enabledModels"] == [
        {"provider": "deepseek", "model": "deepseek-v4-pro"},
        {"provider": "qwen", "model": "qwen3.7-plus"},
    ]


def test_read_active_falls_back_to_first_enabled_when_not_in_set(isolated_home):
    """activeModel 不在 enabledModels → 解析为首个 enabled。"""
    _write_settings(isolated_home, {
        "providers": {
            "deepseek": {"base_url": "u", "api_key": "sk",
                         "models": [{"id": "deepseek-v4-pro", "default_max_tokens": 131072},
                                    {"id": "deepseek-v4-flash", "default_max_tokens": 65536}]},
        },
        "desktop": {"activeModel": "deepseek-v4-pro",  # NOT enabled below
                    "enabledModels": [{"provider": "deepseek", "model": "deepseek-v4-flash"}]},
    })
    cfg = read_model_config()
    assert cfg["model"]["model"] == "deepseek-v4-flash"
    assert cfg["model"]["provider"] == "deepseek"
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd sidecar && python -m pytest tests/test_config.py -k "enabled_models or explicit_enabled or persists_enabled or falls_back" -v`
Expected: FAIL — `KeyError: 'enabledModels'`，active 未回退。

- [ ] **Step 3: 实现 config_api.py 改动** — 在 `_active_provider` 函数之后、`# ── Read` 注释之前新增辅助：

```python
def _normalize_enabled(raw: dict) -> list[dict]:
    """desktop.enabledModels → list of {provider, model} (drop malformed)."""
    desktop = raw.get("desktop")
    if not isinstance(desktop, dict):
        return []
    items = desktop.get("enabledModels")
    if not isinstance(items, list):
        return []
    out = []
    for e in items:
        if isinstance(e, dict) and e.get("provider") and e.get("model"):
            out.append({"provider": str(e["provider"]), "model": str(e["model"])})
    return out


def _all_catalog_models(raw: dict) -> list[dict]:
    """Every {provider, model} present in the providers catalog (default-enabled fallback)."""
    out = []
    for pid, pdata in (raw.get("providers") or {}).items():
        if not isinstance(pdata, dict):
            continue
        for m in _iter_models(pdata):
            mid = m.get("id", "")
            if mid:
                out.append({"provider": pid, "model": mid})
    return out
```

在 `read_model_config` 内，定位 `active_id = _active_model_key(raw)` 与 `active_provider_id = _active_provider(raw)` 两行赋值**之后**、`found = _find_model(...)` **之前**，插入 active 失效回退块：

```python
    enabled = _normalize_enabled(raw) or _all_catalog_models(raw)
    enabled_keys = {(e["provider"], e["model"]) for e in enabled}
    if enabled and (active_provider_id, active_id) not in enabled_keys:
        fb = enabled[0]
        active_id = fb["model"]
        active_provider_id = fb["provider"]
```

在 `read_model_config` 的 return 字典中追加一行为 `"enabledModels": enabled,`（与 `"envOverrides"` 同层）。

在 `write_model_config` 中，`desktop = dict(desktop)` 之后、`raw["desktop"] = desktop` 之前追加：

```python
    if isinstance(body.get("enabledModels"), list):
        desktop["enabledModels"] = [
            {"provider": str(e.get("provider", "")), "model": str(e.get("model", ""))}
            for e in body["enabledModels"]
            if isinstance(e, dict) and e.get("provider") and e.get("model")
        ]
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd sidecar && python -m pytest tests/test_config.py -v`
Expected: PASS（全部，含新 4 个 + 既有不回归）。

- [ ] **Step 5: 提交**

```bash
git add sidecar/floodmind_desktop_sidecar/config_api.py sidecar/tests/test_config.py
git commit -m "feat(model-switch): enabledModels 读写 + active 失效回退"
```

---

### Task 3: 后端 — 轻量 POST /api/config/active-model 端点

**Files:**
- Modify: `sidecar/floodmind_desktop_sidecar/config_api.py`（新增 `write_active_model`）
- Modify: `sidecar/floodmind_desktop_sidecar/app.py`（在 `config_model_set` 路由之后加 `config_active_model_set`）
- Test: `sidecar/tests/test_active_model.py`（新，沿用 `isolated_home` 模式 + SpyAgent）

**Interfaces:**
- Produces: `write_active_model(body) -> dict`（只 patch `desktop.activeModel/activeProvider` + save，返回 `read_model_config()` 快照）；路由 `POST /api/config/active-model` 返回 `{ok, reloaded, model: <snapshot>}`。
- Consumes: `_load_raw_settings` / `save_config` / `read_model_config` / `agent.reload_model`。

- [ ] **Step 1: 写失败测试** — 创建 `sidecar/tests/test_active_model.py`：

```python
"""Lightweight active-model switch: sets active + reloads, never rewrites providers."""
import json

import pytest

from floodmind_desktop_sidecar import config_api
from floodmind_desktop_sidecar.agent import StubAgent
from floodmind_desktop_sidecar.app import create_app


@pytest.fixture
def isolated_home(tmp_path, monkeypatch):
    monkeypatch.setenv("FLOODMIND_HOME", str(tmp_path))
    monkeypatch.setattr(config_api, "_legacy_config_path", lambda: tmp_path / "legacy.json")
    from floodmind.config.settings import reload_config
    reload_config()
    yield tmp_path
    reload_config()


def _write_settings(home, data):
    (home / "settings.json").write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")


class ReloadSpy(StubAgent):
    def __init__(self):
        self.reload_calls = 0

    def reload_model(self):
        self.reload_calls += 1
        return True


def test_active_model_sets_active_and_reloads(isolated_home):
    _write_settings(isolated_home, {
        "providers": {
            "deepseek": {"base_url": "u1", "api_key": "sk-keep",
                         "models": [{"id": "deepseek-v4-pro", "default_max_tokens": 131072}]},
            "qwen": {"base_url": "u2", "api_key": "sk2",
                     "models": [{"id": "qwen3.7-plus", "default_max_tokens": 131072}]},
        },
        "desktop": {"activeModel": "deepseek-v4-pro", "activeProvider": "deepseek"},
    })
    spy = ReloadSpy()
    client = create_app(spy).test_client()
    r = client.post("/api/config/active-model", json={"provider": "qwen", "model": "qwen3.7-plus"})
    assert r.status_code == 200
    body = r.get_json()
    assert body["ok"] is True
    assert body["reloaded"] is True
    assert spy.reload_calls == 1
    # 响应快照裹在 "model" 下：data.model.model = ModelConfig
    assert body["model"]["model"]["model"] == "qwen3.7-plus"
    assert body["model"]["model"]["provider"] == "qwen"


def test_active_model_does_not_touch_providers_or_keys(isolated_home):
    """关键不变量：切换不重写 providers 段、不动 api_key。"""
    _write_settings(isolated_home, {
        "providers": {
            "deepseek": {"base_url": "u1", "api_key": "sk-keep",
                         "models": [{"id": "deepseek-v4-pro", "default_max_tokens": 131072}]},
            "qwen": {"base_url": "u2", "api_key": "sk2",
                     "models": [{"id": "qwen3.7-plus", "default_max_tokens": 131072}]},
        },
        "desktop": {"activeModel": "deepseek-v4-pro"},
    })
    client = create_app(ReloadSpy()).test_client()
    client.post("/api/config/active-model", json={"provider": "qwen", "model": "qwen3.7-plus"})
    on_disk = json.loads((isolated_home / "settings.json").read_text(encoding="utf-8"))
    assert on_disk["providers"]["deepseek"]["api_key"] == "sk-keep"
    assert on_disk["providers"]["qwen"]["api_key"] == "sk2"
    assert [m["id"] for m in on_disk["providers"]["deepseek"]["models"]] == ["deepseek-v4-pro"]
    assert on_disk["desktop"]["activeModel"] == "qwen3.7-plus"
    assert on_disk["desktop"]["activeProvider"] == "qwen"


def test_active_model_rejects_missing_fields(isolated_home):
    client = create_app(ReloadSpy()).test_client()
    assert client.post("/api/config/active-model", json={}).status_code == 400
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd sidecar && python -m pytest tests/test_active_model.py -v`
Expected: FAIL — 404（路由不存在）。

- [ ] **Step 3: 实现 `write_active_model`** — 在 `config_api.py` 的 `write_model_config` 之后新增：

```python
def write_active_model(body: dict[str, Any]) -> dict:
    """Lightweight active-model switch: patch ``desktop.activeModel/activeProvider``
    only and save. Does NOT rebuild the providers section or touch api keys —
    that's the heavy ``write_model_config`` path's job (settings save). Returns
    the refreshed ``read_model_config()`` snapshot.
    """
    from floodmind.config.settings import save_config

    provider = str((body or {}).get("provider", "")).strip()
    model = str((body or {}).get("model", "")).strip()
    if not provider or not model:
        raise ValueError("provider and model required")

    raw = _load_raw_settings()
    desktop = raw.get("desktop") if isinstance(raw.get("desktop"), dict) else {}
    desktop = dict(desktop)
    desktop["activeModel"] = model
    desktop["activeProvider"] = provider
    raw["desktop"] = desktop
    save_config(raw)
    _neutralize_legacy_config()
    return read_model_config()
```

- [ ] **Step 4: 加路由** — 在 `app.py` 的 `config_model_set` 路由（`return jsonify({"ok": True, "reloaded": reloaded, "model": snapshot})`）之后插入：

```python
    @app.post("/api/config/active-model")
    def config_active_model_set():
        """Lightweight switch: set active model + reload, without rewriting providers."""
        from .config_api import write_active_model
        body = request.get_json(silent=True) or {}
        try:
            snapshot = write_active_model(body)
        except ValueError as e:
            return jsonify({"error": str(e)}), 400
        except Exception as e:  # pragma: no cover - defensive
            return jsonify({"error": str(e)}), 500
        reloaded = False
        try:
            reloaded = bool(agent.reload_model())
        except Exception as e:  # pragma: no cover - defensive
            app.logger.warning("agent.reload_model failed: %s", e)
        return jsonify({"ok": True, "reloaded": reloaded, "model": snapshot})
```

- [ ] **Step 5: 跑测试确认通过**

Run: `cd sidecar && python -m pytest tests/test_active_model.py -v`
Expected: PASS（3/3）。

- [ ] **Step 6: 提交**

```bash
git add sidecar/floodmind_desktop_sidecar/config_api.py sidecar/floodmind_desktop_sidecar/app.py sidecar/tests/test_active_model.py
git commit -m "feat(model-switch): 轻量 active-model 切换端点（不重写目录）"
```

---

### Task 4: 前端 — config-store enabledModels + 活动模型解析 + 切换编排 + save() 刷新

**Files:**
- Modify: `src/state/config-store.ts`（类型、state、`load`/`save`、`mergeWithCurated`、新增 `resolveActiveModel` / `switchActive` / `loadConversationModel`）
- Test: `src/state/config-store.test.ts`（新）

**Interfaces:**
- Produces:
  - 类型 `EnabledModel = { provider: string; model: string }`；state 新增 `enabledModels: EnabledModel[]`、`switching: boolean`。
  - `resolveActiveModel(convOverride?: EnabledModel | null): EnabledModel | null` —— 优先级 convOverride > active(`model`，且在 enabled 集内) > enabledModels[0] > null。
  - `switchActive(provider, model, convId?): Promise<boolean>` —— 乐观更新 +（有 convId 时）`PUT /api/conversations/<convId>/model` + `POST /api/config/active-model`，失败回滚。
  - `loadConversationModel(convId): Promise<EnabledModel | null>` —— `GET /api/conversations/<id>/model`。
  - `ModelForm` 增加 `enabledModels?: EnabledModel[]`。
- Consumes: Task 1/3 后端端点；`getBaseUrl()`。响应契约见 Global Constraints（POST 响应快照裹在 `model` 下）。

- [ ] **Step 1: 写失败测试** — 创建 `src/state/config-store.test.ts`：

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { useConfigStore } from "./config-store";

const baseState = {
  providers: [], apiKeyPresent: false, baseURL: "", envOverrides: [],
  loading: false, saving: false, savedAt: null, reloadFailed: false, error: null,
  soul: "", soulIsDefault: true, agents: "",
  personaLoading: false, personaSaving: false, personaError: null,
  permissionMode: "trust-once" as const, permissionLoading: false, permissionSaving: false,
  permissionSavedAt: null, permissionError: null,
  load: vi.fn(), clearSaved: vi.fn(), loadPersona: vi.fn(), loadPermissions: vi.fn(),
};

describe("resolveActiveModel", () => {
  beforeEach(() => {
    useConfigStore.setState({ ...baseState, model: null, enabledModels: [] } as any);
  });

  it("prefers conversation override", () => {
    useConfigStore.setState({
      model: { provider: "qwen", model: "qwen3.7-plus", temperature: 0.3, maxTokens: 131072,
        enableReasoning: false, enableSearch: false, supportsVision: true } as any,
      enabledModels: [{ provider: "qwen", model: "qwen3.7-plus" }],
    } as any);
    expect(useConfigStore.getState().resolveActiveModel({ provider: "moonshot", model: "kimi-2.6" }))
      .toEqual({ provider: "moonshot", model: "kimi-2.6" });
  });

  it("falls back to active model when no override", () => {
    useConfigStore.setState({
      model: { provider: "qwen", model: "qwen3.7-plus" } as any,
      enabledModels: [{ provider: "qwen", model: "qwen3.7-plus" }],
    } as any);
    expect(useConfigStore.getState().resolveActiveModel(null))
      .toEqual({ provider: "qwen", model: "qwen3.7-plus" });
  });

  it("falls back to first enabled when active not enabled", () => {
    useConfigStore.setState({
      model: { provider: "deepseek", model: "deepseek-v4-pro" } as any,
      enabledModels: [{ provider: "qwen", model: "qwen3.7-plus" }],
    } as any);
    expect(useConfigStore.getState().resolveActiveModel(null))
      .toEqual({ provider: "qwen", model: "qwen3.7-plus" });
  });

  it("returns null when nothing enabled", () => {
    useConfigStore.setState({ model: null, enabledModels: [] } as any);
    expect(useConfigStore.getState().resolveActiveModel(null)).toBeNull();
  });
});

describe("switchActive", () => {
  beforeEach(() => {
    useConfigStore.setState({ ...baseState, model: { provider: "qwen", model: "qwen3.7-plus" } as any,
      enabledModels: [{ provider: "qwen", model: "qwen3.7-plus" }] } as any);
  });

  it("optimistically updates, calls active-model endpoint, persists conv binding", async () => {
    const calls: any[] = [];
    const fetchMock = (async (url: string, init?: any) => {
      calls.push({ url, init });
      return { ok: true, json: async () => ({ ok: true, reloaded: true,
        // POST 响应：快照裹在 model 下；snapshot.model = ModelConfig
        model: { model: { provider: "moonshot", model: "kimi-2.6", temperature: 0.3, maxTokens: 131072,
                          enableReasoning: false, enableSearch: false, supportsVision: true },
                 apiKeyPresent: true, baseURL: "u2", providers: [], enabledModels: [] } }) } as any;
    }) as any;
    vi.stubGlobal("fetch", fetchMock);
    const ok = await useConfigStore.getState().switchActive("moonshot", "kimi-2.6", "conv-1");
    expect(ok).toBe(true);
    expect(calls.some((c) => c.url.endsWith("/api/config/active-model"))).toBe(true);
    expect((useConfigStore.getState().model as any)?.model).toBe("kimi-2.6");
    expect(calls.some((c) => c.url.includes("/api/conversations/conv-1/model") && c.init?.method === "PUT")).toBe(true);
    vi.unstubAllGlobals();
  });

  it("rolls back on active-model failure", async () => {
    const fetchMock = (async (url: string) => {
      if (url.endsWith("/api/config/active-model")) return { ok: false, json: async () => ({}) } as any;
      return { ok: true, json: async () => ({}) } as any;
    }) as any;
    vi.stubGlobal("fetch", fetchMock);
    const before = useConfigStore.getState().model;
    const ok = await useConfigStore.getState().switchActive("moonshot", "kimi-2.6", "conv-1");
    expect(ok).toBe(false);
    expect(useConfigStore.getState().model).toEqual(before);
    vi.unstubAllGlobals();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/state/config-store.test.ts`
Expected: FAIL — `resolveActiveModel` / `switchActive` 未定义。

- [ ] **Step 3: 实现**

类型区新增：
```typescript
export interface EnabledModel {
  provider: string;
  model: string;
}
```

`ModelForm` 增加 `enabledModels?: EnabledModel[]`。

`ConfigState` 接口新增：
```typescript
  enabledModels: EnabledModel[];
  switching: boolean;
  resolveActiveModel: (convOverride?: EnabledModel | null) => EnabledModel | null;
  switchActive: (provider: string, model: string, convId?: string) => Promise<boolean>;
  loadConversationModel: (convId: string) => Promise<EnabledModel | null>;
```

state 初始值加 `enabledModels: [], switching: false,`。

`load()` 的 `set({...})` 增加 `enabledModels: (data.enabledModels || []) as EnabledModel[],`（GET 响应：`data.enabledModels` 顶层）。

`save()` 响应处理（POST 响应快照裹在 `data.model` 下）：把现有 `set({...})` 改为从 `data.model` 快照刷新全部字段：
```typescript
      const snap = data.model || {};
      set({
        model: snap.model ?? null,                   // snap.model = ModelConfig
        providers: snap.providers ?? [],
        apiKeyPresent: !!snap.apiKeyPresent,
        baseURL: snap.baseURL ?? "",
        enabledModels: snap.enabledModels ?? [],
        saving: false,
        savedAt: Date.now(),
        reloadFailed: data.reloaded === false,
      });
```
并在 `save()` 的 POST body 中加入 `enabledModels`（`const body = { provider, model, enabledModels: form.enabledModels ?? [], providers };`）。

`mergeWithCurated` 改为**权威目录**（saved 模型列表优先，缺失才播种；不再强制 re-inject `def.models`）：
```typescript
function mergeWithCurated(saved: ProviderInfo[]): ProviderInfo[] {
  const byId = new Map(saved.map((p) => [p.id, p]));
  const merged = CURATED_PROVIDERS.map((def) => {
    const savedProvider = byId.get(def.id);
    if (savedProvider) {
      const models = (savedProvider.models || []).map((m) => ({
        name: m.name,
        maxTokens: m.maxTokens ?? null,
        contextSize: m.contextSize ?? null,
        temperature: m.temperature ?? null,
        supportsVision: m.supportsVision ?? false,
      }));
      return { ...savedProvider, name: def.name, models };
    }
    return {
      id: def.id, name: def.name, baseURL: def.baseURL,
      models: def.models.map((m) => ({ name: m.name, maxTokens: getTierDefaultTokens(m) ?? null,
        supportsVision: m.supportsVision ?? false })),
      apiKeyPresent: false,
    };
  });
  // 保留非 curated 的自定义 provider（如用户在 openai 兼容下加的）
  for (const p of saved) {
    if (!CURATED_PROVIDER_IDS.has(p.id)) merged.push(p);
  }
  return merged;
}
```

新增方法实现（放在 store 对象内 `clearSaved` 附近）：
```typescript
  resolveActiveModel(convOverride) {
    const s = useConfigStore.getState();
    if (convOverride && convOverride.provider && convOverride.model) return convOverride;
    const active = s.model;
    if (active && active.provider && active.model) {
      const inEnabled = s.enabledModels.some((e) => e.provider === active.provider && e.model === active.model);
      if (inEnabled || s.enabledModels.length === 0) return { provider: active.provider, model: active.model };
    }
    return s.enabledModels[0] ?? null;
  },

  async switchActive(provider, model, convId) {
    const prev = useConfigStore.getState().model;
    useConfigStore.setState((s) => ({
      switching: true,
      model: { ...(s.model as any), provider, model } as any,
    }));
    try {
      const b = await getBaseUrl();
      const [, activeRes] = await Promise.all([
        convId
          ? fetch(`${b}/api/conversations/${encodeURIComponent(convId)}/model`, {
              method: "PUT", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ provider, model }),
            })
          : Promise.resolve({ ok: true } as Response),
        fetch(`${b}/api/config/active-model`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ provider, model }),
        }),
      ]);
      if (!activeRes.ok) throw new Error("active-model failed");
      const data = await activeRes.json();
      const snap = data.model || {};
      useConfigStore.setState({
        model: snap.model ?? null,            // POST 响应：snap.model = ModelConfig
        enabledModels: snap.enabledModels ?? useConfigStore.getState().enabledModels,
        switching: false,
        savedAt: Date.now(),
        reloadFailed: data.reloaded === false,
      });
      return true;
    } catch {
      useConfigStore.setState({ model: prev, switching: false });
      return false;
    }
  },

  async loadConversationModel(convId) {
    try {
      const b = await getBaseUrl();
      const r = await fetch(`${b}/api/conversations/${encodeURIComponent(convId)}/model`);
      if (!r.ok) return null;
      const data = await r.json();
      const m = data?.model;
      return (m && m.provider && m.model) ? m : null;
    } catch {
      return null;
    }
  },
```

- [ ] **Step 4: 跑测试确认通过 + 全套 + tsc**

Run: `npx vitest run src/state/config-store.test.ts && npx vitest run && npm run build`
Expected: PASS（含 tsc 干净）。

- [ ] **Step 5: 提交**

```bash
git add src/state/config-store.ts src/state/config-store.test.ts
git commit -m "feat(model-switch): enabledModels + 活动模型解析 + 切换编排 + save 刷新"
```

---

### Task 5: 前端 — ModelPicker 向上弹出菜单组件

**Files:**
- Create: `src/components/ModelPicker.tsx`
- Modify: `src/app.css`（新增 `.model-picker*` 样式）
- Test: `src/components/ModelPicker.test.tsx`

**Interfaces:**
- Produces: 默认导出 `ModelPicker`，props `{ onPick: (provider: string, model: string) => void; onClose: () => void }`。从 `useConfigStore` 读 `providers` / `enabledModels` / `model` / `switching`；从 `useChatStore` 读 `streaming`（禁用态）。
- Consumes: Task 4 的 `enabledModels`。

- [ ] **Step 1: 写失败测试** — 创建 `src/components/ModelPicker.test.tsx`：

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import ModelPicker from "./ModelPicker";
import { useConfigStore } from "../state/config-store";

vi.mock("../state/chat-store", () => ({
  useChatStore: (sel: (s: any) => any) => sel({ streaming: false }),
}));
vi.mock("../state/ui-store", () => ({
  useUiStore: (sel: (s: any) => any) => sel({ showToast: vi.fn() }),
}));

describe("ModelPicker", () => {
  beforeEach(() => {
    useConfigStore.setState({
      model: { provider: "qwen", model: "qwen3.7-plus" } as any,
      enabledModels: [
        { provider: "qwen", model: "qwen3.7-plus" },
        { provider: "qwen", model: "qwen3.6-flash" },
        { provider: "moonshot", model: "kimi-2.6" },
      ],
      providers: [
        { id: "qwen", name: "通义千问", baseURL: "", apiKeyPresent: true,
          models: [{ name: "qwen3.7-plus", maxTokens: 131072, supportsVision: true },
                   { name: "qwen3.6-flash", maxTokens: 65536, supportsVision: false }] },
        { id: "moonshot", name: "月之暗面", baseURL: "", apiKeyPresent: false,
          models: [{ name: "kimi-2.6", maxTokens: 131072, supportsVision: true }] },
      ],
      switching: false,
    } as any);
  });

  it("groups enabled models by provider", () => {
    render(<ModelPicker onPick={() => {}} onClose={() => {}} />);
    expect(screen.getByText("通义千问")).toBeInTheDocument();
    expect(screen.getByText("月之暗面")).toBeInTheDocument();
    expect(screen.getByText("qwen3.7-plus")).toBeInTheDocument();
    expect(screen.getByText("kimi-2.6")).toBeInTheDocument();
  });

  it("shows vision badge only for vision models", () => {
    render(<ModelPicker onPick={() => {}} onClose={() => {}} />);
    expect(document.querySelectorAll('[data-vision="true"]').length).toBeGreaterThanOrEqual(2);
  });

  it("greys out models whose provider has no api key and blocks pick", () => {
    const onPick = vi.fn();
    render(<ModelPicker onPick={onPick} onClose={() => {}} />);
    const kimiBtn = screen.getByText("kimi-2.6").closest("button")!;
    expect(kimiBtn).toHaveAttribute("disabled");
    fireEvent.click(kimiBtn);
    expect(onPick).not.toHaveBeenCalled();
  });

  it("picks a usable model", () => {
    const onPick = vi.fn();
    render(<ModelPicker onPick={onPick} onClose={() => {}} />);
    fireEvent.click(screen.getByText("qwen3.6-flash"));
    expect(onPick).toHaveBeenCalledWith("qwen", "qwen3.6-flash");
  });

  it("filters by typed text", () => {
    render(<ModelPicker onPick={() => {}} onClose={() => {}} />);
    fireEvent.change(screen.getByPlaceholderText(/过滤/), { target: { value: "kimi" } });
    expect(screen.getByText("kimi-2.6")).toBeInTheDocument();
    expect(screen.queryByText("qwen3.7-plus")).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/components/ModelPicker.test.tsx`
Expected: FAIL — 找不到 `./ModelPicker`。

- [ ] **Step 3: 实现 `ModelPicker.tsx`**

```typescript
import { useEffect, useMemo, useRef, useState } from "react";
import { useConfigStore, type EnabledModel } from "../state/config-store";
import { useChatStore } from "../state/chat-store";
import { useUiStore } from "../state/ui-store";

interface Row {
  providerId: string;
  providerName: string;
  model: string;
  supportsVision: boolean;
  keyPresent: boolean;
  active: boolean;
}

export default function ModelPicker({
  onPick,
  onClose,
}: {
  onPick: (provider: string, model: string) => void;
  onClose: () => void;
}) {
  const providers = useConfigStore((s) => s.providers);
  const enabled = useConfigStore((s) => s.enabledModels);
  const active = useConfigStore((s) => s.model);
  const switching = useConfigStore((s) => s.switching);
  const streaming = useChatStore((s) => s.streaming);
  const showToast = useUiStore((s) => s.showToast);
  const [query, setQuery] = useState("");
  const [hi, setHi] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);

  const rows: Row[] = useMemo(() => {
    const provById = new Map(providers.map((p) => [p.id, p]));
    return enabled
      .map((e: EnabledModel) => {
        const p = provById.get(e.provider);
        const m = p?.models.find((mm) => mm.name === e.model);
        if (!p || !m) return null;
        return {
          providerId: p.id,
          providerName: p.name,
          model: m.name,
          supportsVision: !!m.supportsVision,
          keyPresent: !!p.apiKeyPresent,
          active: active?.provider === p.id && active?.model === m.name,
        };
      })
      .filter(Boolean) as Row[];
  }, [providers, enabled, active]);

  const filtered = rows.filter((r) =>
    !query.trim() ? true : (r.model + r.providerName).toLowerCase().includes(query.trim().toLowerCase()),
  );

  const grouped = useMemo(() => {
    const map = new Map<string, { name: string; rows: Row[] }>();
    for (const r of filtered) {
      if (!map.has(r.providerId)) map.set(r.providerId, { name: r.providerName, rows: [] });
      map.get(r.providerId)!.rows.push(r);
    }
    return Array.from(map.values());
  }, [filtered]);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [onClose]);

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") { onClose(); return; }
    if (filtered.length === 0) return;
    if (e.key === "ArrowDown") { e.preventDefault(); setHi((i) => (i + 1) % filtered.length); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setHi((i) => (i - 1 + filtered.length) % filtered.length); }
    else if (e.key === "Enter") {
      e.preventDefault();
      const r = filtered[hi];
      if (r && r.keyPresent) onPick(r.providerId, r.model);
    }
  }

  const disabled = switching || streaming;

  return (
    <div className="model-picker" ref={containerRef} role="listbox" aria-label="选择模型">
      <input
        className="model-picker-filter"
        placeholder="🔍 过滤模型…"
        value={query}
        autoFocus
        onChange={(e) => { setQuery(e.target.value); setHi(0); }}
        onKeyDown={onKeyDown}
        disabled={disabled}
      />
      <div className="model-picker-list">
        {grouped.length === 0 && <div className="model-picker-empty">无匹配模型</div>}
        {grouped.map((g) => (
          <div className="model-picker-group" key={g.name}>
            <div className="model-picker-group-head">{g.name}</div>
            {g.rows.map((r) => {
              const idx = filtered.indexOf(r);
              const blocked = !r.keyPresent || disabled;
              return (
                <button
                  type="button"
                  key={`${r.providerId}/${r.model}`}
                  className={`model-picker-row${r.active ? " active" : ""}${idx === hi ? " hi" : ""}`}
                  data-vision={r.supportsVision ? "true" : "false"}
                  disabled={blocked}
                  title={!r.keyPresent ? "需配置 API Key" : undefined}
                  onClick={() => {
                    if (!r.keyPresent) { showToast("该模型所在供应商未配置 API Key，请先在设置中填写"); return; }
                    if (disabled) return;
                    onPick(r.providerId, r.model);
                  }}
                >
                  <span className="model-picker-check">{r.active ? "●" : ""}</span>
                  <span className="model-picker-name">{r.model}</span>
                  {r.supportsVision && <span className="model-picker-vision" title="支持图片">👁</span>}
                  {!r.keyPresent && <span className="model-picker-locked">🔒 需配置Key</span>}
                </button>
              );
            })}
          </div>
        ))}
      </div>
      <button type="button" className="model-picker-manage" onClick={onClose}>
        ⚙ 管理模型…
      </button>
    </div>
  );
}
```

- [ ] **Step 4: 加 CSS** — 在 `src/app.css` 追加：

```css
.model-picker {
  position: absolute;
  left: 0;
  bottom: 100%;
  margin-bottom: 6px;
  width: min(360px, 70vw);
  max-height: 352px;            /* 限高，朝上展开 */
  display: flex;
  flex-direction: column;
  background: var(--surface-2, #f3f4f6);
  border: 1px solid var(--border, #e5e7eb);
  border-radius: 10px;
  box-shadow: 0 -6px 24px rgba(0, 0, 0, 0.12);
  z-index: 50;
  overflow: hidden;
}
.model-picker-filter {
  margin: 8px 8px 4px;
  padding: 6px 8px;
  border: 1px solid var(--border, #e5e7eb);
  border-radius: 6px;
  background: var(--bg, #fff);
  color: var(--fg, #111827);
}
.model-picker-list {
  overflow-y: auto;             /* 仅列表区滚动 */
  flex: 1 1 auto;
  padding: 4px 0;
}
.model-picker-group-head {
  padding: 6px 12px 2px;
  font-size: 11px;
  color: var(--fg-secondary, #374151);
}
.model-picker-row {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 6px 12px;
  background: transparent;
  border: none;
  color: var(--fg, #111827);
  text-align: left;
  cursor: pointer;
  font-size: 13px;
}
.model-picker-row.hi { background: rgba(13, 148, 136, 0.10); }
.model-picker-row.active { font-weight: 600; }
.model-picker-row:disabled {
  color: var(--fg-secondary, #374151);
  opacity: 0.5;
  cursor: not-allowed;
}
.model-picker-check { width: 12px; color: var(--accent, #0d9488); }
.model-picker-name { flex: 1 1 auto; }
.model-picker-vision { font-size: 12px; }
.model-picker-locked { font-size: 11px; color: var(--fg-secondary, #374151); }
.model-picker-manage {
  border-top: 1px solid var(--border, #e5e7eb);
  padding: 8px;
  background: transparent;
  color: var(--fg-secondary, #374151);
  cursor: pointer;
  font-size: 12px;
}
.model-picker-empty { padding: 16px; color: var(--fg-secondary, #374151); font-size: 13px; text-align: center; }
```

- [ ] **Step 5: 跑测试确认通过 + 全套 + tsc**

Run: `npx vitest run src/components/ModelPicker.test.tsx && npx vitest run && npm run build`
Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add src/components/ModelPicker.tsx src/components/ModelPicker.test.tsx src/app.css
git commit -m "feat(model-switch): ModelPicker 向上弹出菜单（限高+内部滚动）"
```

---

### Task 6: 前端 — Composer 模型标签可点 + 挂载 ModelPicker

**Files:**
- Modify: `src/components/Composer.tsx`（`.ctx-pill.model` 渲染处、新增 picker state + switchActive 调用）
- Modify: `src/app.css`（`.model-pill-wrap`）
- Test: `src/components/Composer.test.tsx`（扩）

**Interfaces:**
- Produces: composer 模型 pill 变可点 `<button>`，点击展开 `ModelPicker`；选中 → `switchActive(provider, model, convId)` + toast 反馈失败；streaming 中禁用。
- Consumes: Task 4 `switchActive`；Task 5 `ModelPicker`。convId 取当前会话。

- [ ] **Step 1: 写失败测试** — 在 `src/components/Composer.test.tsx` 追加（沿用该文件既有 mock 风格；按需补 config-store setState）：

```typescript
it("clicking the model pill opens the model picker", async () => {
  const { setState } = await import("../state/config-store");
  setState({
    model: { provider: "qwen", model: "qwen3.7-plus" } as any,
    enabledModels: [{ provider: "qwen", model: "qwen3.7-plus" }],
    providers: [{ id: "qwen", name: "通义千问", baseURL: "", apiKeyPresent: true,
      models: [{ name: "qwen3.7-plus", maxTokens: 131072, supportsVision: true }] }],
    switching: false,
  } as any);
  render(<Composer />);
  const pill = screen.getByRole("button", { name: /qwen3\.7-plus/ });
  fireEvent.click(pill);
  expect(await screen.findByRole("listbox", { name: "选择模型" })).toBeInTheDocument();
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/components/Composer.test.tsx`
Expected: FAIL — pill 是 `<span>`，无 button role；picker 未渲染。

- [ ] **Step 3: 实现 Composer.tsx 改动**

新增 import 与 state（顶部已有 `useConfigStore`、`useUiStore`）：
```typescript
import ModelPicker from "./ModelPicker";
// ...
const [pickerOpen, setPickerOpen] = useState(false);
const switchActive = useConfigStore((s) => s.switchActive);
```

把 `.ctx-pill.model` 的 `<span>`（约 416-418 行）替换为：
```tsx
            <div className="model-pill-wrap">
              <button
                className="ctx-pill model"
                type="button"
                onClick={() => setPickerOpen((v) => !v)}
                disabled={streaming}
                title={modelName ?? "未配置模型"}
                aria-haspopup="listbox"
                aria-expanded={pickerOpen}
              >
                {modelName ?? "未配置模型"} ▾
              </button>
              {pickerOpen && (
                <ModelPicker
                  onPick={async (p, m) => {
                    const convId = useChatStore.getState().currentConvId;  // 见下方 convId 核对
                    const ok = await switchActive(p, m, convId);
                    setPickerOpen(false);
                    if (!ok) showToast("模型切换失败，已恢复");
                  }}
                  onClose={() => setPickerOpen(false)}
                />
              )}
            </div>
```

> **convId 核对（实现者必做）：** 检查 `src/state/chat-store.ts` 是否暴露当前会话 id（候选字段名：`currentConvId` / `conversationId` / 当前激活会话）。若无直接字段，从 `useConversationStore.getState().list.find((i) => i.active)?.id` 取。把实际取法写进 PR 描述。若 chat-store 无该字段，先在 chat-store 加一个只读 selector 暴露当前 conv id（不改持久化）。

CSS：在 `src/app.css` 追加 `.model-pill-wrap { position: relative; }`（让绝对定位的 picker 锚到此 wrap）。

- [ ] **Step 4: 跑测试确认通过 + 全套 + tsc**

Run: `npx vitest run src/components/Composer.test.tsx && npx vitest run && npm run build`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/components/Composer.tsx src/components/Composer.test.tsx src/app.css
git commit -m "feat(model-switch): composer 模型标签可点 + 挂载 ModelPicker"
```

---

### Task 7: 前端 — SettingsView 模型 tab 重构（启用集 + 全员增删 + 元数据 + 恢复推荐）

**Files:**
- Modify: `src/lib/providers.ts`（新增 `getCuratedModels`）
- Modify: `src/components/SettingsView.tsx`（`ModelTab`：checkbox 启用集、add/delete 全员、每行 maxTokens+vision、恢复官方推荐、只读默认标签；form 改用 store.providers 权威列表）
- Modify: `src/app.css`（`.model-row` checkbox / 元数据 / 恢复按钮样式）
- Test: `src/components/SettingsView.test.tsx`（扩）

**Interfaces:**
- Produces: `getCuratedModels(providerId): CuratedModelDef[]`；"恢复官方推荐"补回缺失；保存 payload 含 `enabledModels`。
- Consumes: Task 4 `enabledModels` / `mergeWithCurated`（store.providers 已权威化）/ `resolveActiveModel`。

- [ ] **Step 1: 写失败测试** — 在 `SettingsView.test.tsx` 追加 describe：

```typescript
describe("SettingsView model tab — enabled set + add/delete all providers", () => {
  beforeEach(() => {
    useConfigStore.setState({
      model: { provider: "qwen", model: "qwen3.7-plus", temperature: 0.3, maxTokens: 131072,
        enableReasoning: false, enableSearch: false, supportsVision: true } as any,
      enabledModels: [{ provider: "qwen", model: "qwen3.7-plus" }],
      providers: [
        { id: "qwen", name: "通义千问", baseURL: "u", apiKeyPresent: true,
          models: [{ name: "qwen3.7-plus", maxTokens: 131072, supportsVision: true },
                   { name: "qwen3.6-flash", maxTokens: 65536, supportsVision: false }] },
        { id: "deepseek", name: "DeepSeek", baseURL: "u2", apiKeyPresent: false,
          models: [{ name: "deepseek-v4-pro", maxTokens: 131072, supportsVision: false }] },
      ],
      loading: false, saving: false, savedAt: null, reloadFailed: false, error: null,
      soul: "", soulIsDefault: true, agents: "", envOverrides: [],
      personaLoading: false, personaSaving: false, personaError: null,
      permissionMode: "trust-once", permissionLoading: false, permissionSaving: false,
      permissionSavedAt: null, permissionError: null,
      load: vi.fn(), clearSaved: vi.fn(), loadPersona: vi.fn(), loadPermissions: vi.fn(),
      save: vi.fn(async () => true),
    } as any);
    useFeedbackStore.setState({ submitting: false, submittedAt: null, error: null,
      submit: vi.fn(() => Promise.resolve(true)), clear: vi.fn() });
  });

  it("shows add-model UI for a curated (non-openai) provider too", () => {
    render(<SettingsView />);
    expect(screen.getAllByPlaceholderText(/添加模型/).length).toBeGreaterThan(0);
  });

  it("delete button removes a curated model from the form", () => {
    render(<SettingsView />);
    fireEvent.click(screen.getAllByRole("button", { name: /移除 deepseek-v4-pro/ })[0]);
    expect(screen.queryByText("deepseek-v4-pro")).toBeNull();
  });

  it("save payload includes enabledModels from checkboxes", async () => {
    render(<SettingsView />);
    fireEvent.click(screen.getByRole("button", { name: /保存并重载/ }));
    await waitFor(() => expect(useConfigStore.getState().save).toHaveBeenCalled());
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/components/SettingsView.test.tsx`
Expected: FAIL — curated provider 无 add/delete UI。

- [ ] **Step 3: 实现 providers.ts helper**

在 `providers.ts` 末尾追加：
```typescript
/** Curated (official default) models for a provider — the "恢复官方推荐" source. */
export function getCuratedModels(providerId: string): CuratedModelDef[] {
  return getProviderDef(providerId)?.models ?? [];
}
```

- [ ] **Step 4: 重构 SettingsView ModelTab**

关键改动（在现有 `ModelTab` 上改，保留 load/effect 骨架）：
1. 新增 state：`enabled: Set<string>`（键 `${providerId}/${modelName}`），从 `model.enabledModels`（store）初始化；form 变更时同步。
2. form 构建简化：直接用 `providers`（store 已权威化）填 `form`，**不再** `CURATED_PROVIDERS.map(def.models...)` 强制 re-inject（mergeWithCurated 已处理播种）。保留 API key/baseURL 编辑；Base URL 仍按 `editableBaseURL` 门控。
3. 模型行：`radio` → `checkbox`（`checked` = enabled 集合含该项）；**所有 provider** 都显示 🗑 删除 + 行内 `maxTokens` 下拉 + `supportsVision` 勾选（去掉 `if (def.editableModels)` 门控）。
4. **所有 provider** 都显示"添加模型"输入（`addModel(id)` 对任意 provider 生效）。
5. 每个 provider 卡片底部"↻ 恢复官方推荐"按钮：调 `getCuratedModels(def.id)`，把缺失的 curated 模型补进 form（默认勾选）。
6. "当前使用"改为只读"默认"标签：仅当该模型 === `model.provider/model.model` 时显示"默认"（不可在此切换 active）。
7. `onSubmit` payload：`{ provider, model, enabledModels, providers }`，其中 `provider/model` = `useConfigStore.getState().resolveActiveModel(null)` 结果，`enabledModels` = enabled 集合序列化。

删除 `selectModel`（不再设 active）。新增 `toggleEnabled(id, name)`、`addModel(id)`、`removeModel(id, name)`、`restoreDefaults(id)`。

参考行渲染（替换原 `model-row` 块）：
```tsx
{p.models.map((m) => {
  const key = `${def.id}/${m.name}`;
  const checked = enabled.has(key);
  const isDefault = model?.provider === def.id && model?.model === m.name;
  return (
    <label key={m.name} className={`model-row${checked ? " enabled" : ""}`}>
      <input type="checkbox" checked={checked} onChange={() => toggleEnabled(def.id, m.name)} />
      <span className="model-name">{m.name}</span>
      {isDefault && <span className="model-default-tag">默认</span>}
      {m.supportsVision && <span className="model-vision-tag" title="支持图片">👁</span>}
      <select
        className="model-maxtokens"
        value={m.maxTokens ?? ""}
        onClick={(e) => e.stopPropagation()}
        onChange={(e) => setModelField(def.id, m.name, "maxTokens", e.target.value === "" ? null : Number(e.target.value))}
        title="最大输出 Token"
      >
        <option value="">默认</option>
        <option value="4096">4k</option>
        <option value="8192">8k</option>
        <option value="16384">16k</option>
        <option value="32768">32k</option>
        <option value="65536">64k</option>
        <option value="131072">128k</option>
      </select>
      <label className="model-vision-toggle" onClick={(e) => e.stopPropagation()} title="支持图片输入">
        <input type="checkbox" checked={!!m.supportsVision}
          onChange={(e) => setModelField(def.id, m.name, "supportsVision", e.target.checked)} />
        👁
      </label>
      <button type="button" className="model-remove" aria-label={`移除 ${m.name}`}
        onClick={(e) => { e.stopPropagation(); removeModel(def.id, m.name); }}>✕</button>
    </label>
  );
})}
```

`onSubmit`：
```tsx
async function onSubmit(e: React.FormEvent) {
  e.preventDefault();
  const enabledList = Array.from(enabled).map((k) => {
    const [provider, model] = k.split("/");
    return { provider, model };
  });
  const resolved = useConfigStore.getState().resolveActiveModel(null);
  const providerList = Object.values(form).filter((p) => p.id);
  await save({
    provider: resolved?.provider ?? "",
    model: resolved?.model ?? "",
    enabledModels: enabledList,
    providers: providerList,
  });
}
```

CSS：在 `src/app.css` 调整 `.model-row`（容纳 checkbox + 标签 + 元数据），新增 `.model-default-tag`、`.model-vision-tag`、`.model-vision-toggle`、`.restore-defaults-btn`。

> **既有测试兼容：** 现有 "SettingsView model save preserves supportsVision" 测试断言 radio 选择 + save payload 的 `supportsVision`。重构后 radio→checkbox，该测试需同步更新（断言 checkbox 勾选 + payload `enabledModels` 含目标 + `providers[].models[].supportsVision` 仍正确）。实现者按新 UI 更新该测试断言，保持其回归保护意图。

- [ ] **Step 5: 跑测试确认通过 + 全套 + tsc**

Run: `npx vitest run src/components/SettingsView.test.tsx && npx vitest run && npm run build`
Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add src/lib/providers.ts src/components/SettingsView.tsx src/components/SettingsView.test.tsx src/app.css
git commit -m "feat(model-switch): 设置页模型 tab 重构（启用集+全员增删+元数据+恢复推荐）"
```

---

### Task 8: 前端 — 打开会话时恢复其绑定模型

**Files:**
- Modify: `src/state/chat-store.ts`（`loadConversation` 内，加载会话后调 `loadConversationModel` + 按需 `switchActive`）
- Test: `src/state/chat-store.test.ts`（扩；若无则新建最小用例 mock fetch）

**Interfaces:**
- Produces: 打开会话后，若其绑定模型与当前活动模型不同 → `switchActive` reload；标签按解析规则显示。
- Consumes: Task 4 `loadConversationModel` / `switchActive` / `resolveActiveModel`。

- [ ] **Step 1: 写失败测试** — 在 chat-store 测试中加（沿用其既有 mock 风格）：

```typescript
it("loadConversation restores the conversation's bound model when it differs", async () => {
  const fetchMock = vi.fn().mockImplementation(async (url: string) => {
    if (url.includes("/api/conversations/") && url.endsWith("/model")) {
      return { ok: true, json: async () => ({ model: { provider: "moonshot", model: "kimi-2.6" } }) } as any;
    }
    if (url.endsWith("/api/config/active-model")) {
      return { ok: true, json: async () => ({ ok: true, reloaded: true,
        model: { model: { provider: "moonshot", model: "kimi-2.6" } } }) } as any;
    }
    return { ok: true, json: async () => ({ id: "conv-1", session_id: "s1", turns: [] }) } as any;
  });
  vi.stubGlobal("fetch", fetchMock);
  // 预设当前活动模型为 qwen，与绑定 moonshot 不同 → 应触发 active-model POST
  const { setState } = await import("../state/config-store");
  setState({ model: { provider: "qwen", model: "qwen3.7-plus" } as any,
    enabledModels: [{ provider: "moonshot", model: "kimi-2.6" }, { provider: "qwen", model: "qwen3.7-plus" }] } as any);
  await useChatStore.getState().loadConversation("conv-1");
  expect(fetchMock.mock.calls.some((c) => (c[0] as string).endsWith("/api/config/active-model"))).toBe(true);
  vi.unstubAllGlobals();
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/state/chat-store.test.ts`
Expected: FAIL — loadConversation 未调 model 端点。

- [ ] **Step 3: 实现** — 在 `loadConversation` 现有逻辑（加载 turns、设置当前会话）之后追加：

```typescript
    // 恢复该会话绑定的模型（sticky）。与当前不同则 reload。
    try {
      const bound = await useConfigStore.getState().loadConversationModel(convId);
      const current = useConfigStore.getState().resolveActiveModel(null);
      const differs = bound && current &&
        (bound.provider !== current.provider || bound.model !== current.model);
      if (bound && differs) {
        await useConfigStore.getState().switchActive(bound.provider, bound.model, convId);
      }
    } catch {
      /* 模型恢复失败不阻断会话加载 */
    }
```

> 实现者核对 `loadConversation` 的现有签名与 convId 变量名，按实际调整。

- [ ] **Step 4: 跑测试确认通过 + 全套 + tsc**

Run: `npx vitest run src/state/chat-store.test.ts && npx vitest run && npm run build`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/state/chat-store.ts src/state/chat-store.test.ts
git commit -m "feat(model-switch): 打开会话恢复其绑定模型（sticky）"
```

---

### Task 9: 集成验证 — 全测试 + 类型 + 构建

**Files:** 无新文件（验证性任务）。

- [ ] **Step 1: 后端全测**

Run: `cd sidecar && python -m pytest tests/ -v`
Expected: 全 PASS（含新 test_conversation_meta / test_active_model / test_config 扩展）。

- [ ] **Step 2: 前端全测 + 类型 + 构建**

Run: `npx vitest run && npm run build`
Expected: vitest 全 PASS；tsc + vite 构建干净。

- [ ] **Step 3: 手测清单（npm run tauri dev）**

- composer 模型标签可点 → 向上弹出菜单，按 provider 分组，👁 badge 正确。
- 菜单限高、列表内部滚动、过滤框/底部固定。
- keyless provider 模型置灰不可选，点击 toast。
- 选中模型即时切换（agent reload），标签更新；reload 失败 toast 回滚。
- 新建会话继承全局默认；重开旧会话恢复其绑定模型。
- 设置页：任意 provider（含 deepseek/qwen 等官方家）可添加/删除模型；勾选控制下拉可见性；每行可改 maxTokens/视觉；"恢复官方推荐"补回删除项；保存生效。

- [ ] **Step 4: 收尾**

无代码改动则无需提交；手测中发现的小修按需补提交。

---

## 自检（写计划后）

1. **Spec 覆盖：** 每会话绑定→T1；enabledModels+迁移+回退→T2；轻量切换端点→T3；store 解析/切换/save 刷新→T4；向上菜单+限高滚动→T5；composer 可点→T6；启用集+全员增删+元数据+恢复推荐→T7；sticky 恢复→T8；集成→T9。设置页"不再直接选活动模型/只读默认标签"→T7。删模型=真删→T4(mergeWithCurated 权威化)+T7(restore)。save() 刷新 providers/enabledModels→T4。全部覆盖。
2. **占位符扫描：** T6/T8 含"实现者核对 convId/chat-store 字段"的诚实话——chat-store 当前会话 id 字段名是真实不确定点，已给出核对指令与 fallback（从 conversation-store active 项取 / 加只读 selector）。其余步骤代码完整。
3. **类型一致性：** `EnabledModel = {provider, model}` 在 T4 定义，T5/T6/T7/T8 一致使用；`switchActive(provider, model, convId?)`、`loadConversationModel(convId)`、`resolveActiveModel(convOverride?)` 跨任务签名一致；`getCuratedModels(providerId)` T7 定义即用；响应契约（GET 顶层 / POST 裹在 model 下）在 Global Constraints 固定，T3/T4 测试断言与之一致。
