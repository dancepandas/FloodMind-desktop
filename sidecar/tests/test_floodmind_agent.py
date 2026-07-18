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


def test_mcp_call_health_tracks_outcome():
    # The McpClientPool.call_tool wrapper records the most-recent tool-call
    # outcome per server, so the UI can flag a connected wrapper whose backend
    # is actually down (e.g. hydro-rag "无法连接").
    from floodmind.agent.mcp_client import McpClientPool
    from floodmind_desktop_sidecar.floodmind_agent import _MCP_CALL_HEALTH

    saved = dict(_MCP_CALL_HEALTH)
    try:
        pool = McpClientPool()

        class DownConn:
            def call_tool(self, tool, args):
                return "知识库服务无法连接"
            def list_tools(self):
                return []

        class UpConn:
            def call_tool(self, tool, args):
                return "正常的检索结果"
            def list_tools(self):
                return []

        pool._connections["hydro-rag"] = DownConn()
        pool.call_tool("mcp:hydro-rag:search", {})
        assert _MCP_CALL_HEALTH["hydro-rag"]["ok"] is False
        assert "无法连接" in _MCP_CALL_HEALTH["hydro-rag"]["error"]

        pool._connections["ok-svc"] = UpConn()
        pool.call_tool("mcp:ok-svc:query", {})
        assert _MCP_CALL_HEALTH["ok-svc"]["ok"] is True
    finally:
        _MCP_CALL_HEALTH.clear()
        _MCP_CALL_HEALTH.update(saved)


def test_persist_runtime_mcp_writes_and_dedupes(tmp_path, monkeypatch):
    # A runtime-loaded MCP (LoadMcpServer) must be appended to mcp.json so it
    # survives restart and shows in the MCP menu; repeated calls don't duplicate.
    import json
    from floodmind_desktop_sidecar import catalog_api, floodmind_agent

    monkeypatch.setattr(catalog_api, "_mcp_path", lambda: tmp_path / "mcp.json")

    floodmind_agent._persist_runtime_mcp(
        {"name": "chronos-flow-predictor", "transport": "stdio", "command": "python",
         "args": [r"E:\forecast\chronos_mcp_server.py"]}
    )
    data = json.loads((tmp_path / "mcp.json").read_text(encoding="utf-8"))
    names = [s["name"] for s in data["servers"]]
    assert "chronos-flow-predictor" in names

    # Idempotent: a second persist for the same name doesn't duplicate.
    floodmind_agent._persist_runtime_mcp(
        {"name": "chronos-flow-predictor", "transport": "stdio", "command": "python"}
    )
    data = json.loads((tmp_path / "mcp.json").read_text(encoding="utf-8"))
    assert sum(1 for s in data["servers"] if s["name"] == "chronos-flow-predictor") == 1


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


