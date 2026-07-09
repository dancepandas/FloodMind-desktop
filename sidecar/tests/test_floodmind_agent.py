from floodmind_desktop_sidecar.floodmind_agent import translate_event


def test_answer_delta_becomes_text():
    out = translate_event({"type": "answer_delta", "content": "Hello"})
    assert out == [{"type": "text", "content": "Hello"}]


def test_action_start_becomes_tool_start():
    out = translate_event(
        {"type": "action_start", "tool_name": "search", "status": "running",
         "call_id": "c1", "tool_input": '{"q": "x"}'}
    )
    assert out == [{"type": "tool_start", "call_id": "c1", "tool_name": "search", "input": '{"q": "x"}'}]


def test_workflow_plan_becomes_plan():
    raw = {"type": "workflow_plan", "title": "T", "steps": [
        {"key": "s1", "label": "a", "title": "A", "status": "pending", "detail": "",
         "outcome": "", "expected_deliverables": [], "output_artifacts": [], "subtasks": []}]}
    out = translate_event(raw)
    assert out[0]["type"] == "plan"
    assert out[0]["title"] == "T"
    assert out[0]["steps"][0]["key"] == "s1"


def test_heartbeat_dropped():
    assert translate_event({"type": "heartbeat"}) == []


def test_final_text_dropped():
    assert translate_event({"type": "final_text", "content": "full answer"}) == []


def test_file_generated_becomes_artifact():
    out = translate_event({"type": "file_generated", "filename": "r.xlsx", "download_url": "/x", "size": 10})
    assert out == [{"type": "artifact", "kind": "file", "name": "r.xlsx", "path": "/x"}]


def test_token_usage_becomes_usage():
    out = translate_event({"type": "token_usage", "prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15})
    assert out == [{"type": "usage", "prompt": 10, "completion": 5, "total": 15}]


def test_llm_token_error_becomes_error():
    # Out-of-balance LLM account — must surface as a user-visible error.
    out = translate_event({"type": "llm_token_error", "content": "LLM模型服务账号Token余额不足"})
    assert out == [{"type": "error", "content": "LLM模型服务账号Token余额不足"}]


def test_floodmind_agent_emits_error_and_done_on_inner_exception():
    # Bypass __init__ (which needs the real SDK + settings) and inject a fake.
    from floodmind_desktop_sidecar.floodmind_agent import FloodMindAgent

    class BoomAgent:
        def stream(self, _msg):
            yield {"type": "answer_delta", "content": "partial"}
            raise RuntimeError("boom")

    a = FloodMindAgent.__new__(FloodMindAgent)
    a._agent = BoomAgent()
    a._workspace_manager = None  # bypass __init__; no workspace binding in this test
    out = list(a.stream([{"role": "user", "content": "hi"}]))
    assert [e["type"] for e in out] == ["text", "error", "done"]
    assert "boom" in out[1]["content"]


def test_unknown_event_passes_through_minimal():
    out = translate_event({"type": "something_new", "content": "x"})
    assert out == [{"type": "something_new", "content": "x"}]
