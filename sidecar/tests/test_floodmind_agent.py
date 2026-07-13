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


def test_activate_conversation_rebuilds_with_session_id(tmp_path, monkeypatch):
    # _memory_target uses _app_data_dir() == cwd.
    monkeypatch.chdir(tmp_path)
    from floodmind_desktop_sidecar.floodmind_agent import FloodMindAgent

    built = []
    a = FloodMindAgent.__new__(FloodMindAgent)
    a._build_agent = lambda sid, pd: built.append((sid, pd)) or ("AGENT", sid, pd)

    a.activate_conversation("sess-xyz")

    assert built == [("sess-xyz", str(tmp_path / "sess-xyz" / "memory"))]
    assert a._agent == ("AGENT", "sess-xyz", str(tmp_path / "sess-xyz" / "memory"))


def test_activate_conversation_swallows_errors(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    from floodmind_desktop_sidecar.floodmind_agent import FloodMindAgent

    a = FloodMindAgent.__new__(FloodMindAgent)
    a._agent = "ORIGINAL"
    a._build_agent = lambda sid, pd: (_ for _ in ()).throw(RuntimeError("nope"))

    a.activate_conversation("sess-1")     # must not raise
    assert a._agent == "ORIGINAL"         # left untouched on failure


def test_generate_title_invokes_llm_and_cleans_output(monkeypatch):
    import importlib
    from floodmind_desktop_sidecar.floodmind_agent import FloodMindAgent

    class FakeResult:
        content = "  1. 帮我画个销售折线图\nignore me"

    class FakeMC:
        last_prompt = None

        @classmethod
        def from_settings(cls, **kw):
            cls.last_kwargs = kw
            llm = type("L", (), {"invoke": lambda self, p: setattr(FakeMC, "last_prompt", p) or FakeResult()})()
            return llm

    monkeypatch.setattr(
        importlib.import_module("floodmind.agent.native.model_client"), "ModelClient", FakeMC
    )

    a = FloodMindAgent.__new__(FloodMindAgent)
    title = a.generate_title("帮我画个销售折线图")

    assert title == "帮我画个销售折线图"           # leading "1. " stripped, trailing line dropped, ≤24
    assert FakeMC.last_kwargs["temperature"] == 0.2
    assert FakeMC.last_kwargs["max_tokens"] == 60
    assert FakeMC.last_kwargs["enable_thinking"] is False
    assert "销售折线图" in FakeMC.last_prompt


def test_generate_title_returns_empty_on_failure(monkeypatch):
    import importlib
    from floodmind_desktop_sidecar.floodmind_agent import FloodMindAgent

    class FakeMC:
        @classmethod
        def from_settings(cls, **kw):
            raise RuntimeError("llm down")

    monkeypatch.setattr(
        importlib.import_module("floodmind.agent.native.model_client"), "ModelClient", FakeMC
    )
    a = FloodMindAgent.__new__(FloodMindAgent)
    assert a.generate_title("anything") == ""    # swallowed, not raised


def test_run_headless_collects_events_artifacts_final_text(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)            # _app_data_dir() == cwd
    from floodmind_desktop_sidecar.floodmind_agent import FloodMindAgent

    class FakeAgent:
        def stream(self, command):         # fresh agent .stream takes a string
            yield {"type": "answer_delta", "content": "Hello "}
            yield {"type": "answer_delta", "content": "world"}
            yield {"type": "file_generated", "filename": "r.xlsx", "download_url": "/o/r.xlsx"}

    a = FloodMindAgent.__new__(FloodMindAgent)
    a._agent = "FOREGROUND_AGENT"          # must be left untouched
    a._build_agent = lambda sid, pd: FakeAgent()
    a._set_workspace_for = lambda path: None     # stubbed — no SDK workspace setup

    events, artifacts, final_text = a.run_headless("sess-x", "/ws/A", "do the thing")

    assert a._agent == "FOREGROUND_AGENT"                # foreground untouched
    assert final_text == "Hello world"
    assert any(e["type"] == "text" for e in events)
    assert any(e["type"] == "artifact" and e["name"] == "r.xlsx" for e in events)
    assert artifacts == [{"kind": "file", "name": "r.xlsx", "path": "/o/r.xlsx"}]
    # no 'done' event in the collected list (terminal event is dropped)
    assert all(e.get("type") != "done" for e in events)


def test_run_headless_swallows_errors_into_an_error_event(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    from floodmind_desktop_sidecar.floodmind_agent import FloodMindAgent

    class BoomAgent:
        def stream(self, command):
            yield {"type": "answer_delta", "content": "partial"}
            raise RuntimeError("boom")

    a = FloodMindAgent.__new__(FloodMindAgent)
    a._agent = "FOREGROUND_AGENT"
    a._build_agent = lambda sid, pd: BoomAgent()
    a._set_workspace_for = lambda path: None

    events, artifacts, final_text = a.run_headless("sess-x", "/ws/A", "go")
    assert a._agent == "FOREGROUND_AGENT"
    assert any(e["type"] == "error" and "boom" in e["content"] for e in events)


def test_run_headless_diffs_output_dir_for_artifacts(tmp_path, monkeypatch):
    # When the SDK doesn't emit file_generated/image_generated, run_headless must
    # still discover artifacts by diffing the workspace output directory.
    monkeypatch.chdir(tmp_path)
    from floodmind_desktop_sidecar.floodmind_agent import FloodMindAgent

    out = tmp_path / "out"
    out.mkdir()

    class FakeAgent:
        def bind_workspace(self, ws):
            pass
        def stream(self, command):
            (out / "report.xlsx").write_bytes(b"data")
            (out / "chart.png").write_bytes(b"img")
            yield {"type": "answer_delta", "content": "ok"}

    a = FloodMindAgent.__new__(FloodMindAgent)
    a._agent = "FOREGROUND_AGENT"
    a._build_agent = lambda sid, pd: FakeAgent()
    import types
    a._set_workspace_for = lambda path: types.SimpleNamespace(user_dir=str(out))

    events, artifacts, final_text = a.run_headless("sess-x", "/ws/A", "go")
    assert a._agent == "FOREGROUND_AGENT"
    names = {(art["kind"], art["name"]) for art in artifacts}
    assert ("file", "report.xlsx") in names
    assert ("image", "chart.png") in names
    assert any(e["type"] == "artifact" and e["name"] == "report.xlsx" for e in events)
    assert final_text == "ok"


def test_reload_persona_rebuilds_and_rebinds_workspace():
    """reload_persona builds a fresh agent (same session) and re-binds the
    workspace so the new SOUL.md/AGENTS.md takes effect immediately."""
    import types
    from floodmind_desktop_sidecar.floodmind_agent import FloodMindAgent

    a = FloodMindAgent.__new__(FloodMindAgent)
    a._agent = types.SimpleNamespace(session_id="sid-1")

    built = []
    a._memory_target = lambda sid: (sid, "/tmp/mem")
    a._build_agent = lambda sid, persist_dir: built.append(sid) or types.SimpleNamespace(session_id=sid)
    rebinds = []
    a._set_workspace = lambda: rebinds.append(True)

    assert a.reload_persona() is True
    assert built == ["sid-1"]          # rebuilt with the SAME session_id
    assert rebinds == [True]           # workspace re-bound (+ prompt refreshed)
    assert a._agent.session_id == "sid-1"


def test_mcp_tool_names_sanitized_for_openai_endpoints():
    """MCP tool names are namespaced with ':' which OpenAI-compatible endpoints reject.

    The desktop patches build_mcp_tool_specs so the model sees a sanitized name
    while the bound function keeps the original 'mcp:server:tool' call signature.
    """
    import re
    from floodmind.agent.mcp_client import build_mcp_tool_specs

    class FakeConn:
        def list_tools(self):
            return [
                {"name": "search:docs", "description": "d", "inputSchema": {"type": "object", "properties": {}}},
                {"name": "ok_tool", "description": "d", "inputSchema": {"type": "object", "properties": {}}},
            ]

    calls = []
    def call_tool(full_name, kwargs):
        calls.append(full_name)
        return "done"

    specs = build_mcp_tool_specs(FakeConn(), "hydro-rag", call_tool)
    names = [s.name for s in specs]
    assert all(re.fullmatch(r"[a-zA-Z0-9_-]+", n) for n in names)
    assert "mcp_hydro-rag_search_docs" in names
    assert "mcp_hydro-rag_ok_tool" in names
    # The bound function still uses the original colon-separated full name.
    specs[names.index("mcp_hydro-rag_search_docs")].func()
    assert calls == ["mcp:hydro-rag:search:docs"]
