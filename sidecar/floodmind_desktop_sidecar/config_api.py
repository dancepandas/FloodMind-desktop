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
    """SDK model dict → GUI {name, maxTokens, contextSize, temperature, supportsVision}."""
    return {
        "name": m.get("id", ""),
        "maxTokens": m.get("default_max_tokens", m.get("maxTokens")),
        "contextSize": m.get("context_window", m.get("contextSize")),
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
        supports_vision = bool(m.get("supports_vision", m.get("supportsVision", False)))
    else:
        active_provider = active_base = ""
        api_key_present = False
        temperature = DEFAULT_TEMPERATURE
        max_tokens = DEFAULT_MAX_TOKENS
        supports_vision = False

    desktop = raw.get("desktop")
    desktop_cfg = desktop if isinstance(desktop, dict) else {}

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
        "enabledModels": enabled,
        "envOverrides": [v for v in _ENV_VARS if os.getenv(v)],
    }


# ── Write ────────────────────────────────────────────────────

def _gui_model_to_sdk(mi: dict, prev_model: dict | None) -> dict:
    """GUI model entry → SDK model dict (id + context_window + defaults)."""
    prev_model = prev_model or {}
    mtok = mi.get("maxTokens")
    mctx = mi.get("contextSize")
    mtemp = mi.get("temperature")

    # Preserve supports_* / description seeded earlier, then apply GUI values.
    sdk = dict(prev_model)
    sdk["id"] = mi.get("name", "")
    sdk["name"] = mi.get("name", sdk.get("name", sdk["id"]))

    ctx = int(mctx) if mctx else int(prev_model.get("context_window") or 0)
    if not ctx:
        ctx = int(mtok) if mtok else DEFAULT_CONTEXT_WINDOW
    sdk["context_window"] = ctx

    sdk["default_max_tokens"] = int(mtok) if mtok else int(
        prev_model.get("default_max_tokens") or DEFAULT_MAX_TOKENS
    )
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