def test_reload_model_resolves_active_model_and_rebuilds(monkeypatch):
    # reload_model() must re-read settings.json, resolve the desktop's active
    # model via resolve_model() (single source of truth), construct a ModelClient
    # with that model's credentials/params, and rebuild the agent.
    import importlib
    from floodmind.config.model_resolver import ResolvedModel
    from floodmind_desktop_sidecar.floodmind_agent import FloodMindAgent

    captured = {}

    class FakeMC:
        def __init__(self, **kw):
            captured.update(kw)

    a = FloodMindAgent.__new__(FloodMindAgent)
    a._llm = "OLD_LLM"
    a._agent = type("A", (), {"session_id": "desktop-default"})()
    a._build_agent = lambda sid, pd: ("AGENT", sid, pd)  # avoid real create_flood_agent

    rm = ResolvedModel(
        provider="openai", id="gpt-4o-mini", name="GPT-4o mini",
        api_key="sk-new", base_url="https://api.openai.com/v1",
        temperature=0.9, max_tokens=2048, context_window=128000,
        supports_reasoning=True, supports_vision=False,
    )
    # Patch the real module objects (floodmind.config.settings is shadowed by a
    # Settings singleton at the package level, so use import_module).
    monkeypatch.setattr(
        importlib.import_module("floodmind.config.model_resolver"),
        "resolve_model",
        lambda model_key=None, provider_id=None: rm,
    )
    monkeypatch.setattr(
        importlib.import_module("floodmind.agent.native.model_client"),
        "ModelClient",
        FakeMC,
    )
    monkeypatch.setattr(
        importlib.import_module("floodmind.config.settings"),
        "reload_config",
        lambda: None,
    )
    monkeypatch.setattr(
        FloodMindAgent, "_desktop_block",
        lambda self: {"activeModel": "gpt-4o-mini", "enableReasoning": True},
    )

    assert a.reload_model() is True
    assert captured["model_name"] == "gpt-4o-mini"
    assert captured["api_key"] == "sk-new"
    assert captured["base_url"] == "https://api.openai.com/v1"
    assert captured["temperature"] == 0.9
    assert captured["max_tokens"] == 2048
    assert captured["enable_thinking"] is True
    assert isinstance(a._llm, FakeMC)


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

    class FakeRM:
        api_key = "k"
        base_url = "http://x/v1"
        id = "deepseek-v4-flash"

    class FakeMC:
        last_kwargs = None
        last_prompt = None

        def __init__(self, **kw):
            FakeMC.last_kwargs = kw

        def invoke(self, prompt):
            FakeMC.last_prompt = prompt
            return FakeResult()

    resolver = importlib.import_module("floodmind.config.model_resolver")
    monkeypatch.setattr(resolver, "resolve_model", lambda **kw: FakeRM())
    mc = importlib.import_module("floodmind.agent.native.model_client")
    monkeypatch.setattr(mc, "ModelClient", FakeMC)

    a = FloodMindAgent.__new__(FloodMindAgent)
    monkeypatch.setattr(a, "_desktop_block", lambda: {})
    title = a.generate_title("帮我画个销售折线图")

    assert title == "帮我画个销售折线图"           # leading "1. " stripped, trailing line dropped, ≤24
    assert FakeMC.last_kwargs["temperature"] == 0.2
    assert FakeMC.last_kwargs["max_tokens"] == 10000
    assert FakeMC.last_kwargs["enable_thinking"] is False
    assert "销售折线图" in FakeMC.last_prompt


def test_generate_title_uses_desktop_active_provider(monkeypatch):
    """Regression: generate_title must hand resolve_model the GUI's activeModel
    + activeProvider. Without it, resolve_model picks the catalog-first provider,
    which can be a different region/key and 401 — leaving every conversation on
    the "新会话" fallback title."""
    import importlib
    from floodmind_desktop_sidecar.floodmind_agent import FloodMindAgent

    resolver = importlib.import_module("floodmind.config.model_resolver")
    mc = importlib.import_module("floodmind.agent.native.model_client")
    captured = {}

    class FakeRM:
        api_key = "proxy-key"
        base_url = "http://192.168.30.112:3000/v1"
        id = "deepseek-v4-flash"

    def fake_resolve(*, model_key=None, provider_id=None):
        captured["model_key"] = model_key
        captured["provider_id"] = provider_id
        return FakeRM()

    class FakeLLM:
        def __init__(self, **kw):
            captured["client_kwargs"] = kw

        def invoke(self, prompt):
            return type("R", (), {"content": "预报分析"})()

    monkeypatch.setattr(resolver, "resolve_model", fake_resolve)
    monkeypatch.setattr(mc, "ModelClient", FakeLLM)

    a = FloodMindAgent.__new__(FloodMindAgent)
    monkeypatch.setattr(
        a, "_desktop_block",
        lambda: {"activeModel": "deepseek-v4-flash", "activeProvider": "openai"},
    )
    a.generate_title("建一个chronos预报MCP")

    assert captured["model_key"] == "deepseek-v4-flash"
    assert captured["provider_id"] == "openai"
    # The resolved model's provider credentials are what get used — not the
    # catalog default. This is what avoids the cross-provider 401.
    assert captured["client_kwargs"]["base_url"] == "http://192.168.30.112:3000/v1"
    assert captured["client_kwargs"]["api_key"] == "proxy-key"
    assert captured["client_kwargs"]["model_name"] == "deepseek-v4-flash"


def test_generate_title_returns_empty_on_failure(monkeypatch):
    import importlib
    from floodmind_desktop_sidecar.floodmind_agent import FloodMindAgent

    class FakeRM:
        api_key = "k"
        base_url = "http://x/v1"
        id = "m"

    class FakeMC:
        def __init__(self, **kw):
            raise RuntimeError("llm down")

    resolver = importlib.import_module("floodmind.config.model_resolver")
    monkeypatch.setattr(resolver, "resolve_model", lambda **kw: FakeRM())
    mc = importlib.import_module("floodmind.agent.native.model_client")
    monkeypatch.setattr(mc, "ModelClient", FakeMC)
    a = FloodMindAgent.__new__(FloodMindAgent)
    monkeypatch.setattr(a, "_desktop_block", lambda: {})
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


