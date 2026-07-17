from floodmind_desktop_sidecar.agent import StubAgent
from floodmind_desktop_sidecar.app import create_app


class SpyAgent(StubAgent):
    def __init__(self):
        self.activated = []
        self.title_input = None

    def activate_conversation(self, session_id):
        self.activated.append(session_id)

    def generate_title(self, message):
        self.title_input = message
        return "生成的标题"


def _client(tmp_path, monkeypatch, spy=None):
    monkeypatch.chdir(tmp_path)          # _app_data_dir() == cwd
    spy = spy or SpyAgent()
    client = create_app(spy).test_client()
    return client, spy


def test_create_then_list_then_get(tmp_path, monkeypatch):
    client, _ = _client(tmp_path, monkeypatch)
    r = client.post("/api/conversations", json={"workspace": "/ws/A"})
    assert r.status_code == 200
    rec = r.get_json()
    assert rec["id"].startswith("conv-")
    conv_id = rec["id"]

    r = client.get("/api/conversations?workspace=/ws/A")
    assert r.status_code == 200
    items = r.get_json()["conversations"]
    assert [i["id"] for i in items] == [conv_id]
    assert items[0]["active"] is True

    r = client.get(f"/api/conversations/{conv_id}")
    assert r.status_code == 200
    assert r.get_json()["id"] == conv_id


def test_create_activates_agent(tmp_path, monkeypatch):
    client, spy = _client(tmp_path, monkeypatch)
    rec = client.post("/api/conversations", json={"workspace": "/ws/A"}).get_json()
    assert spy.activated == [rec["session_id"]]


def test_create_requires_workspace(tmp_path, monkeypatch):
    client, _ = _client(tmp_path, monkeypatch)
    r = client.post("/api/conversations", json={})
    assert r.status_code == 400


def test_activate_endpoint_rebuilds_and_sets_active(tmp_path, monkeypatch):
    client, spy = _client(tmp_path, monkeypatch)
    a = client.post("/api/conversations", json={"workspace": "/ws/A"}).get_json()
    b = client.post("/api/conversations", json={"workspace": "/ws/A"}).get_json()
    spy.activated.clear()

    r = client.post(f"/api/conversations/{a['id']}/activate")
    assert r.status_code == 200
    assert spy.activated == [a["session_id"]]
    # active pointer now points at a
    items = {i["id"]: i for i in client.get("/api/conversations?workspace=/ws/A").get_json()["conversations"]}
    assert items[a["id"]]["active"] is True
    assert items[b["id"]]["active"] is False


def test_append_turns_and_title(tmp_path, monkeypatch):
    client, spy = _client(tmp_path, monkeypatch)
    conv = client.post("/api/conversations", json={"workspace": "/ws/A"}).get_json()

    r = client.post(f"/api/conversations/{conv['id']}/turns", json={
        "turns": [{"role": "user", "content": "帮我画图"}, {"role": "assistant", "blocks": []}]
    })
    assert r.status_code == 200
    data = r.get_json()
    assert data["ok"] is True
    assert data["title"] == "生成的标题"          # generated title returned immediately
    assert spy.title_input == "帮我画图"          # first user message used
    rec = client.get(f"/api/conversations/{conv['id']}").get_json()
    assert rec["title"] == "生成的标题"           # title persisted
    assert len(rec["turns"]) == 2


def test_append_turns_only_generates_title_on_first_turn(tmp_path, monkeypatch):
    client, spy = _client(tmp_path, monkeypatch)
    conv = client.post("/api/conversations", json={"workspace": "/ws/A"}).get_json()
    client.post(f"/api/conversations/{conv['id']}/turns", json={"turns": [{"role": "user", "content": "a"}]})
    spy.title_input = None
    client.post(f"/api/conversations/{conv['id']}/turns", json={"turns": [{"role": "user", "content": "b"}]})
    assert spy.title_input is None                  # no title gen on 2nd append


def test_append_turns_404_for_missing(tmp_path, monkeypatch):
    client, _ = _client(tmp_path, monkeypatch)
    r = client.post("/api/conversations/conv-nope/turns", json={"turns": []})
    assert r.status_code == 404


def test_delete_removes_conversation(tmp_path, monkeypatch):
    client, _ = _client(tmp_path, monkeypatch)
    conv = client.post("/api/conversations", json={"workspace": "/ws/A"}).get_json()
    r = client.delete(f"/api/conversations/{conv['id']}")
    assert r.status_code == 200
    assert client.get(f"/api/conversations/{conv['id']}").status_code == 404
    assert client.delete(f"/api/conversations/{conv['id']}").status_code == 404


def test_traversal_conv_id_is_rejected(tmp_path, monkeypatch):
    """A conv_id that tries to escape the conversations dir must 404, not 500 (C2)."""
    client, _ = _client(tmp_path, monkeypatch)
    bad = "..%2F..%2Fsecret"  # URL-encoded "../../secret"
    assert client.get(f"/api/conversations/{bad}").status_code == 404
    assert client.post(f"/api/conversations/{bad}/turns", json={"turns": []}).status_code == 404
    assert client.post(f"/api/conversations/{bad}/activate").status_code == 404
    assert client.delete(f"/api/conversations/{bad}").status_code == 404

