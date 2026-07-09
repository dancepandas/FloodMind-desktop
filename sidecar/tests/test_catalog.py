"""Tests for the Skills & MCP catalog endpoints.

The handlers import the SDK accessors lazily at call time, so we monkeypatch the
module-level functions they import — no live agent / skill scan required.
"""
from types import SimpleNamespace

from floodmind_desktop_sidecar.app import create_app
from floodmind_desktop_sidecar.agent import StubAgent


def _client():
    return create_app(StubAgent()).test_client()


def test_skills_list(monkeypatch):
    fake = [{"name": "csv", "description": "CSV ops", "category": "execution",
             "version": "1.0", "source": "/skills/csv", "disabled": False}]
    monkeypatch.setattr(
        "floodmind.skills.registry.get_skill_registry",
        lambda: SimpleNamespace(list_skills=lambda: fake),
    )
    r = _client().get("/api/skills")
    assert r.status_code == 200
    assert r.get_json()["skills"] == fake


def test_skill_detail(monkeypatch):
    skill = SimpleNamespace(
        name="pdf", description="PDF generation", prompt="do the thing",
        category="execution", provides_tools=["make_pdf"], version="1.2",
    )
    monkeypatch.setattr(
        "floodmind.skills.registry.get_skill_registry",
        lambda: SimpleNamespace(get_skill=lambda n: skill if n == "pdf" else None),
    )
    r = _client().get("/api/skills/pdf")
    assert r.status_code == 200
    body = r.get_json()
    assert body["name"] == "pdf"
    assert body["prompt"] == "do the thing"
    assert body["provides_tools"] == ["make_pdf"]

    assert _client().get("/api/skills/missing").status_code == 404


def test_mcp_list(monkeypatch):
    servers = [{"name": "fs", "transport": "stdio", "tools": 3, "connected": True}]
    monkeypatch.setattr(
        "floodmind.agent.mcp_client.get_mcp_client_pool",
        lambda: SimpleNamespace(list_servers=lambda: servers),
    )
    r = _client().get("/api/mcp")
    assert r.status_code == 200
    assert r.get_json()["servers"] == servers


def test_mcp_detail(monkeypatch):
    info = {"name": "fs", "transport": "stdio", "tools": ["read", "write"], "connected": True}

    class Pool:
        def get_server_info(self, n):
            return info if n == "fs" else None

    monkeypatch.setattr("floodmind.agent.mcp_client.get_mcp_client_pool", lambda: Pool())
    r = _client().get("/api/mcp/fs")
    assert r.status_code == 200
    assert r.get_json()["tools"] == ["read", "write"]
    assert _client().get("/api/mcp/missing").status_code == 404


def test_endpoints_degrade_when_sdk_unavailable(monkeypatch):
    # If the registry/pool can't even be imported/initialized, list endpoints
    # return empty (not 500) and detail endpoints 404 — matching frontend behavior.
    def _boom(*a, **kw):
        raise ImportError("sdk not initialized")

    monkeypatch.setattr("floodmind.skills.registry.get_skill_registry", _boom)
    monkeypatch.setattr("floodmind.agent.mcp_client.get_mcp_client_pool", _boom)

    sk = _client().get("/api/skills")
    assert sk.status_code == 200
    assert sk.get_json()["skills"] == []
    assert _client().get("/api/skills/anything").status_code == 404

    mcp = _client().get("/api/mcp")
    assert mcp.status_code == 200
    assert mcp.get_json()["servers"] == []
    assert _client().get("/api/mcp/anything").status_code == 404
