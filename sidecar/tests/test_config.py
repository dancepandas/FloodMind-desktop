"""Tests for the model-config read/write helpers (new SDK `providers` format).

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
    from floodmind.config.settings import initialize_floodmind_home, reload_config

    initialize_floodmind_home()  # v2.0.0 显式种子 settings.json
    reload_config()  # pick up the new FLOODMIND_HOME
    yield tmp_path
    reload_config()  # restore other tests' view


def _write_settings(home, data):
    (home / "settings.json").write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")


def _read_settings(home):
    """Read settings.json as the SDK sees it (credentials decrypted).

    Since SDK v2.3.1 credential fields are encrypted at rest; comparing raw
    ciphertext wouldn't prove the value survived the round-trip.
    """
    from floodmind.config.secret_store import unprotect_tree

    return unprotect_tree(json.loads((home / "settings.json").read_text(encoding="utf-8")))


def test_read_returns_provider_catalog_and_active_model(isolated_home):
    _write_settings(isolated_home, {
        "providers": {
            "deepseek": {
                "name": "DeepSeek",
                "base_url": "https://api.deepseek.com/v1",
                "api_key": "sk-test",
                "models": [{
                    "id": "deepseek-v4-flash",
                    "context_window": 131072,
                    "default_max_tokens": 131072,
                    "default_temperature": 0.3,
                    "supports_reasoning": True,
                }],
            },
            "zhipu": {"name": "智谱", "base_url": "https://open.bigmodel.cn/api/paas/v4",
                      "models": [{"id": "glm-5.2", "default_max_tokens": 65536}]},
        },
        "desktop": {"activeModel": "deepseek-v4-flash", "enableReasoning": True},
    })

    cfg = read_model_config()
    assert cfg["model"]["provider"] == "deepseek"
    assert cfg["model"]["model"] == "deepseek-v4-flash"
    assert cfg["model"]["maxTokens"] == 131072
    assert cfg["model"]["temperature"] == 0.3
    assert cfg["model"]["enableReasoning"] is True
    assert cfg["apiKeyPresent"] is True
    assert cfg["baseURL"] == "https://api.deepseek.com/v1"
    assert cfg["envOverrides"] == []

    by_id = {p["id"]: p for p in cfg["providers"]}
    assert by_id["deepseek"]["apiKeyPresent"] is True
    assert by_id["zhipu"]["apiKeyPresent"] is False
    flash = by_id["deepseek"]["models"][0]
    assert flash["name"] == "deepseek-v4-flash"
    assert flash["maxTokens"] == 131072
    assert flash["contextSize"] == 131072
    assert flash["temperature"] == 0.3


def test_read_seeds_template_when_no_settings(isolated_home):
    # No settings.json → the SDK auto-seeds its template (dashscope provider).
    cfg = read_model_config()
    assert isinstance(cfg["providers"], list)
    assert any(p["id"] == "dashscope" for p in cfg["providers"])
    # Catalog-first model is the active one (no desktop.activeModel set).
    assert cfg["model"]["provider"] == "dashscope"
    assert cfg["model"]["model"]  # first model id in the template


def test_read_active_defaults_to_first_model_when_unset(isolated_home):
    _write_settings(isolated_home, {
        "providers": {
            "deepseek": {
                "base_url": "https://api.deepseek.com/v1", "api_key": "sk",
                "models": [{"id": "deepseek-v4-pro", "default_max_tokens": 131072, "default_temperature": 0.2}],
            }
        }
    })
    cfg = read_model_config()
    # No desktop.activeModel → catalog-first model is active.
    assert cfg["model"]["model"] == "deepseek-v4-pro"
    assert cfg["model"]["provider"] == "deepseek"
    assert cfg["model"]["temperature"] == 0.2


def test_env_overrides_detected(isolated_home, monkeypatch):
    monkeypatch.setenv("FLOODMIND_MODEL", "override-model")
    cfg = read_model_config()
    assert "FLOODMIND_MODEL" in cfg["envOverrides"]


def test_write_rebuilds_providers_and_records_active_model(isolated_home):
    snapshot = write_model_config({
        "provider": "deepseek",
        "model": "deepseek-v4-flash",
        "providers": [
            {"id": "deepseek", "name": "DeepSeek", "baseURL": "https://api.deepseek.com/v1",
             "apiKey": "sk-test",
             "models": [
                 {"name": "deepseek-v4-flash", "maxTokens": 131072, "contextSize": 131072},
                 {"name": "deepseek-v4-pro", "maxTokens": 131072},
             ]},
        ],
    })

    # Snapshot reflects the new values.
    assert snapshot["model"]["provider"] == "deepseek"
    assert snapshot["model"]["model"] == "deepseek-v4-flash"
    assert snapshot["model"]["maxTokens"] == 131072
    assert snapshot["apiKeyPresent"] is True

    raw_on_disk = json.loads((isolated_home / "settings.json").read_text(encoding="utf-8"))
    # Credentials are encrypted at rest (SDK v2.3.1)…
    assert raw_on_disk["providers"]["deepseek"]["api_key"].startswith("enc:v1:")
    # …and decrypt back to the value the GUI sent.
    on_disk = _read_settings(isolated_home)
    # New flat providers format.
    ds = on_disk["providers"]["deepseek"]
    assert ds["base_url"] == "https://api.deepseek.com/v1"
    assert ds["api_key"] == "sk-test"
    assert [m["id"] for m in ds["models"]] == ["deepseek-v4-flash", "deepseek-v4-pro"]
    flash = ds["models"][0]
    assert flash["context_window"] == 131072
    assert flash["default_max_tokens"] == 131072
    # The selected model is recorded for resolve_model(model_key=...).
    assert on_disk["desktop"]["activeModel"] == "deepseek-v4-flash"


def test_write_preserves_unrelated_keys_and_keeps_unsent_apikey(isolated_home):
    _write_settings(isolated_home, {
        "providers": {
            "deepseek": {"base_url": "https://api.deepseek.com/v1", "api_key": "sk-keep",
                         "models": [{"id": "deepseek-v4-flash", "default_max_tokens": 131072}]},
        },
        "desktop": {"activeModel": "deepseek-v4-flash"},
        "permissions": {"mode": "always-trust"},  # unrelated — must survive
    })

    write_model_config({
        "provider": "deepseek", "model": "deepseek-v4-flash",
        "providers": [
            # No apiKey sent → existing sk-keep must be retained.
            {"id": "deepseek", "baseURL": "https://api.deepseek.com/v1",
             "models": [{"name": "deepseek-v4-flash", "maxTokens": 131072}]},
        ],
    })

    on_disk = _read_settings(isolated_home)
    assert on_disk["providers"]["deepseek"]["api_key"] == "sk-keep"
    assert on_disk["permissions"]["mode"] == "always-trust"


def test_repeated_saves_never_double_encrypt_credentials(isolated_home):
    """Read-modify-write cycles keep credentials recoverable.

    The host decrypts settings on read and the SDK re-protects on write; a key
    that was sent once must still resolve after a later save that leaves the
    password field blank.
    """
    payload = {
        "provider": "deepseek", "model": "deepseek-v4-flash",
        "providers": [
            {"id": "deepseek", "baseURL": "https://api.deepseek.com/v1",
             "apiKey": "sk-twice", "models": [{"name": "deepseek-v4-flash"}]},
        ],
    }
    write_model_config(payload)
    # Second save without re-sending the key (GUI keeps the field blank).
    payload["providers"][0].pop("apiKey")
    write_model_config(payload)

    from floodmind.config.settings import reload_config

    cfg = reload_config()  # SDK reads the file from disk
    assert cfg["providers"]["deepseek"]["api_key"] == "sk-twice"


def test_write_disambiguates_colliding_model_ids_via_active_provider(isolated_home):
    """Two providers expose the same model id (official deepseek + a LAN proxy
    both serving deepseek-v4-flash). The GUI's chosen provider must be recorded
    and used, else resolve_model picks the catalog-first (official) one."""
    _write_settings(isolated_home, {
        "providers": {
            "deepseek": {"base_url": "https://api.deepseek.com/v1", "api_key": "sk-official",
                         "models": [{"id": "deepseek-v4-flash", "default_max_tokens": 131072}]},
            "openai": {"base_url": "http://192.168.30.112:3000/v1", "api_key": "sk-proxy",
                       "models": [{"id": "deepseek-v4-flash", "default_max_tokens": 65536}]},
        },
    })

    # User picks the LAN-proxy (openai) provider's deepseek-v4-flash.
    snap = write_model_config({
        "provider": "openai", "model": "deepseek-v4-flash",
        "providers": [
            {"id": "deepseek", "baseURL": "https://api.deepseek.com/v1",
             "models": [{"name": "deepseek-v4-flash", "maxTokens": 131072}]},
            {"id": "openai", "baseURL": "http://192.168.30.112:3000/v1",
             "models": [{"name": "deepseek-v4-flash", "maxTokens": 65536}]},
        ],
    })

    # The snapshot must reflect the PROXY, not official deepseek.
    assert snap["model"]["provider"] == "openai"
    assert snap["model"]["model"] == "deepseek-v4-flash"
    assert snap["baseURL"] == "http://192.168.30.112:3000/v1"
    assert snap["apiKeyPresent"] is True

    on_disk = json.loads((isolated_home / "settings.json").read_text(encoding="utf-8"))
    assert on_disk["desktop"]["activeModel"] == "deepseek-v4-flash"
    assert on_disk["desktop"]["activeProvider"] == "openai"


def test_read_disambiguates_via_active_provider(isolated_home):
    _write_settings(isolated_home, {
        "providers": {
            "deepseek": {"base_url": "https://api.deepseek.com/v1", "api_key": "sk-official",
                         "models": [{"id": "deepseek-v4-flash", "default_max_tokens": 131072}]},
            "openai": {"base_url": "http://192.168.30.112:3000/v1", "api_key": "sk-proxy",
                       "models": [{"id": "deepseek-v4-flash", "default_max_tokens": 65536}]},
        },
        "desktop": {"activeModel": "deepseek-v4-flash", "activeProvider": "openai"},
    })
    cfg = read_model_config()
    assert cfg["model"]["provider"] == "openai"
    assert cfg["baseURL"] == "http://192.168.30.112:3000/v1"
    # 65536 is the SDK default → metadata corrects it to the known value (384K).
    assert cfg["model"]["maxTokens"] == 384000


def test_write_drops_providers_not_in_payload(isolated_home):
    _write_settings(isolated_home, {
        "providers": {
            "deepseek": {"base_url": "u1", "api_key": "sk1", "models": [{"id": "m1", "default_max_tokens": 8192}]},
            "stale": {"base_url": "u2", "api_key": "sk2", "models": []},
        },
    })
    write_model_config({
        "provider": "deepseek", "model": "m1",
        "providers": [{"id": "deepseek", "baseURL": "u1", "models": [{"name": "m1", "maxTokens": 8192}]}],
    })
    on_disk = json.loads((isolated_home / "settings.json").read_text(encoding="utf-8"))
    assert "stale" not in on_disk["providers"]
    assert "deepseek" in on_disk["providers"]


def test_write_preserves_model_metadata_when_gui_sends_null_maxtokens(isolated_home):
    _write_settings(isolated_home, {
        "providers": {
            "custom": {"base_url": "u", "api_key": "sk", "models": [
                {"id": "m", "default_max_tokens": 12345, "context_window": 200000,
                 "default_temperature": 0.7, "supports_reasoning": True},
            ]},
        },
    })
    write_model_config({
        "provider": "custom", "model": "m",
        "providers": [{"id": "custom", "baseURL": "u", "models": [{"name": "m", "maxTokens": None}]}],
    })
    on_disk = json.loads((isolated_home / "settings.json").read_text(encoding="utf-8"))
    m = on_disk["providers"]["custom"]["models"][0]
    # GUI sent maxTokens=None → seeded metadata preserved.
    assert m["default_max_tokens"] == 12345
    assert m["context_window"] == 200000
    assert m["default_temperature"] == 0.7
    assert m["supports_reasoning"] is True


def test_write_max_tokens_falls_back_to_default(isolated_home):
    """Active model with no preset and GUI maxTokens=None → safe default."""
    snap = write_model_config({
        "provider": "custom", "model": "unknown",
        "providers": [{"id": "custom", "baseURL": "u", "apiKey": "sk",
                       "models": [{"name": "unknown", "maxTokens": None}]}],
    })
    from floodmind_desktop_sidecar.config_api import DEFAULT_MAX_TOKENS
    assert snap["model"]["maxTokens"] == DEFAULT_MAX_TOKENS


def test_write_neutralizes_legacy_config(isolated_home):
    legacy = isolated_home / "legacy_config.json"
    legacy.write_text(json.dumps({"task_experience": {"enabled": True}}), encoding="utf-8")
    write_model_config({
        "provider": "deepseek", "model": "m",
        "providers": [{"id": "deepseek", "baseURL": "u", "apiKey": "sk", "models": [{"name": "m", "maxTokens": 8192}]}],
    })
    # The legacy file is emptied so the SDK's migration churn can't recur.
    assert json.loads(legacy.read_text(encoding="utf-8")) == {}


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


def test_read_returns_enabled_models_defaulting_to_all(isolated_home):
    """enabledModels 缺失时默认等于当前所有模型（升级不丢可用模型）。"""
    _write_settings(isolated_home, {
        "providers": {
            "deepseek": {"base_url": "u", "api_key": "sk",
                         "models": [{"id": "deepseek-v4-pro", "default_max_tokens": 131072},
                                    {"id": "deepseek-v4-flash", "default_max_tokens": 65536}]},
            "qwen": {"base_url": "u2", "api_key": "sk2",
                     "models": [{"id": "qwen3.7-plus", "default_max_tokens": 131072}]},
        },
        "desktop": {"activeModel": "deepseek-v4-pro"},
    })
    cfg = read_model_config()
    enabled = {(e["provider"], e["model"]) for e in cfg["enabledModels"]}
    assert enabled == {("deepseek", "deepseek-v4-pro"), ("deepseek", "deepseek-v4-flash"), ("qwen", "qwen3.7-plus")}


def test_read_returns_explicit_enabled_models(isolated_home):
    _write_settings(isolated_home, {
        "providers": {
            "deepseek": {"base_url": "u", "api_key": "sk",
                         "models": [{"id": "deepseek-v4-pro", "default_max_tokens": 131072},
                                    {"id": "deepseek-v4-flash", "default_max_tokens": 65536}]},
        },
        "desktop": {"activeModel": "deepseek-v4-pro",
                    "enabledModels": [{"provider": "deepseek", "model": "deepseek-v4-flash"}]},
    })
    cfg = read_model_config()
    assert cfg["enabledModels"] == [{"provider": "deepseek", "model": "deepseek-v4-flash"}]


def test_write_persists_enabled_models(isolated_home):
    write_model_config({
        "provider": "deepseek", "model": "deepseek-v4-pro",
        "enabledModels": [{"provider": "deepseek", "model": "deepseek-v4-pro"},
                          {"provider": "qwen", "model": "qwen3.7-plus"}],
        "providers": [
            {"id": "deepseek", "baseURL": "u", "apiKey": "sk",
             "models": [{"name": "deepseek-v4-pro", "maxTokens": 131072}]},
            {"id": "qwen", "baseURL": "u2", "apiKey": "sk2",
             "models": [{"name": "qwen3.7-plus", "maxTokens": 131072}]},
        ],
    })
    on_disk = json.loads((isolated_home / "settings.json").read_text(encoding="utf-8"))
    assert on_disk["desktop"]["enabledModels"] == [
        {"provider": "deepseek", "model": "deepseek-v4-pro"},
        {"provider": "qwen", "model": "qwen3.7-plus"},
    ]


def test_read_active_falls_back_to_first_enabled_when_not_in_set(isolated_home):
    """activeModel 不在 enabledModels → 解析为首个 enabled。"""
    _write_settings(isolated_home, {
        "providers": {
            "deepseek": {"base_url": "u", "api_key": "sk",
                         "models": [{"id": "deepseek-v4-pro", "default_max_tokens": 131072},
                                    {"id": "deepseek-v4-flash", "default_max_tokens": 65536}]},
        },
        "desktop": {"activeModel": "deepseek-v4-pro",  # NOT enabled below
                    "enabledModels": [{"provider": "deepseek", "model": "deepseek-v4-flash"}]},
    })
    cfg = read_model_config()
    assert cfg["model"]["model"] == "deepseek-v4-flash"
    assert cfg["model"]["provider"] == "deepseek"


# ── work mode (Craft/Ask/Plan) ─────────────────────────────────


def test_read_work_mode_defaults_to_craft(isolated_home):
    from floodmind_desktop_sidecar.config_api import read_work_mode_config

    _write_settings(isolated_home, {"desktop": {}})
    assert read_work_mode_config() == {"mode": "craft"}


def test_write_work_mode_roundtrip(isolated_home):
    from floodmind_desktop_sidecar.config_api import read_work_mode_config, write_work_mode_config

    _write_settings(isolated_home, {
        "providers": {},
        "desktop": {"activeModel": "deepseek-v4-flash", "enableReasoning": True},
        "permissions": {"mode": "always-trust"},  # unrelated — must survive
    })

    assert write_work_mode_config({"mode": "ask"}) == {"mode": "ask"}
    on_disk = json.loads((isolated_home / "settings.json").read_text(encoding="utf-8"))
    assert on_disk["desktop"]["workMode"] == "ask"
    # Unrelated keys survive the write.
    assert on_disk["desktop"]["activeModel"] == "deepseek-v4-flash"
    assert on_disk["permissions"]["mode"] == "always-trust"

    write_work_mode_config({"mode": "plan"})
    assert read_work_mode_config() == {"mode": "plan"}
    write_work_mode_config({"mode": "craft"})
    assert read_work_mode_config() == {"mode": "craft"}


def test_write_work_mode_invalid_falls_back_to_craft(isolated_home):
    from floodmind_desktop_sidecar.config_api import write_work_mode_config

    _write_settings(isolated_home, {"desktop": {}})
    assert write_work_mode_config({"mode": "nonsense"}) == {"mode": "craft"}
