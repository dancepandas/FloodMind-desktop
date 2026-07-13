"""Tests for the model-config read/write helpers.

These touch the real SDK config loader, so they redirect FLOODMIND_HOME to a
temp dir (the user's real ~/.floodmind/settings.json is never touched).
"""
import json

import pytest

from floodmind_desktop_sidecar import config_api
from floodmind_desktop_sidecar.config_api import (
    read_model_config,
    write_model_config,
    read_soul,
    write_soul,
    read_agents_md,
    write_agents_md,
)


@pytest.fixture
def isolated_home(tmp_path, monkeypatch):
    monkeypatch.setenv("FLOODMIND_HOME", str(tmp_path))
    # Keep tests from touching the host's legacy config.json.
    monkeypatch.setattr(
        config_api, "_legacy_config_path", lambda: tmp_path / "legacy_config.json"
    )
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


def test_read_falls_back_to_provider_with_credentials(isolated_home):
    """If model.provider has no credentials but another provider does, expose that one."""
    settings_file = isolated_home / "settings.json"
    settings_file.write_text(
        json.dumps(
            {
                "model": {"provider": "dashscope", "model": "deepseek-v4-flash"},
                "provider": {
                    "dashscope": {"name": "dashscope", "options": {}, "models": {}},
                    "custom": {
                        "name": "custom",
                        "options": {"apiKey": "sk-test", "baseURL": "http://localhost:3000/v1"},
                        "models": {},
                    },
                },
            }
        ),
        encoding="utf-8",
    )
    cfg = read_model_config()
    assert cfg["model"]["provider"] == "custom"
    assert cfg["apiKeyPresent"] is True
    assert cfg["baseURL"] == "http://localhost:3000/v1"


def test_read_does_not_fallback_when_ambiguous(isolated_home):
    """With multiple credential-bearing providers, stick to the declared one."""
    settings_file = isolated_home / "settings.json"
    settings_file.write_text(
        json.dumps(
            {
                "model": {"provider": "dashscope"},
                "provider": {
                    "dashscope": {"name": "dashscope", "options": {}, "models": {}},
                    "custom": {"name": "custom", "options": {"apiKey": "sk-c"}, "models": {}},
                    "openai": {"name": "openai", "options": {"apiKey": "sk-o"}, "models": {}},
                },
            }
        ),
        encoding="utf-8",
    )
    cfg = read_model_config()
    assert cfg["model"]["provider"] == "dashscope"
    assert cfg["apiKeyPresent"] is False


def test_write_switches_active_provider_without_dropping_credentials(isolated_home):
    """Saving with a new provider updates model.provider while preserving that provider's key."""
    settings_file = isolated_home / "settings.json"
    settings_file.write_text(
        json.dumps(
            {
                "model": {"provider": "dashscope", "model": "old"},
                "provider": {
                    "dashscope": {"name": "dashscope", "options": {"apiKey": "old-key"}, "models": {}},
                    "custom": {
                        "name": "custom",
                        "options": {"apiKey": "sk-c", "baseURL": "http://host/v1"},
                        "models": {},
                    },
                },
            }
        ),
        encoding="utf-8",
    )
    snapshot = write_model_config(
        {
            "provider": "custom",
            "model": "m",
            "temperature": 0.5,
            "maxTokens": 100,
            "enableReasoning": False,
            "enableSearch": False,
        }
    )
    assert snapshot["model"]["provider"] == "custom"
    on_disk = json.loads(settings_file.read_text(encoding="utf-8"))
    assert on_disk["model"]["provider"] == "custom"
    # Credentials under the now-active provider stay intact.
    assert on_disk["provider"]["custom"]["options"]["apiKey"] == "sk-c"
    # Other providers are untouched.
    assert on_disk["provider"]["dashscope"]["options"]["apiKey"] == "old-key"


def test_read_soul_returns_default_when_absent(isolated_home):
    res = read_soul()
    assert res["isDefault"] is True
    assert "FloodMind" in res["content"]
    assert res["path"].endswith("SOUL.md")


def test_write_then_read_soul(isolated_home):
    res = write_soul("你是 TestBot，一个测试助手。")
    assert res["isDefault"] is False
    assert res["content"] == "你是 TestBot，一个测试助手。"
    again = read_soul()
    assert again["content"] == "你是 TestBot，一个测试助手。"
    assert again["isDefault"] is False


def test_write_soul_empty_deletes_back_to_default(isolated_home):
    write_soul("临时身份")
    res = write_soul("   ")
    assert res["isDefault"] is True
    assert not (isolated_home / "SOUL.md").exists()


def test_write_soul_rejects_too_long(isolated_home):
    with pytest.raises(ValueError):
        write_soul("x" * 20001)


def test_read_agents_md_absent_returns_empty(isolated_home):
    res = read_agents_md()
    assert res["content"] == ""
    assert res["path"].endswith("AGENTS.md")


def test_write_then_read_agents_md(isolated_home):
    res = write_agents_md("## 绘图风格\n- 必须有图例")
    assert res["content"] == "## 绘图风格\n- 必须有图例"
    assert "图例" in read_agents_md()["content"]


def test_write_agents_md_empty_deletes(isolated_home):
    write_agents_md("规则")
    assert read_agents_md()["content"] == "规则"
    res = write_agents_md("")
    assert res["content"] == ""
    assert not (isolated_home / "AGENTS.md").exists()
