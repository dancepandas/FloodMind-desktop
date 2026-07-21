"""Model metadata lookup for auto-filling context_window and max_output_tokens.

When the user adds a model (fetch from official /models endpoint, restore
curated defaults, or manually type a name for Ollama/custom providers), the
sidecar consults the metadata table to auto-fill context_window and max output
tokens without requiring the user to know or enter these values.

**Data source:** ``model_metadata.json`` (flat JSON, one entry per model-name
pattern).  To update the table, replace the JSON file — no code change needed.
The canonical upstream for model specs is LiteLLM's
``model_prices_and_context_window.json``; a sync script can convert it into this
file's format.

**Matching strategy:**
  1. Exact name match (case-insensitive) — e.g. "deepseek-v4-pro" → 1M context.
  2. Longest substring match — e.g. "qwen3.7" matches "qwen3.7-plus" and
     "qwen3.7-flash" via the key "qwen3.7".
     *Why substring?* Real model ids vary by provider suffix (‑flash, ‑plus,
     ‑code, :latest, :70b) while the base family shares one context window.
     The longest matching key wins so "kimi-k2.7" (256K) beats "kimi" if both
     keys existed.
  3. Sensible fallbacks for completely unknown models.
"""
from __future__ import annotations

import json
import os
from typing import Any

# Sensible fallbacks for unknown / custom / local models.
_DEFAULT_CONTEXT_WINDOW = 32_768
_DEFAULT_MAX_OUTPUT = 65_536

# ── Load the metadata table from JSON ─────────────────────────
_METADATA_PATH = os.path.join(os.path.dirname(__file__), "model_metadata.json")

_MODEL_METADATA: dict[str, dict[str, int]] = {}
_METADATA_PATTERNS: list[tuple[str, dict[str, int]]] = []


def _load() -> None:
    """(Re-)load the metadata table from JSON.  Called at import time and can
    be called again after updating the JSON file at runtime."""
    global _MODEL_METADATA, _METADATA_PATTERNS
    try:
        with open(_METADATA_PATH, encoding="utf-8") as fh:
            raw: dict[str, Any] = json.load(fh)
        _MODEL_METADATA = {
            k: {"context_window": int(v["context_window"]), "max_output_tokens": int(v["max_output_tokens"])}
            for k, v in raw.items()
            if isinstance(v, dict) and "context_window" in v
        }
    except Exception:
        _MODEL_METADATA = {}
    # Pre-sort by key length (descending) so longer patterns match first.
    _METADATA_PATTERNS = sorted(
        _MODEL_METADATA.items(), key=lambda kv: len(kv[0]), reverse=True
    )


_load()


def lookup_model_metadata(model_name: str) -> dict[str, int]:
    """Return {context_window, max_output_tokens} for *model_name*.

    Matching (first wins):
      1. Exact match (case-insensitive).
      2. Longest substring match — more specific keys beat shorter ones
         (e.g. "kimi-k2.7" matches "kimi-k2.7-code" before "kimi" would).
      3. Sensible defaults for unknown / custom models.
    """
    key = model_name.lower().strip()
    if not key:
        return {"context_window": _DEFAULT_CONTEXT_WINDOW, "max_output_tokens": _DEFAULT_MAX_OUTPUT}
    # Exact.
    if key in _MODEL_METADATA:
        return dict(_MODEL_METADATA[key])
    # Substring, longest-first.
    for pattern, meta in _METADATA_PATTERNS:
        if pattern in key:
            return dict(meta)
    # Fallback.
    return {"context_window": _DEFAULT_CONTEXT_WINDOW, "max_output_tokens": _DEFAULT_MAX_OUTPUT}
