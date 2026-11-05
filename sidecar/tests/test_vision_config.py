import json
import pytest
from unittest.mock import patch
from floodmind_desktop_sidecar import config_api
from floodmind_desktop_sidecar.config_api import read_model_config, write_model_config


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


@pytest.fixture
def isolated_home(tmp_path, monkeypatch):
    monkeypatch.setenv("FLOODMIND_HOME", str(tmp_path))
    monkeypatch.setattr(config_api, "_legacy_config_path", lambda: tmp_path / "legacy_config.json")
    from floodmind.config.settings import reload_config
    reload_config()
    yield tmp_path
    reload_config()


def _write_settings(home, data):
    (home / "settings.json").write_text(json.dumps(data), encoding="utf-8")


def test_write_model_persists_supports_vision(isolated_home):
    _write_settings(isolated_home, {
        "providers": {"p1": {"name": "P1", "base_url": "http://x", "api_key": "k",
            "models": [{"id": "m1", "context_window": 32768,
                        "default_max_tokens": 8192, "default_temperature": 0.3}]}},
        "desktop": {"activeModel": "m1", "activeProvider": "p1"}})
    payload = {"provider": "p1", "model": "m1", "providers": [
        {"id": "p1", "name": "P1", "baseURL": "http://x",
         "models": [{"name": "m1", "maxTokens": 8192, "supportsVision": True}]}]}
    cfg = write_model_config(payload)
    assert cfg["model"]["supportsVision"] is True
    on_disk = json.loads((isolated_home / "settings.json").read_text(encoding="utf-8"))
    assert on_disk["providers"]["p1"]["models"][0]["supports_vision"] is True
