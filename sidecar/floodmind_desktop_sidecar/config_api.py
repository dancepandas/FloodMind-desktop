"""Model/LLM configuration read+write for the desktop settings GUI.

Wraps the SDK's `~/.floodmind/settings.json` so the GUI never hand-edits JSON.
- Read uses `get_config()` (merged; creates the file from the template on first
  call) so the GUI sees defaults even before the user saves anything.
- Write reads the RAW on-disk JSON, patches only `model.*` + the chosen
  provider's `options.{apiKey,baseURL}`, then `save_config()` — it never cements
  unrelated DEFAULT_CONFIG keys into the file.
"""
from __future__ import annotations

import json
import os
from typing import Any

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


def _known_providers() -> list[dict]:
    """Providers the SDK knows about even if not in the user's settings yet."""
    try:
        from floodmind.config.provider_registry import PROVIDER_DEFS, KNOWN_MODELS
    except Exception:
        return []
    out: list[dict] = []
    for pid, info in (PROVIDER_DEFS or {}).items():
        if not isinstance(info, dict):
            continue
        out.append(
            {
                "id": pid,
                "name": info.get("name", pid),
                "baseURL": info.get("base_url", "") or info.get("baseURL", ""),
                "models": list((KNOWN_MODELS or {}).get(pid, []) or []),
            }
        )
    return out


def read_model_config() -> dict:
    """Build the GET payload: current model + provider catalog + env overrides."""
    from floodmind.config.settings import get_config

    cfg = get_config() or {}
    model = cfg.get("model", {}) or {}
    provider_cfg = cfg.get("provider", {}) or {}
    current_provider = model.get("provider", "dashscope")

    providers: list[dict] = []
    if isinstance(provider_cfg, dict):
        for pid, p in provider_cfg.items():
            if not isinstance(p, dict):
                continue
            opts = p.get("options", {}) or {}
            models = list((p.get("models", {}) or {}).keys())
            providers.append(
                {
                    "id": pid,
                    "name": p.get("name", pid),
                    "baseURL": opts.get("baseURL", "") or opts.get("base_url", ""),
                    "models": models,
                }
            )

    # Supplement with known providers not yet on disk so the user can switch.
    on_disk = {p["id"] for p in providers}
    for kp in _known_providers():
        if kp["id"] not in on_disk:
            providers.append(kp)

    cur = provider_cfg.get(current_provider) if isinstance(provider_cfg, dict) else None
    cur_opts = (cur.get("options", {}) or {}) if isinstance(cur, dict) else {}
    api_key = cur_opts.get("apiKey", "")

    return {
        "model": {
            "provider": current_provider,
            "model": model.get("model", ""),
            "temperature": model.get("temperature", 0.3),
            "maxTokens": model.get("maxTokens", 8192),
            "enableReasoning": bool(model.get("enableReasoning", False)),
            "enableSearch": bool(model.get("enableSearch", False)),
        },
        "apiKeyPresent": bool(api_key),
        "baseURL": cur_opts.get("baseURL", ""),
        "providers": providers,
        "envOverrides": [v for v in _ENV_VARS if os.getenv(v)],
    }


def write_model_config(body: dict[str, Any]) -> dict:
    """Safe-merge `body` into the raw settings file, save, return the new snapshot."""
    from floodmind.config.settings import _config_path, save_config

    path = _config_path()
    raw: dict = {}
    if path.exists():
        try:
            loaded = json.loads(path.read_text(encoding="utf-8"))
            if isinstance(loaded, dict):
                raw = loaded
        except Exception:
            raw = {}

    provider = body.get("provider")
    model_name = body.get("model")

    m = raw.setdefault("model", {})
    if provider:
        m["provider"] = provider
    if model_name:
        m["model"] = model_name
    if body.get("temperature") is not None:
        m["temperature"] = body["temperature"]
    if body.get("maxTokens") is not None:
        m["maxTokens"] = body["maxTokens"]
    if body.get("enableReasoning") is not None:
        m["enableReasoning"] = bool(body["enableReasoning"])
    if body.get("enableSearch") is not None:
        m["enableSearch"] = bool(body["enableSearch"])

    if provider:
        pblock = raw.setdefault("provider", {}).setdefault(
            provider, {"name": provider, "options": {}, "models": {}}
        )
        opts = pblock.setdefault("options", {})
        if body.get("apiKey") is not None:
            opts["apiKey"] = body["apiKey"]
        if body.get("baseURL"):
            opts["baseURL"] = body["baseURL"]

    save_config(raw)  # full write of the patched raw dict; clears the SDK cache
    return read_model_config()


# ── Persona / rules files (SOUL.md + global AGENTS.md) ──────────────
# Identity + behavior-rule editors for the Settings GUI. These edit ONLY the
# ~/.floodmind/ files the runtime actually injects (NOT the legacy
# ~/.config/floodmind/AGENTS.md). Empty content = delete (back to default / no
# rules).

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
