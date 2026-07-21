"""Model/LLM configuration read+write for the desktop settings GUI.

The SDK stores model config in ``~/.floodmind/settings.json`` under a flat
``providers`` section (OpenCode-style)::

    providers.<id>.{name, base_url, api_key, models[]}
        models[].{id, context_window, default_max_tokens, default_temperature,
                  supports_reasoning, supports_vision, supports_search}

There is **no** top-level ``model`` selection block in the SDK — the active
model is the first entry in the catalog. The desktop persists the GUI's chosen
model under a ``desktop.activeModel`` key (plus ``enableReasoning`` /
``enableSearch`` session defaults) and resolves it at runtime via the SDK's
``resolve_model(model_key=...)``.

The GUI never hand-edits JSON. ``read_model_config`` returns a stable shape the
frontend already consumes; ``write_model_config`` rebuilds the providers section
from the GUI payload. Field names are translated here (SDK snake_case ↔ GUI
``{name, maxTokens, contextSize, temperature}``) so the frontend contract is
unchanged.
"""
from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

# Environment variables that can override on-disk settings (surfaced read-only).
_ENV_VARS = [
    "FLOODMIND_PROVIDER",
    "FLOODMIND_MODEL",
    "FLOODMIND_API_KEY",
    "FLOODMIND_BASE_URL",
    "FLOODMIND_TEMPERATURE",
    "FLOODMIND_MAX_TOKENS",
    "FLOODMIND_ENABLE_REASONING",
    "FLOODMIND_ENABLE_SEARCH",
]

# Code-internal fallbacks when a model definition omits a field. These mirror
# the SDK's own defaults in model_resolver._build() and are NOT user-facing.
DEFAULT_TEMPERATURE = 0.3
DEFAULT_MAX_TOKENS = 65_536
DEFAULT_CONTEXT_WINDOW = 32_768


# ── Paths & raw load ─────────────────────────────────────────

def _settings_path() -> Path:
    from floodmind.config.settings import _config_path

    return _config_path()


def _legacy_config_path() -> Path:
    return Path.home() / ".config" / "floodmind" / "config.json"


def _load_raw_settings() -> dict:
    """Load the raw ``~/.floodmind/settings.json`` without SDK merging."""
    path = _settings_path()
    if path.exists():
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            if isinstance(data, dict):
                return data
        except Exception:
            pass
    return {}


def _neutralize_legacy_config() -> None:
    """Empty the legacy ``~/.config/floodmind/config.json``.

    The SDK still deep-merges it on top of settings.json. Its old
    ``task_experience.enabled`` key triggers the SDK's legacy migration on EVERY
    load (migrate → backup → rewrite), which produced 100+ churned backup files.
    Emptying it makes settings.json the single source of truth and stops the
    loop. Safe: MCP/search/skills now live in their own files or settings.json.
    """
    path = _legacy_config_path()
    if not path.exists():
        return
    try:
        path.write_text("{}", encoding="utf-8")
    except Exception:
        pass


# ── Model ↔ GUI field translation ────────────────────────────

def _model_to_gui(m: dict) -> dict:
    """SDK model dict → GUI {name, maxTokens, contextSize, temperature, supportsVision}.

    Context window is filled from the stored value, but if the stored value is
    the SDK's hardcoded fallback (32768) and the metadata table has a better
    match for this model, the metadata wins.  This corrects stale records that
    were saved before the model-metadata feature existed.
    """
    name = m.get("id", "")
    ctx = m.get("context_window", m.get("contextSize")) or 0
    tok = m.get("default_max_tokens", m.get("maxTokens"))
    # If the stored values are the old SDK defaults (never explicitly set),
    # metadata should correct them — both context_window and max_tokens.
    if (ctx == 32768 or not ctx) or (not tok or tok == DEFAULT_MAX_TOKENS):
        try:
            from .model_metadata import lookup_model_metadata
            meta = lookup_model_metadata(name)
            if ctx == 32768 or not ctx:
                ctx = meta["context_window"]
            if not tok or tok == DEFAULT_MAX_TOKENS:
                tok = meta["max_output_tokens"]
        except Exception:
            pass
    return {
        "name": name,
        "maxTokens": tok,
        "contextSize": ctx,
        "temperature": m.get("default_temperature", m.get("temperature")),
        "supportsVision": bool(m.get("supports_vision", m.get("supportsVision", False))),
    }