def test_run_headless_auto_approves_permission_asks(tmp_path, monkeypatch):
    # Headless/scheduled tasks run unattended, so every permission_ask must be
    # auto-approved — otherwise the executor blocks forever waiting for a user.
    monkeypatch.chdir(tmp_path)
    from floodmind_desktop_sidecar.floodmind_agent import FloodMindAgent

    class FakeAgent:
        def stream(self, command):
            yield {"type": "permission_ask", "ask_id": "a1", "session_id": "s1",
                   "tool_name": "Write", "tool_input": {}, "reason": "写文件"}
            yield {"type": "answer_delta", "content": "done"}

    a = FloodMindAgent.__new__(FloodMindAgent)
    a._agent = "FOREGROUND_AGENT"
    a._build_agent = lambda sid, pd: FakeAgent()
    a._set_workspace_for = lambda path: None

    approved_calls = []
    a._respond_to_ask = lambda raw, approved=False: approved_calls.append((raw.get("ask_id"), approved))

    events, _artifacts, _final = a.run_headless("sess-x", "/ws/A", "go")

    # The ask was auto-approved (headless is unattended — no global mode needed).
    assert approved_calls == [("a1", True)]
    perm = next(e for e in events if e["type"] == "permission")
    assert perm["approved"] is True
    assert perm["auto_approved"] is True


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


def test_patch_tool_policies_upgrades_non_readonly_to_ask():
    from floodmind_desktop_sidecar.floodmind_agent import FloodMindAgent
    from floodmind.agent.runtime.contracts.permissions import (
        PermissionBehavior,
        ToolPermissionPolicy,
    )

    class FakeTool:
        def __init__(self, name, policy_type):
            self.name = name
            self.permission_policy = ToolPermissionPolicy(policy_type=policy_type)
            self.check_permissions_fn = None

    class FakeRegistry:
        def __init__(self, tools):
            self._tools = tools

        def all(self):
            return self._tools

    class FakeAgent:
        def __init__(self, tools):
            self._orchestrator_registry = FakeRegistry(tools)
            self._specialist_registry = FakeRegistry(tools)

    a = FloodMindAgent.__new__(FloodMindAgent)
    tools = [
        FakeTool("Bash", "exec"),
        FakeTool("WriteFile", "write"),
        FakeTool("ReadFile", "read_path"),
        FakeTool("WebSearch", "network"),
        FakeTool("Glob", "readonly"),
        FakeTool("SubAgent", "internal"),
        FakeTool("UpdateProjectInstructions", "ask"),
    ]
    fake_agent = FakeAgent(tools)
    a._patch_tool_policies_for_desktop_permission(fake_agent)

    for tool in fake_agent._orchestrator_registry.all():
        policy_type = tool.permission_policy.policy_type
        if policy_type in {"readonly", "internal", "ask"}:
            assert tool.check_permissions_fn is None, f"{tool.name} should keep original policy"
        else:
            assert tool.check_permissions_fn is not None, f"{tool.name} should get desktop check fn"
            result = tool.check_permissions_fn({})
            assert result.behavior == PermissionBehavior.ASK, f"{tool.name} should ask"


# ── permission respond round-trip (I6) ──────────────────────────
def _permission_agent(tmp_path, monkeypatch, ask_service):
    """A FloodMindAgent wired for trust-once, with the SDK AskService mocked."""
    monkeypatch.chdir(tmp_path)
    import importlib
    from floodmind_desktop_sidecar.floodmind_agent import FloodMindAgent
    from floodmind_desktop_sidecar.permissions import PermissionMode, PENDING_ASKS

    ask_mod = importlib.import_module("floodmind.agent.runtime.services.ask_service")
    monkeypatch.setattr(ask_mod, "get_ask_service", lambda: ask_service)

    PENDING_ASKS.clear()
    a = FloodMindAgent.__new__(FloodMindAgent)
    a._permission_mode = PermissionMode.TRUST_ONCE
    a._workspace_manager = type("W", (), {"current_path": lambda self: str(tmp_path)})()
    a._permission_cache = None
    return a


class _RecordingAskService:
    def __init__(self):
        self.responded = []

    def respond(self, resp):
        self.responded.append((resp.ask_id, resp.approved))


