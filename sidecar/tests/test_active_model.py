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


def _read_settings(home):
    """Read settings.json as the SDK sees it (credentials decrypted, v2.3.1)."""
    from floodmind.config.secret_store import unprotect_tree

    return unprotect_tree(json.loads((home / "settings.json").read_text(encoding="utf-8")))


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
    on_disk = _read_settings(isolated_home)
    assert on_disk["providers"]["deepseek"]["api_key"] == "sk-keep"
    assert on_disk["providers"]["qwen"]["api_key"] == "sk2"
    assert [m["id"] for m in on_disk["providers"]["deepseek"]["models"]] == ["deepseek-v4-pro"]
    assert on_disk["desktop"]["activeModel"] == "qwen3.7-plus"
    assert on_disk["desktop"]["activeProvider"] == "qwen"


def test_active_model_rejects_missing_fields(isolated_home):
    client = create_app(ReloadSpy()).test_client()
    assert client.post("/api/config/active-model", json={}).status_code == 400
