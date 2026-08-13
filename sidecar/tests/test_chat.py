import json


def test_chat_streams_ndjson(client):
    response = client.post(
        "/api/chat",
        json={"messages": [{"role": "user", "content": "hi"}]},
    )
    assert response.status_code == 200
    assert response.mimetype == "application/x-ndjson"

    lines = [ln for ln in response.data.decode().splitlines() if ln.strip()]
    events = [json.loads(ln) for ln in lines]

    assert events[-1] == {"type": "done"}
    text = "".join(e["content"] for e in events if e.get("type") == "text")
    assert "hi" in text


def test_chat_rejects_empty_messages(client):
    response = client.post("/api/chat", json={"messages": []})
    assert response.status_code == 400


def test_chat_append_returns_202_and_forwards_to_agent():
    """Mid-run append: /api/chat/append forwards the text to the agent and
    returns 202 queued (effects arrive over the still-open /api/chat stream)."""
    from floodmind_desktop_sidecar.agent import StubAgent
    from floodmind_desktop_sidecar.app import create_app

    class RecordingAgent(StubAgent):
        def __init__(self):
            self.appended = []

        def append_instruction(self, text):
            self.appended.append(text)

    agent = RecordingAgent()
    client = create_app(agent).test_client()

    res = client.post(
        "/api/chat/append",
        json={"messages": [{"role": "user", "content": "顺便也画个图"}]},
    )
    assert res.status_code == 202
    assert res.get_json() == {"status": "queued"}
    assert agent.appended == ["顺便也画个图"]


def test_chat_append_accepts_top_level_text(client):
    res = client.post("/api/chat/append", json={"text": "用中文"})
    assert res.status_code == 202
    assert res.get_json() == {"status": "queued"}


def test_chat_append_rejects_empty(client):
    res = client.post("/api/chat/append", json={"messages": []})
    assert res.status_code == 400


def test_chat_pause_calls_agent_pause():
    """Pause forwards to agent.pause(), which arms the abort_check the SDK polls."""
    from floodmind_desktop_sidecar.agent import StubAgent
    from floodmind_desktop_sidecar.app import create_app

    class RecordingAgent(StubAgent):
        def __init__(self):
            self.paused = 0

        def pause(self):
            self.paused += 1

    agent = RecordingAgent()
    client = create_app(agent).test_client()

    res = client.post("/api/chat/pause")
    assert res.status_code == 200
    assert res.get_json() == {"status": "paused"}
    assert agent.paused == 1


def test_floodmind_agent_pause_arms_abort_check():
    """FloodMindAgent.pause() sets the abort event the SDK's abort_check reads."""
    from floodmind_desktop_sidecar.floodmind_agent import FloodMindAgent

    a = FloodMindAgent.__new__(FloodMindAgent)
    import threading
    a._abort = threading.Event()
    assert a._abort.is_set() is False
    assert a._abort.is_set() is False  # abort_check reads False before pause
    a.pause()
    assert a._abort.is_set() is True   # abort_check now reads True → SDK aborts


# ── checkpoint resume (断点续跑) ─────────────────────────────
def test_chat_resume_requires_checkpoint(client):
    res = client.post("/api/chat/resume", json={})
    assert res.status_code == 400


def test_chat_resume_streams_ndjson_and_forwards_args():
    from floodmind_desktop_sidecar.agent import StubAgent
    from floodmind_desktop_sidecar.app import create_app

    class ResumeAgent(StubAgent):
        def __init__(self):
            self.resumed = None

        def resume_stream(self, checkpoint_id, user_message=""):
            self.resumed = (checkpoint_id, user_message)
            yield {"type": "text", "content": "续接输出"}
            yield {"type": "done"}

    agent = ResumeAgent()
    client = create_app(agent).test_client()

    res = client.post(
        "/api/chat/resume",
        json={"checkpoint_id": "cp-1", "user_message": "继续"},
    )
    assert res.status_code == 200
    assert res.mimetype == "application/x-ndjson"
    lines = [ln for ln in res.data.decode().splitlines() if ln.strip()]
    events = [json.loads(ln) for ln in lines]
    assert events[-1] == {"type": "done"}
    text = "".join(e["content"] for e in events if e.get("type") == "text")
    assert text == "续接输出"
    assert agent.resumed == ("cp-1", "继续")