def test_respond_caches_fingerprint_on_approve(tmp_path, monkeypatch):
    from floodmind_desktop_sidecar.permissions import (
        PENDING_ASKS, PermissionCache, permission_fingerprint,
    )

    svc = _RecordingAskService()
    a = _permission_agent(tmp_path, monkeypatch, svc)
    PENDING_ASKS.register("ask-1", "sess-1", "ignored-stored-fp", "Bash", {"command": "ls -la"})

    assert a.respond_to_permission_ask("ask-1", True) == {"ok": True}
    assert svc.responded == [("ask-1", True)]
    assert PENDING_ASKS.pop("ask-1") is None            # registry drained

    expected_fp = permission_fingerprint("Bash", {"command": "ls -la"}, str(tmp_path))
    assert PermissionCache(str(tmp_path)).is_approved(expected_fp)
    assert (tmp_path / ".floodmind" / "permissions.json").exists()


def test_respond_does_not_cache_on_reject(tmp_path, monkeypatch):
    from floodmind_desktop_sidecar.permissions import PENDING_ASKS

    svc = _RecordingAskService()
    a = _permission_agent(tmp_path, monkeypatch, svc)
    PENDING_ASKS.register("ask-2", "sess-2", "fp", "WriteFile", {"path": "x.txt"})

    assert a.respond_to_permission_ask("ask-2", False) == {"ok": True}
    assert svc.responded == [("ask-2", False)]
    # Rejected fingerprints are never cached (no file written).
    assert not (tmp_path / ".floodmind" / "permissions.json").exists()


def test_respond_unknown_ask_returns_error(tmp_path, monkeypatch):
    from floodmind_desktop_sidecar.permissions import PENDING_ASKS

    a = _permission_agent(tmp_path, monkeypatch, _RecordingAskService())
    PENDING_ASKS.clear()
    result = a.respond_to_permission_ask("does-not-exist", True)
    assert "error" in result


def test_respond_sdk_failure_returns_error(tmp_path, monkeypatch):
    from floodmind_desktop_sidecar.permissions import PENDING_ASKS

    class BoomAskService:
        def respond(self, resp):
            raise RuntimeError("ask service down")

    a = _permission_agent(tmp_path, monkeypatch, BoomAskService())
    PENDING_ASKS.register("ask-3", "sess-3", "fp", "Bash", {"command": "rm"})

    result = a.respond_to_permission_ask("ask-3", True)
    assert "error" in result
    # The pending ask was popped before the SDK call, so a retry won't find it.
    assert PENDING_ASKS.pop("ask-3") is None


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


# ── concurrency: stream serialization + disconnect teardown (C3 + I1) ──
import threading  # noqa: E402


def _concurrent_agent():
    """A bare FloodMindAgent with locks + abort set, bypassing __init__."""
    from floodmind_desktop_sidecar.floodmind_agent import FloodMindAgent
    a = FloodMindAgent.__new__(FloodMindAgent)
    a._workspace_manager = None
    a._abort = threading.Event()
    a._stream_lock = threading.Lock()
    a._fg_lock = threading.RLock()
    a._set_workspace = lambda: None
    return a


def test_stream_serializes_concurrent_runs(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)

    class BlockingAgent:
        def stream(self, _msg, **_kw):
            yield {"type": "answer_delta", "content": "x"}
            release.wait(timeout=2)          # hold the stream open
            yield {"type": "answer_delta", "content": "y"}

    release = threading.Event()
    a = _concurrent_agent()
    a._agent = BlockingAgent()

    out1 = []

    def run1():
        out1.extend(a.stream([{"role": "user", "content": "hi"}]))

    t = threading.Thread(target=run1)
    t.start()
    # Give the thread a beat to acquire the lock + yield its first event.
    import time
    time.sleep(0.05)
    # While run1 holds the stream lock, a second stream must fail fast.
    out2 = list(a.stream([{"role": "user", "content": "second"}]))
    assert out2[0]["type"] == "error"
    assert "执行" in out2[0]["content"]
    assert out2[1]["type"] == "done"

    release.set()
    t.join(timeout=2)
    assert out1 and out1[-1]["type"] == "done"