def _iter_models(pdata: dict) -> list[dict]:
    """Normalize a provider's models (list or legacy dict) → list of dicts with id."""
    raw_models = pdata.get("models") or []
    if isinstance(raw_models, list):
        return [m for m in raw_models if isinstance(m, dict) and m.get("id")]
    if isinstance(raw_models, dict):
        out = []
        for k, v in raw_models.items():
            if isinstance(v, dict):
                m = dict(v)
                m.setdefault("id", k)
                out.append(m)
            else:
                out.append({"id": k})
        return out
    return []


def _active_model_key(raw: dict) -> str:
    """The GUI-selected model id, else the first model in catalog order."""
    desktop = raw.get("desktop")
    if isinstance(desktop, dict) and desktop.get("activeModel"):
        return str(desktop["activeModel"])
    for pdata in (raw.get("providers") or {}).values():
        if not isinstance(pdata, dict):
            continue
        for m in _iter_models(pdata):
            return m.get("id", "")
    return ""


def _find_model(raw: dict, model_id: str, provider_id: str = ""):
    """Return (provider_id, provider_data, model_dict) for model_id, or None.

    When ``provider_id`` is given it is searched FIRST, so two providers that
    happen to share a model id (e.g. official deepseek + a LAN OpenAI-compatible
    proxy both exposing ``deepseek-v4-flash``) resolve to the user's chosen
    provider instead of whichever appears first in the file.
    """
    providers = raw.get("providers") or {}
    if not isinstance(providers, dict):
        return None
    ordered = []
    if provider_id and provider_id in providers:
        ordered.append(provider_id)
    ordered.extend(pid for pid in providers if pid != provider_id)
    for pid in ordered:
        pdata = providers.get(pid)
        if not isinstance(pdata, dict):
            continue
        for m in _iter_models(pdata):
            if m.get("id") == model_id:
                return pid, pdata, m
    return None


def _active_provider(raw: dict) -> str:
    """The GUI-selected provider id (disambiguates colliding model ids)."""
    desktop = raw.get("desktop")
    if isinstance(desktop, dict) and desktop.get("activeProvider"):
        return str(desktop["activeProvider"])
    return ""


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


# ── Read ─────────────────────────────────────────────────────

def read_model_config() -> dict:
    """Build the GET payload: active model + provider catalog + env overrides."""
    raw = _load_raw_settings()
    providers_cfg = raw.get("providers") or {}

    providers: list[dict] = []
    if isinstance(providers_cfg, dict):
        for pid, pdata in providers_cfg.items():
            if not isinstance(pdata, dict):
                continue
            providers.append(
                {
                    "id": pid,
                    "name": pdata.get("name", pid),
                    "baseURL": pdata.get("base_url", pdata.get("baseURL", "")),
                    "models": [_model_to_gui(m) for m in _iter_models(pdata)],
                    "apiKeyPresent": bool(pdata.get("api_key")),
                }
            )

    active_id = _active_model_key(raw)
    active_provider_id = _active_provider(raw)
    enabled = _normalize_enabled(raw) or _all_catalog_models(raw)
    enabled_keys = {(e["provider"], e["model"]) for e in enabled}
    if enabled and (active_provider_id, active_id) not in enabled_keys:
        fb = enabled[0]
        active_id = fb["model"]
        active_provider_id = fb["provider"]
    found = _find_model(raw, active_id, active_provider_id) if active_id else None
    if found:
        pid, pdata, m = found
        active_provider, active_base = pid, pdata.get("base_url", "")
        api_key_present = bool(pdata.get("api_key"))
        temperature = m.get("default_temperature", DEFAULT_TEMPERATURE)
        max_tokens = m.get("default_max_tokens", DEFAULT_MAX_TOKENS)
        context_size = m.get("context_window", m.get("contextSize"))
        # Correct stale SDK-default values from metadata (pre-model-metadata saves).
        if context_size == 32768 or not context_size or max_tokens == DEFAULT_MAX_TOKENS:
            from .model_metadata import lookup_model_metadata
            meta = lookup_model_metadata(active_id)
            if context_size == 32768 or not context_size:
                context_size = meta["context_window"]
            if max_tokens == DEFAULT_MAX_TOKENS:
                max_tokens = meta["max_output_tokens"]
        supports_vision = bool(m.get("supports_vision", m.get("supportsVision", False)))
    else:
        active_provider = active_base = ""
        api_key_present = False
        temperature = DEFAULT_TEMPERATURE
        max_tokens = DEFAULT_MAX_TOKENS
        context_size = None
        supports_vision = False

    desktop = raw.get("desktop")
    desktop_cfg = desktop if isinstance(desktop, dict) else {}

    return {
        "model": {
            "provider": active_provider,
            "model": active_id,
            "temperature": temperature,
            "maxTokens": max_tokens,
            "contextSize": context_size,
            "enableReasoning": bool(desktop_cfg.get("enableReasoning", False)),
            "enableSearch": bool(desktop_cfg.get("enableSearch", False)),
            "supportsVision": supports_vision,
        },
        "apiKeyPresent": api_key_present,
        "baseURL": active_base,
        "providers": providers,
        "enabledModels": enabled,
        "envOverrides": [v for v in _ENV_VARS if os.getenv(v)],
    }