# ── 重连对账：游标补拉 ─────────────────────────────────────
def test_chat_events_returns_buffered_from_cursor():
    from floodmind_desktop_sidecar.agent import StubAgent
    from floodmind_desktop_sidecar.app import create_app

    class EventsAgent(StubAgent):
        def run_events_since(self, since=0):
            events = [
                {"type": "text", "content": "a"},
                {"type": "text", "content": "b"},
                {"type": "done"},
            ]
            return events[since:], True

    client = create_app(EventsAgent()).test_client()
    r = client.get("/api/chat/events?since=1")
    assert r.status_code == 200
    data = r.get_json()
    assert data["done"] is True
    assert [e["content"] for e in data["events"] if e.get("type") == "text"] == ["b"]


def test_chat_events_rejects_bad_since(client):
    r = client.get("/api/chat/events?since=abc")
    assert r.status_code == 400


# ── 经验库 + 建议技能 (记忆与经验) ───────────────────────────
def test_experience_list_forwards_from_agent():
    from floodmind_desktop_sidecar.agent import StubAgent
    from floodmind_desktop_sidecar.app import create_app

    class ExpAgent(StubAgent):
        def list_experiences(self):
            return {"stats": {"leaf_cases": 2}, "summaries": [], "leaves": [
                {"node_id": "n1", "path": ["水文", "预报"], "task_description": "预报洪峰",
                 "final_outcome": "success", "importance": 0.7}
            ]}

    client = create_app(ExpAgent()).test_client()
    r = client.get("/api/experience")
    assert r.status_code == 200
    data = r.get_json()
    assert data["stats"]["leaf_cases"] == 2
    assert data["leaves"][0]["task_description"] == "预报洪峰"


def test_experience_feedback_requires_node_id(client):
    r = client.post("/api/experience/feedback", json={"helpful": True})
    assert r.status_code == 400


def test_skill_drafts_approve_and_reject():
    from floodmind_desktop_sidecar.agent import StubAgent
    from floodmind_desktop_sidecar.app import create_app

    class DraftAgent(StubAgent):
        def __init__(self):
            self.approved = []
            self.rejected = []

        def list_draft_skills(self):
            return [{"name": "hydrology-forecast", "description": "水文预报", "path": "/x", "keywords": []}]

        def approve_draft_skill(self, name):
            self.approved.append(name)
            return True

        def reject_draft_skill(self, name):
            self.rejected.append(name)
            return True

    agent = DraftAgent()
    client = create_app(agent).test_client()

    r = client.get("/api/skills/drafts")
    assert r.get_json()["drafts"][0]["name"] == "hydrology-forecast"

    assert client.post("/api/skills/drafts/hydrology-forecast/approve").get_json()["ok"] is True
    assert client.post("/api/skills/drafts/hydrology-forecast/reject").get_json()["ok"] is True
    assert agent.approved == ["hydrology-forecast"]
    assert agent.rejected == ["hydrology-forecast"]


# ── 插件管理器 ─────────────────────────────────────────────
def test_plugins_list_and_disable(tmp_path):
    from floodmind_desktop_sidecar.agent import StubAgent
    from floodmind_desktop_sidecar.app import create_app

    class PluginAgent(StubAgent):
        def list_plugins(self):
            return [{"name": "demo", "version": "0.1.0", "description": "演示插件",
                     "source": "/x/demo.py", "kind": "file", "disabled": False}]

        def set_plugin_disabled(self, source, disabled):
            assert source == "/x/demo.py"
            assert disabled is True
            return True

    agent = PluginAgent()
    client = create_app(agent).test_client()

    r = client.get("/api/plugins")
    assert r.get_json()["plugins"][0]["name"] == "demo"

    r = client.post("/api/plugins/disabled", json={"source": "/x/demo.py", "disabled": True})
    assert r.get_json()["ok"] is True


def test_plugins_disable_requires_source(client):
    assert client.post("/api/plugins/disabled", json={"disabled": True}).status_code == 400
