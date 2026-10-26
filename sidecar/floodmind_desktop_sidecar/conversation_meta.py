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