# ── Write ────────────────────────────────────────────────────

def _gui_model_to_sdk(mi: dict, prev_model: dict | None) -> dict:
    """GUI model entry → SDK model dict (id + context_window + defaults).

    Context window and max output tokens are auto-filled from the model-metadata
    table (name-based lookup) when the GUI does not supply explicit values, so
    the user never has to type context sizes manually.
    """
    from .model_metadata import lookup_model_metadata

    prev_model = prev_model or {}
    mtok = mi.get("maxTokens")
    mctx = mi.get("contextSize")
    mtemp = mi.get("temperature")
    model_name = mi.get("name", "")

    # Context window: explicit GUI value > previous stored value > metadata
    # lookup > sensible fallback.
    ctx = int(mctx) if mctx else int(prev_model.get("context_window") or 0)
    if not ctx:
        ctx = lookup_model_metadata(model_name)["context_window"]

    # Max output tokens: same priority chain.
    tok = int(mtok) if mtok else int(prev_model.get("default_max_tokens") or 0)
    if not tok:
        tok = lookup_model_metadata(model_name)["max_output_tokens"]

    # Preserve supports_* / description seeded earlier, then apply GUI values.
    sdk = dict(prev_model)
    sdk["id"] = model_name
    sdk["name"] = mi.get("name", sdk.get("name", sdk["id"]))

    sdk["context_window"] = ctx
    sdk["default_max_tokens"] = tok
    sdk["default_temperature"] = (
        float(mtemp) if mtemp is not None
        else float(prev_model.get("default_temperature") or DEFAULT_TEMPERATURE)
    )
    # Preserve the GUI's vision flag (curated models seed it; custom default false).
    if "supportsVision" in mi:
        sdk["supports_vision"] = bool(mi.get("supportsVision"))
    elif "supports_vision" not in sdk and "supportsVision" not in sdk:
        sdk["supports_vision"] = False
    return sdk


def write_model_config(body: dict[str, Any]) -> dict:
    """Rebuild the providers section from the GUI payload, save, return snapshot.

    Payload (provider-centric): ``{"provider", "model", "providers": [...]}``.
    Each provider entry: ``{id, name, baseURL, apiKey?, models: [{name, maxTokens,
    contextSize?, temperature?}]}``. ``apiKey`` is only written when the GUI sends
    a non-empty one (the password field is blank on load). The selected model is
    recorded under ``desktop.activeModel``.
    """
    from floodmind.config.settings import save_config

    raw = _load_raw_settings()
    model_name = body.get("model") or ""

    if isinstance(body.get("providers"), list):
        prev_providers = raw.get("providers") or {}
        rebuilt: dict[str, Any] = {}
        for entry in body["providers"]:
            if not isinstance(entry, dict):
                continue
            pid = str(entry.get("id", "")).strip()
            if not pid:
                continue
            prev = prev_providers.get(pid, {}) if isinstance(prev_providers, dict) else {}
            prev_models = {m.get("id"): m for m in _iter_models(prev)} if isinstance(prev, dict) else {}

            base = entry.get("baseURL") or prev.get("base_url", "")
            prov_out: dict[str, Any] = {
                "name": entry.get("name") or prev.get("name") or pid,
            }
            if base:
                prov_out["base_url"] = base
            # apiKey: overwrite only when a new value is sent; else keep existing.
            if entry.get("apiKey"):
                prov_out["api_key"] = entry["apiKey"]
            elif prev.get("api_key"):
                prov_out["api_key"] = prev["api_key"]

            models_out = []
            for mi in entry.get("models") or []:
                if isinstance(mi, dict):
                    mname = str(mi.get("name", "")).strip()
                    if mname:
                        models_out.append(_gui_model_to_sdk(mi, prev_models.get(mname)))
            prov_out["models"] = models_out
            rebuilt[pid] = prov_out
        raw["providers"] = rebuilt

    # Record the GUI selection so resolve_model(model_key=..., provider_id=...)
    # lands on it. provider_id is required when two providers expose the same
    # model id (official deepseek vs a LAN proxy both serving deepseek-v4-flash).
    desktop = raw.get("desktop") if isinstance(raw.get("desktop"), dict) else {}
    desktop = dict(desktop)
    if model_name:
        desktop["activeModel"] = model_name
    if body.get("provider"):
        desktop["activeProvider"] = body["provider"]
    if isinstance(body.get("enabledModels"), list):
        desktop["enabledModels"] = [
            {"provider": str(e.get("provider", "")), "model": str(e.get("model", ""))}
            for e in body["enabledModels"]
            if isinstance(e, dict) and e.get("provider") and e.get("model")
        ]
    raw["desktop"] = desktop

    save_config(raw)  # full write of the patched raw dict; clears the SDK cache
    _neutralize_legacy_config()  # stop the SDK's legacy-config migration churn
    return read_model_config()


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


