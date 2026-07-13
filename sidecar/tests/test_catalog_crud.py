"""Tests for the catalog CRUD helpers."""
import importlib

from floodmind_desktop_sidecar import catalog_api
from floodmind_desktop_sidecar.agent import StubAgent
from floodmind_desktop_sidecar.app import create_app


def _client():
    return create_app(StubAgent()).test_client()


def test_read_write_skills_disabled(tmp_path, monkeypatch):
    settings_mod = importlib.import_module("floodmind.config.settings")
    monkeypatch.setattr(settings_mod, "_config_path", lambda: tmp_path / "settings.json")

    assert catalog_api.read_skills_disabled() == []
    catalog_api.write_skills_disabled(["csv", "pdf"])
    assert catalog_api.read_skills_disabled() == ["csv", "pdf"]
    catalog_api.write_skills_disabled([])
    assert catalog_api.read_skills_disabled() == []


def test_skill_create_update_delete(tmp_path, monkeypatch):
    from floodmind_desktop_sidecar import catalog_api
    monkeypatch.setattr(catalog_api, "_skills_home", lambda: tmp_path / "skills")
    monkeypatch.setattr(catalog_api, "_builtin_skill_names", lambda: {"csv"})
    client = _client()

    r = client.post("/api/skills", json={
        "name": "my-skill", "description": "d", "category": "c",
        "version": "1.0", "prompt": "# p"
    })
    assert r.status_code == 201

    r = client.get("/api/skills")
    names = [s["name"] for s in r.get_json()["skills"]]
    assert "my-skill" in names

    r = client.put("/api/skills/my-skill", json={
        "description": "d2", "category": "c2", "version": "1.1", "prompt": "# p2"
    })
    assert r.status_code == 200
    assert r.get_json()["description"] == "d2"

    assert client.delete("/api/skills/my-skill").status_code == 200
    assert client.delete("/api/skills/csv").status_code == 403
