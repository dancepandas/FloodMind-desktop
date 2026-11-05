"""Model-info prompt labels should follow the agent's routed ModelClient.

The desktop resolves activeModel + activeProvider when constructing ModelClient.
NativeFloodAgent must report that routed model in its per-call "当前模型" prompt
without monkey-patching model_presets.get_default_model_key().
"""
import json

import pytest

from floodmind_desktop_sidecar import config_api


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
    from floodmind.config.settings import reload_config
    reload_config()


def test_sidecar_does_not_patch_default_model_resolver(isolated_home):
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
    import floodmind_desktop_sidecar.floodmind_agent  # noqa: F401

    model_presets.DEFAULT_MODEL_KEY = None  # clear cache → force recompute
    assert not getattr(model_presets.get_default_model_key, "_desktop_patched", False)
    assert model_presets.get_default_model_key() == "deepseek-v4-pro"


def test_model_info_prompt_names_agent_model_client_model(isolated_home):
    """The prompt line the SDK injects must name the model actually routed."""
    _write_settings(isolated_home, {
        "providers": {
            "deepseek": {"base_url": "u1", "api_key": "k",
                         "models": [{"id": "deepseek-v4-pro", "name": "DeepSeek V4 Pro"}]},
            "openai": {"base_url": "u2", "api_key": "k2",
                       "models": [{"id": "kimi-k2.7-code", "name": "Kimi K2.7 Code"}]},
        },
        "desktop": {"activeModel": "kimi-k2.7-code", "activeProvider": "openai"},
    })
    from floodmind.agent.native.native_flood_agent import NativeFloodAgent
    from floodmind.config import model_presets

    model_presets.DEFAULT_MODEL_KEY = None
    agent = NativeFloodAgent.__new__(NativeFloodAgent)
    agent._model_client = type("MC", (), {"model_name": "kimi-k2.7-code"})()

    first_line = agent._build_model_info().splitlines()[0]
    assert "Kimi K2.7 Code" in first_line
    assert "kimi-k2.7-code" in first_line


def test_model_info_prompt_falls_back_to_default_without_model_client_model(isolated_home):
    _write_settings(isolated_home, {
        "providers": {
            "deepseek": {"base_url": "u1", "api_key": "k",
                         "models": [{"id": "deepseek-v4-pro"}]},
        },
    })
    from floodmind.agent.native.native_flood_agent import NativeFloodAgent
    from floodmind.config import model_presets

    model_presets.DEFAULT_MODEL_KEY = None
    agent = NativeFloodAgent.__new__(NativeFloodAgent)
    agent._model_client = type("MC", (), {"model_name": ""})()

    first_line = agent._build_model_info().splitlines()[0]
    assert "deepseek-v4-pro" in first_line