# ── Persona / rules files (SOUL.md + global AGENTS.md) ──────────────
# Identity + behavior-rule editors for the Settings GUI. These edit ONLY the
# ~/.floodmind/ files the runtime actually injects. Empty content = delete
# (back to default / no rules).

SOUL_MAX_CHARS = 20_000  # mirrors SDK floodmind.profile.soul.SOUL_MD_MAX_CHARS


def read_soul() -> dict:
    """Return {content, isDefault, path} for ~/.floodmind/SOUL.md.

    Missing/empty file → DEFAULT_SOUL_MD with isDefault=True.
    """
    from floodmind.config.settings import get_floodmind_home
    from floodmind.profile.soul import DEFAULT_SOUL_MD

    path = get_floodmind_home() / "SOUL.md"
    try:
        content = path.read_text(encoding="utf-8").strip() if path.exists() else ""
    except Exception:
        content = ""
    if not content:
        return {"content": DEFAULT_SOUL_MD, "isDefault": True, "path": str(path)}
    return {"content": content, "isDefault": False, "path": str(path)}


def write_soul(content: str) -> dict:
    """Write SOUL.md. Empty/whitespace → delete file (back to default).

    Raises ValueError if content exceeds SOUL_MAX_CHARS.
    """
    from floodmind.config.settings import get_floodmind_home

    text = (content or "").strip()
    if len(text) > SOUL_MAX_CHARS:
        raise ValueError(f"SOUL.md 不得超过 {SOUL_MAX_CHARS} 字符")
    home = get_floodmind_home()
    home.mkdir(parents=True, exist_ok=True)
    path = home / "SOUL.md"
    if not text:
        try:
            path.unlink()
        except FileNotFoundError:
            pass
    else:
        path.write_text(text, encoding="utf-8")
    return read_soul()


def read_agents_md() -> dict:
    """Return {content, path} for ~/.floodmind/AGENTS.md. Missing → content=''."""
    from floodmind.config.settings import get_floodmind_home

    path = get_floodmind_home() / "AGENTS.md"
    try:
        content = path.read_text(encoding="utf-8").strip() if path.exists() else ""
    except Exception:
        content = ""
    return {"content": content, "path": str(path)}


def write_agents_md(content: str) -> dict:
    """Write global AGENTS.md. Empty/whitespace → delete file (no global rules)."""
    from floodmind.config.settings import get_floodmind_home

    text = (content or "").strip()
    home = get_floodmind_home()
    home.mkdir(parents=True, exist_ok=True)
    path = home / "AGENTS.md"
    if not text:
        try:
            path.unlink()
        except FileNotFoundError:
            pass
    else:
        path.write_text(text, encoding="utf-8")
    return read_agents_md()


def read_permissions_config() -> dict:
    """Return the desktop permissions block from raw settings."""
    raw = _load_raw_settings()
    perms = raw.get("permissions", {}) or {}
    mode = perms.get("mode", "trust-once")
    if mode not in ("always-trust", "trust-once", "always-ask"):
        mode = "trust-once"
    return {"mode": mode}


