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
