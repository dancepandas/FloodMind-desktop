"""Tests for the catalog CRUD helpers."""
import importlib
from unittest.mock import MagicMock

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


def test_skills_list_deduplicates_registry_and_custom(tmp_path, monkeypatch):
    from floodmind_desktop_sidecar import catalog_api
    monkeypatch.setattr(catalog_api, "_skills_home", lambda: tmp_path / "skills")
    monkeypatch.setattr(catalog_api, "_builtin_skill_names", lambda: {"csv"})
    client = _client()

    # Create a custom skill whose name collides with a built-in skill.
    skill_dir = tmp_path / "skills" / "csv"
    skill_dir.mkdir(parents=True)
    (skill_dir / "SKILL.md").write_text("custom csv", encoding="utf-8")
    (skill_dir / "meta.json").write_text(
        '{"name":"csv","description":"custom","category":"c","version":"1.0","provides_tools":[]}',
        encoding="utf-8",
    )

    r = client.get("/api/skills")
    skills = r.get_json()["skills"]
    csv_entries = [s for s in skills if s["name"] == "csv"]
    assert len(csv_entries) == 1
    # Registry entry should win; custom entry is omitted.


def test_skill_set_disabled_unknown_skill_returns_404(tmp_path, monkeypatch):
    from floodmind_desktop_sidecar import catalog_api
    skills_home = tmp_path / "skills"
    skills_home.mkdir(parents=True)
    monkeypatch.setattr(catalog_api, "_skills_home", lambda: skills_home)
    monkeypatch.setattr(catalog_api, "_builtin_skill_names", lambda: set())
    client = _client()

    r = client.post("/api/skills/no-such-skill/disabled", json={"disabled": True})
    assert r.status_code == 404


def test_mcp_crud_and_test(tmp_path, monkeypatch):
    from floodmind_desktop_sidecar import catalog_api
    monkeypatch.setattr(catalog_api, "_mcp_path", lambda: tmp_path / "mcp.json")
    client = _client()

    # Create
    r = client.post("/api/mcp", json={
        "name": "server1", "transport": "stdio", "command": "echo", "args": ["hello"]
    })
    assert r.status_code == 201
    assert r.get_json()["name"] == "server1"

    # Duplicate create fails
    r = client.post("/api/mcp", json={
        "name": "server1", "transport": "stdio", "command": "echo"
    })
    assert r.status_code == 400

    # Update
    r = client.put("/api/mcp/server1", json={
        "transport": "stdio", "command": "cat"
    })
    assert r.status_code == 200
    assert r.get_json()["command"] == "cat"

    # Update unknown returns 404
    r = client.put("/api/mcp/no-such-server", json={
        "transport": "stdio", "command": "cat"
    })
    assert r.status_code == 404

    # Test
    mock_pool = MagicMock()
    mock_pool.list_servers.return_value = []
    mock_pool.get_server_info.return_value = None
    monkeypatch.setattr(
        "floodmind.agent.mcp_client.get_mcp_client_pool", lambda: mock_pool
    )
    r = client.post("/api/mcp/server1/test")
    assert r.status_code == 200
    assert r.get_json()["ok"] is True
    mock_pool.connect_server.assert_called_once()
    mock_pool.disconnect_server.assert_called_once_with("server1")

    # Test unknown returns 404
    r = client.post("/api/mcp/no-such-server/test")
    assert r.status_code == 404

    # Delete
    r = client.delete("/api/mcp/server1")
    assert r.status_code == 200

    # Delete unknown returns 404
    r = client.delete("/api/mcp/server1")
    assert r.status_code == 404

    # List reflects deletion
    r = client.get("/api/mcp")
    assert r.get_json()["configured"] == {}
