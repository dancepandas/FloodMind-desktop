"""Routes for SOUL.md + global AGENTS.md editing."""


def test_get_soul_returns_default(client, monkeypatch, tmp_path):
    monkeypatch.setenv("FLOODMIND_HOME", str(tmp_path))
    res = client.get("/api/config/soul")
    assert res.status_code == 200
    j = res.get_json()
    assert j["isDefault"] is True
    assert "FloodMind" in j["content"]


def test_post_soul_writes_and_reloads(monkeypatch, tmp_path):
    monkeypatch.setenv("FLOODMIND_HOME", str(tmp_path))
    from floodmind_desktop_sidecar.agent import StubAgent
    from floodmind_desktop_sidecar.app import create_app

    class RecAgent(StubAgent):
        def __init__(self):
            self.reloads = 0

        def reload_persona(self):
            self.reloads += 1
            return True

    agent = RecAgent()
    client = create_app(agent).test_client()

    res = client.post("/api/config/soul", json={"content": "你是 TestBot"})
    assert res.status_code == 200
    assert res.get_json()["isDefault"] is False
    assert agent.reloads == 1
    assert (tmp_path / "SOUL.md").read_text(encoding="utf-8") == "你是 TestBot"


def test_post_soul_too_long_returns_400(client, monkeypatch, tmp_path):
    monkeypatch.setenv("FLOODMIND_HOME", str(tmp_path))
    res = client.post("/api/config/soul", json={"content": "x" * 20001})
    assert res.status_code == 400


def test_post_soul_empty_deletes(client, monkeypatch, tmp_path):
    monkeypatch.setenv("FLOODMIND_HOME", str(tmp_path))
    (tmp_path / "SOUL.md").write_text("旧的", encoding="utf-8")
    res = client.post("/api/config/soul", json={"content": "  "})
    assert res.status_code == 200
    assert res.get_json()["isDefault"] is True
    assert not (tmp_path / "SOUL.md").exists()


def test_get_agents_returns_empty_when_absent(client, monkeypatch, tmp_path):
    monkeypatch.setenv("FLOODMIND_HOME", str(tmp_path))
    res = client.get("/api/config/agents")
    assert res.status_code == 200
    assert res.get_json()["content"] == ""


def test_post_agents_writes_and_reloads(monkeypatch, tmp_path):
    monkeypatch.setenv("FLOODMIND_HOME", str(tmp_path))
    from floodmind_desktop_sidecar.agent import StubAgent
    from floodmind_desktop_sidecar.app import create_app

    class RecAgent(StubAgent):
        def __init__(self):
            self.reloads = 0

        def reload_persona(self):
            self.reloads += 1
            return True

    agent = RecAgent()
    client = create_app(agent).test_client()

    res = client.post("/api/config/agents", json={"content": "## 规则\n- 用中文"})
    assert res.status_code == 200
    assert "规则" in res.get_json()["content"]
    assert agent.reloads == 1
