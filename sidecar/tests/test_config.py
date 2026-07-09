"""Tests for the model-config read/write helpers.

These touch the real SDK config loader, so they redirect FLOODMIND_HOME to a
temp dir (the user's real ~/.floodmind/settings.json is never touched).
"""
import json

import pytest

from floodmind_desktop_sidecar.config_api import read_model_config, write_model_config


@pytest.fixture
def isolated_home(tmp_path, monkeypatch):
    monkeypatch.setenv("FLOODMIND_HOME", str(tmp_path))
    from floodmind.config.settings import reload_config

    reload_config()  # pick up the new FLOODMIND_HOME
    yield tmp_path
    reload_config()  # restore other tests' view


def test_read_returns_defaults_and_provider_catalog(isolated_home):
    cfg = read_model_config()
    assert "model" in cfg
    assert cfg["model"]["provider"]  # template default (dashscope)
    assert isinstance(cfg["providers"], list)
    assert any(p["id"] == cfg["model"]["provider"] for p in cfg["providers"])
    assert cfg["envOverrides"] == []


def test_write_updates_model_and_preserves_unrelated_keys(isolated_home):
    # Seed a raw settings file with an unrelated key that the GUI must NOT drop.
    settings_file = isolated_home / "settings.json"
    settings_file.write_text(
        json.dumps({"agent": {"maxHistory": 42}, "model": {"provider": "dashscope", "model": "old"}}),
        encoding="utf-8",
    )

    snapshot = write_model_config(
        {
            "provider": "dashscope",
            "model": "deepseek-v4-flash",
            "apiKey": "sk-test",
            "baseURL": "https://example.com/v1",
            "temperature": 0.7,
            "maxTokens": 4096,
            "enableReasoning": True,
            "enableSearch": False,
        }
    )

    # The returned snapshot reflects the new values.
    assert snapshot["model"]["model"] == "deepseek-v4-flash"
    assert snapshot["model"]["temperature"] == 0.7
    assert snapshot["model"]["enableReasoning"] is True
    assert snapshot["apiKeyPresent"] is True

    # The unrelated key survived the safe-merge write.
    on_disk = json.loads(settings_file.read_text(encoding="utf-8"))
    assert on_disk["agent"]["maxHistory"] == 42
    assert on_disk["model"]["model"] == "deepseek-v4-flash"
    assert on_disk["model"]["enableReasoning"] is True
    assert on_disk["provider"]["dashscope"]["options"]["apiKey"] == "sk-test"
    assert on_disk["provider"]["dashscope"]["options"]["baseURL"] == "https://example.com/v1"


def test_env_overrides_detected(isolated_home, monkeypatch):
    monkeypatch.setenv("FLOODMIND_MODEL", "override-model")
    cfg = read_model_config()
    assert "FLOODMIND_MODEL" in cfg["envOverrides"]
