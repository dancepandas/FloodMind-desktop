"""The sidecar patches the SDK's model_presets.get_default_model_key() so the
"当前模型" label the SDK injects into the system prompt reflects the desktop's
active-model selection (desktop.activeModel) instead of always the catalog-first
model. Without it, after a GUI model switch the model misreports itself as the
catalog-first entry even though requests are routed to the selected model.
"""
import json

import pytest

from floodmind_desktop_sidecar import config_api

# Importing the adapter module applies the module-load SDK patch under test.
import floodmind_desktop_sidecar.floodmind_agent  # noqa: F401


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


def test_default_model_key_prefers_desktop_active_model(isolated_home):
    _write_settings(isolated_home, {
        "providers": {
            "deepseek": {"base_url": "u1", "api_key": "k",
                         "models": [{"id": "deepseek-v4-pro"}]},
            "openai": {"base_url": "u2", "api_key": "k2",
                       "models": [{"id": "kimi-k2.7-code"}]},
        },
        "desktop": {"activeModel": "kimi-k2.7-code", "activeProvider": "openai"},
    })
    from floodmind.config import model_presets
    model_presets.DEFAULT_MODEL_KEY = None  # clear cache → force recompute
    assert model_presets.get_default_model_key() == "kimi-k2.7-code"


def test_default_model_key_falls_back_without_active_model(isolated_home):
    _write_settings(isolated_home, {
        "providers": {
            "deepseek": {"base_url": "u1", "api_key": "k",
                         "models": [{"id": "deepseek-v4-pro"}]},
        },
    })
    from floodmind.config import model_presets
    model_presets.DEFAULT_MODEL_KEY = None
    # No desktop.activeModel → falls through to the SDK's original resolver
    # (catalog-first). The exact key is an SDK detail; the invariant is that it
    # returns a non-empty model key and does not crash.
    result = model_presets.get_default_model_key()
    assert isinstance(result, str) and result


def test_model_info_prompt_names_active_model(isolated_home):
    """The prompt line the SDK injects must name the selected model."""
    _write_settings(isolated_home, {
        "providers": {
            "deepseek": {"base_url": "u1", "api_key": "k",
                         "models": [{"id": "deepseek-v4-pro", "label": "DeepSeek V4 Pro"}]},
            "openai": {"base_url": "u2", "api_key": "k2",
                       "models": [{"id": "kimi-k2.7-code", "label": "Kimi K2.7 Code"}]},
        },
        "desktop": {"activeModel": "kimi-k2.7-code", "activeProvider": "openai"},
    })
    from floodmind.config import model_presets
    model_presets.DEFAULT_MODEL_KEY = None
    from floodmind.agent.native.native_flood_agent import NativeFloodAgent
    first_line = NativeFloodAgent._build_model_info().splitlines()[0]
    assert "kimi-k2.7-code" in first_line