def test_stream_releases_lock_and_allows_followup(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)

    class DoneAgent:
        def stream(self, _msg, **_kw):
            yield {"type": "answer_delta", "content": "ok"}

    a = _concurrent_agent()
    a._agent = DoneAgent()

    out = list(a.stream([{"role": "user", "content": "hi"}]))
    assert out[-1]["type"] == "done"
    assert not a._stream_lock.locked()       # lock released on completion
    assert a._abort.is_set()                 # abort set in finally (cleared next run)
    # Follow-up run works because the lock was released.
    out2 = list(a.stream([{"role": "user", "content": "again"}]))
    assert out2[-1]["type"] == "done"


def test_stream_sets_abort_and_releases_on_disconnect(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)

    class LongAgent:
        def stream(self, _msg, **_kw):
            for i in range(5):
                yield {"type": "answer_delta", "content": str(i)}

    a = _concurrent_agent()
    a._agent = LongAgent()

    g = a.stream([{"role": "user", "content": "hi"}])
    next(g)                                   # consume one event; generator suspended, lock held
    g.close()                                 # simulate client disconnect
    assert a._abort.is_set()                  # teardown armed the abort signal
    assert not a._stream_lock.locked()        # lock released even on abnormal close


# ── vision attachments: stream() forwards to SDK + non-vision gate (Task 5) ──
def _bare_vision_agent(monkeypatch, supports_vision: bool):
    """A bare FloodMindAgent wired for unit-testing stream()'s attachment path.

    Avoids __init__ (no real SDK build, no filesystem setup). All bare attrs
    are set to None so the getattr guards in stream()/_fg() handle them; the
    FakeAgent is the only live piece. _set_workspace is monkeypatched to a
    no-op so a bare instance never touches the real workspace/app-data setup
    or the SDK's bind_workspace.
    """
    from floodmind_desktop_sidecar import floodmind_agent as fa

    agent = fa.FloodMindAgent.__new__(fa.FloodMindAgent)
    agent._agent = None  # caller sets
    agent._workspace_manager = None
    agent._stream_lock = None
    agent._fg_lock = None
    agent._output_dir = None
    agent._abort = threading.Event()
    agent._abort.clear()
    monkeypatch.setattr(fa.FloodMindAgent, "_set_workspace", lambda self: None)
    monkeypatch.setattr(
        fa.FloodMindAgent, "_active_supports_vision", lambda self: supports_vision
    )
    monkeypatch.setattr(fa.FloodMindAgent, "_current_workspace_path", lambda self: None)
    return agent


def test_stream_passes_attachments_to_agent(monkeypatch, tmp_path):
    """stream() normalizes descriptors and forwards SDK Attachments to agent.stream."""
    import base64
    from floodmind_desktop_sidecar import floodmind_agent as fa

    captured = {}

    class FakeAgent:
        def stream(self, user_text, attachments=None, abort_check=None):
            captured["text"] = user_text
            captured["attachments"] = list(attachments or [])
            yield {"type": "text", "content": "ok"}
            yield {"type": "done"}

    agent = _bare_vision_agent(monkeypatch, supports_vision=True)
    agent._agent = FakeAgent()

    png = base64.b64decode(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC")
    img = tmp_path / "x.png"
    img.write_bytes(png)
    desc = [{"source": "file", "path": str(img), "name": "x.png", "mime": "image/png"}]
    events = list(agent.stream([{"role": "user", "content": "看图"}], attachments=desc))
    assert captured["text"] == "看图"
    assert len(captured["attachments"]) == 1
    assert captured["attachments"][0].kind == "image"
    assert any(e.get("type") == "done" for e in events)


def test_stream_non_vision_model_yields_error_and_drops_attachments(monkeypatch, tmp_path):
    """Non-vision active model: attachments are dropped and an error event surfaces."""
    import base64
    from floodmind_desktop_sidecar import floodmind_agent as fa

    captured = {}

    class FakeAgent:
        def stream(self, user_text, attachments=None, abort_check=None):
            captured["attachments"] = list(attachments or [])
            yield {"type": "done"}

    agent = _bare_vision_agent(monkeypatch, supports_vision=False)
    agent._agent = FakeAgent()

    png = base64.b64decode(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC")
    img = tmp_path / "x.png"
    img.write_bytes(png)
    events = list(agent.stream(
        [{"role": "user", "content": "hi"}],
        attachments=[{"source": "file", "path": str(img), "name": "x.png"}],
    ))
    assert captured["attachments"] == []
    assert any("不支持图片" in e.get("content", "")
               for e in events if e.get("type") == "error")
