"""Per-conversation model binding (desktop-side meta file)."""
import json

import pytest

from floodmind_desktop_sidecar import conversation_meta
from floodmind_desktop_sidecar.agent import StubAgent
from floodmind_desktop_sidecar.app import create_app


def test_write_then_read_round_trip(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)  # _app_data_dir() == cwd
    assert conversation_meta.read_conversation_model("conv-1") is None
    bound = conversation_meta.write_conversation_model("conv-1", "qwen", "qwen3.7-plus")
    assert bound == {"provider": "qwen", "model": "qwen3.7-plus"}
    assert conversation_meta.read_conversation_model("conv-1") == {"provider": "qwen", "model": "qwen3.7-plus"}
    on_disk = json.loads((tmp_path / "conversation_meta.json").read_text(encoding="utf-8"))
    assert on_disk["conv-1"]["provider"] == "qwen"
    assert on_disk["conv-1"]["model"] == "qwen3.7-plus"
    assert "updatedAt" in on_disk["conv-1"]


def test_read_returns_none_for_empty_or_missing(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    assert conversation_meta.read_conversation_model("") is None
    assert conversation_meta.read_conversation_model("conv-missing") is None


def test_write_rejects_empty_args(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    with pytest.raises(ValueError):
        conversation_meta.write_conversation_model("conv-1", "", "m")
    with pytest.raises(ValueError):
        conversation_meta.write_conversation_model("", "qwen", "m")


def test_routes_get_put(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    client = create_app(StubAgent()).test_client()
    r = client.get("/api/conversations/conv-9/model")
    assert r.status_code == 200
    assert r.get_json() == {"model": None}
    r = client.put("/api/conversations/conv-9/model", json={"provider": "qwen", "model": "qwen3.7-plus"})
    assert r.status_code == 200
    assert r.get_json()["model"] == {"provider": "qwen", "model": "qwen3.7-plus"}
    assert client.get("/api/conversations/conv-9/model").get_json()["model"] == {"provider": "qwen", "model": "qwen3.7-plus"}


def test_route_put_rejects_missing_fields(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    client = create_app(StubAgent()).test_client()
    assert client.put("/api/conversations/conv-9/model", json={}).status_code == 400