def write_permissions_config(body: dict[str, Any]) -> dict:
    """Persist the permissions block and return the new snapshot."""
    from floodmind.config.settings import save_config

    raw = _load_raw_settings()
    mode = body.get("mode", "trust-once")
    if mode not in ("always-trust", "trust-once", "always-ask"):
        mode = "trust-once"
    raw.setdefault("permissions", {})["mode"] = mode
    save_config(raw)
    return read_permissions_config()


# ── Connection probe & remote model listing ─────────────────
# Two helpers for the Settings GUI's "检测连接" / "拉取模型" affordances.
# Both hit the provider's OpenAI-compatible ``/models`` endpoint with the
# standard library (no httpx dependency). baseURL/apiKey come from the request
# body when the GUI is mid-edit, falling back to the on-disk saved values when
# omitted (the password field is blank on load, so an empty apiKey means "use
# the saved one").

def _resolve_probe_target(body: dict[str, Any]) -> tuple[str, str]:
    """Return (base_url, api_key) for a probe.

    body keys: provider (id), baseURL?, apiKey?. Saved on-disk values fill in
    blanks so the GUI can test before saving a freshly typed key.
    """
    raw = _load_raw_settings()
    providers = raw.get("providers") or {}
    pid = str((body or {}).get("provider", "")).strip()
    saved = providers.get(pid, {}) if isinstance(providers, dict) else {}
    if not isinstance(saved, dict):
        saved = {}
    base = str((body or {}).get("baseURL") or saved.get("base_url", "") or "").strip()
    key = str((body or {}).get("apiKey") or saved.get("api_key", "") or "")
    return base, key


def _fetch_remote_model_ids(base_url: str, api_key: str, *, timeout: float = 8.0) -> list[str]:
    """GET {base_url}/models (OpenAI-compatible) → list of model ids.

    Raises urllib.error.HTTPError/URLError on failure so callers can map to a
    user-facing message. Handles both the OpenAI shape ``{data:[{id}]}`` and
    Ollama's ``{models:[{model}]}`` shape (its /v1/models endpoint returns the
    OpenAI shape, but /api/tags returns the latter — we tolerate either).
    """
    url = base_url.rstrip("/") + "/models"
    headers = {"Accept": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    req = urllib.request.Request(url, headers=headers, method="GET")
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        raw_bytes = resp.read()
    try:
        payload = json.loads(raw_bytes.decode("utf-8", "replace"))
    except Exception:
        return []
    ids: list[str] = []
    if isinstance(payload, dict):
        data = payload.get("data")
        if isinstance(data, list):
            for m in data:
                if isinstance(m, dict) and m.get("id"):
                    ids.append(str(m["id"]))
        models_field = payload.get("models")
        if isinstance(models_field, list):
            for m in models_field:
                if isinstance(m, dict) and (m.get("model") or m.get("id")):
                    ids.append(str(m.get("model") or m.get("id")))
    # De-dup, preserve order.
    seen: set[str] = set()
    out: list[str] = []
    for i in ids:
        if i and i not in seen:
            seen.add(i)
            out.append(i)
    return out


def test_model_connection(body: dict[str, Any]) -> dict[str, Any]:
    """Verify baseURL+apiKey by hitting /models. Returns {ok, error}."""
    try:
        base, key = _resolve_probe_target(body)
        if not base:
            return {"ok": False, "error": "未配置 Base URL"}
        _fetch_remote_model_ids(base, key)
        return {"ok": True, "error": None}
    except urllib.error.HTTPError as e:
        return {"ok": False, "error": f"HTTP {e.code}：{e.reason}"}
    except urllib.error.URLError as e:
        return {"ok": False, "error": f"连接失败：{e.reason}"}
    except Exception as e:  # pragma: no cover - defensive
        return {"ok": False, "error": str(e)}


def list_remote_models(body: dict[str, Any]) -> dict[str, Any]:
    """Fetch available model ids from a provider. Returns {ok, models, error}."""
    try:
        base, key = _resolve_probe_target(body)
        if not base:
            return {"ok": False, "models": [], "error": "未配置 Base URL"}
        ids = _fetch_remote_model_ids(base, key)
        return {"ok": True, "models": ids, "error": None}
    except urllib.error.HTTPError as e:
        return {"ok": False, "models": [], "error": f"HTTP {e.code}：{e.reason}"}
    except urllib.error.URLError as e:
        return {"ok": False, "models": [], "error": f"连接失败：{e.reason}"}
    except Exception as e:  # pragma: no cover - defensive
        return {"ok": False, "models": [], "error": str(e)}
