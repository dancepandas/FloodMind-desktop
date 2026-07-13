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
