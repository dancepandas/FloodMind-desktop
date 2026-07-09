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


def test_context_compress_dropped():
    # The agent emits `context_compress`; only the *_start/*_done variants are
    # defined-but-never-called. Make sure the real one is dropped, not passed
    # through as noise.
    assert translate_event({"type": "context_compress", "summary": "...", "saved_tokens": 10,
                            "original_messages": 5, "compressed_messages": 2}) == []


def test_permission_ask_carries_session_id():
    # session_id is required to auto-respond via AskService.respond.
    out = translate_event({"type": "permission_ask", "ask_id": "a1", "session_id": "s1",
                           "call_id": "c1", "tool_name": "exit_plan_mode",
                           "reason": "submit plan", "tool_input": {}})
    assert out[0]["type"] == "permission"
    assert out[0]["session_id"] == "s1"
    assert out[0]["ask_id"] == "a1"


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


def test_floodmind_agent_emits_error_and_done_on_inner_exception(tmp_path, monkeypatch):
    # Run with cwd in a tmp dir so _set_workspace (which calls the real SDK and
    # creates a default-workspace under cwd) doesn't pollute the repo.
    monkeypatch.chdir(tmp_path)
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


def test_reload_model_passes_explicit_config_to_from_settings(monkeypatch):
    # C1 guard: from_settings() reads a module-level singleton frozen at import,
    # so reload_model must derive values from get_config() and pass them
    # explicitly. Assert those exact args are forwarded.
    from floodmind_desktop_sidecar.floodmind_agent import FloodMindAgent

    captured = {}

    class FakeMC:
        @classmethod
        def from_settings(cls, **kw):
            captured.update(kw)
            return "NEW_LLM"

    a = FloodMindAgent.__new__(FloodMindAgent)
    a._llm = "OLD_LLM"
    a._agent = type("A", (), {"session_id": "desktop-default"})()
    a._build_agent = lambda sid, pd: ("AGENT", sid, pd)  # avoid real create_flood_agent

    # Patch the real module objects (floodmind.config.settings is shadowed by a
    # Settings singleton at the package level, so use import_module, not a
    # dotted string).
    import importlib

    monkeypatch.setattr(
        importlib.import_module("floodmind.agent.native.model_client"), "ModelClient", FakeMC
    )
    monkeypatch.setattr(
        importlib.import_module("floodmind.config.settings"),
        "get_config",
        lambda: {
            "model": {
                "provider": "openai",
                "model": "gpt-4o-mini",
                "temperature": 0.9,
                "maxTokens": 2048,
                "enableReasoning": True,
                "enableSearch": False,
            },
            "provider": {"openai": {"options": {"apiKey": "sk-new", "baseURL": "https://api.openai.com/v1"}}},
        },
    )

    assert a.reload_model() is True
    assert captured["model_name"] == "gpt-4o-mini"
    assert captured["api_key"] == "sk-new"
    assert captured["base_url"] == "https://api.openai.com/v1"
    assert captured["temperature"] == 0.9
    assert captured["max_tokens"] == 2048
    assert captured["enable_thinking"] is True
    assert a._llm == "NEW_LLM"


def test_diff_outputs_yields_artifacts(tmp_path):
    from floodmind_desktop_sidecar.floodmind_agent import FloodMindAgent

    out = tmp_path / "outputs"
    out.mkdir()
    (out / "existing.xlsx").write_bytes(b"old")  # present before → not new

    a = FloodMindAgent.__new__(FloodMindAgent)
    a._output_dir = str(out)
    before = a._snapshot_outputs()

    (out / "report.xlsx").write_bytes(b"new")
    (out / "plot.png").write_bytes(b"img")

    arts = list(a._diff_outputs(before))
    names = {(art["kind"], art["name"]) for art in arts}
    assert ("file", "report.xlsx") in names
    assert ("image", "plot.png") in names
    assert all("existing.xlsx" != art["name"] for art in arts)  # pre-existing ignored
    assert all(art["path"].endswith(art["name"]) for art in arts)


def test_stream_surfaces_artifacts_via_output_dir_diff(tmp_path, monkeypatch):
    # file_generated/image_generated are emitted post-loop by the SDK and never
    # reach a stream consumer; FloodMindAgent.stream must diff the output dir.
    from floodmind_desktop_sidecar.floodmind_agent import FloodMindAgent

    out = tmp_path / "out"
    out.mkdir()

    class FakeAgent:
        def stream(self, _msg):
            (out / "result.xlsx").write_bytes(b"x")
            yield {"type": "answer_delta", "content": "done"}

    a = FloodMindAgent.__new__(FloodMindAgent)
    a._agent = FakeAgent()
    a._workspace_manager = None
    monkeypatch.setattr(a, "_set_workspace", lambda: setattr(a, "_output_dir", str(out)))

    events = list(a.stream([{"role": "user", "content": "hi"}]))
    types = [e["type"] for e in events]
    assert "text" in types
    assert any(e["type"] == "artifact" and e["name"] == "result.xlsx" for e in events)
    assert types[-1] == "done"
