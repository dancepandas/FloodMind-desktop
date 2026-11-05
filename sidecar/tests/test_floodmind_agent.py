import os

from floodmind_desktop_sidecar.floodmind_agent import translate_event


def test_diagnostics_returns_compact_tool_summary(monkeypatch):
    from floodmind_desktop_sidecar.floodmind_agent import FloodMindAgent

    class Tool:
        def __init__(self, name, description):
            self.name = name
            self.description = description
            self.is_readonly = False
            self.is_destructive = True

    registry = type("Registry", (), {"all": lambda self: [
        Tool("Bash", "[必填] command: should stay out of diagnostics"),
        Tool("mcp_demo", "[MCP:demo] should stay out too"),
    ]})()
    loader = type("Loader", (), {
        "loaded_tools": {"Bash", "stale_tool"},
        "mode": "progressive",
        "config": type("Config", (), {"max_loaded_tools": 6})(),
    })()
    raw = type("Raw", (), {
        "_orchestrator_registry": registry,
        "_orchestrator_tool_loader": loader,
        "_context_runtime": None,
    })()
    agent = FloodMindAgent.__new__(FloodMindAgent)
    agent._agent = raw
    agent._llm = type("LLM", (), {"provider": "openai", "model_name": "m", "base_url": "https://example.com"})()
    monkeypatch.setattr(FloodMindAgent, "_desktop_block", lambda self: {})

    result = agent.diagnostics()

    assert result["tools"] == {
        "mode": "progressive", "max_loaded": 6, "total": 2, "loaded": 1,
    }
    assert "items" not in result["tools"]
    assert "command" not in str(result)
    assert "MCP:demo" not in str(result)


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


def test_context_compress_becomes_context():
    # context_compress (legacy) + the *_start/*_done variants all forward as a
    # single context block so the fold bar can show the injection activity.
    assert translate_event({"type": "context_compress", "summary": "已压缩为 200 字",
                            "saved_tokens": 10, "original_messages": 5,
                            "compressed_messages": 2}) == \
        [{"type": "context", "label": "上下文压缩", "content": "已压缩为 200 字"}]
    assert translate_event({"type": "context_compress_done", "summary_preview": "概要"}) == \
        [{"type": "context", "label": "上下文压缩", "content": "概要"}]


def test_attachment_context_becomes_context():
    out = translate_event({"type": "attachment_context", "images": ["a.png", "b.png"]})
    assert out == [{"type": "context", "label": "上下文注入", "content": "附图片 2 张"}]


def test_llm_step_start_becomes_round_start():
    assert translate_event({"type": "llm_step_start", "iteration": 3,
                            "model": "test-model"}) == \
        [{"type": "round_start", "iteration": 3}]


def test_llm_step_end_becomes_finish():
    assert translate_event({"type": "llm_step_end", "finish_reason": "stop"}) == \
        [{"type": "finish", "reason": "stop"}]
    assert translate_event({"type": "llm_step_end", "finish_reason": "tool_calls"}) == \
        [{"type": "finish", "reason": "tool_calls"}]


def test_permission_ask_carries_session_id():
    # session_id is required to auto-respond via AskService.respond.
    out = translate_event({"type": "permission_ask", "ask_id": "a1", "session_id": "s1",
                           "call_id": "c1", "tool_name": "exit_plan_mode",
                           "reason": "submit plan", "tool_input": {}})
    assert out[0]["type"] == "permission"
    assert out[0]["session_id"] == "s1"
    assert out[0]["ask_id"] == "a1"


def test_mcp_call_health_tracks_outcome():
    # The SDK MCP pool records the most-recent tool-call outcome per server, so
    # the UI can flag a connected wrapper whose backend is actually down.
    from floodmind.agent.mcp_client import McpClientPool

    pool = McpClientPool()

    class DownConn:
        def call_tool(self, tool, args):
            # v2.0.0: health 依赖 result.is_error / 异常，不再按字符串关键词。
            return type("R", (), {"is_error": True, "error": "知识库服务无法连接"})()
        def list_tools(self):
            return []

    class UpConn:
        def call_tool(self, tool, args):
            return "正常的检索结果"
        def list_tools(self):
            return []

    pool._connections["hydro-rag"] = DownConn()
    pool.call_tool("mcp:hydro-rag:search", {})
    assert pool.call_health()["hydro-rag"]["ok"] is False
    assert "无法连接" in pool.call_health()["hydro-rag"]["error"]

    pool._connections["ok-svc"] = UpConn()
    pool.call_tool("mcp:ok-svc:query", {})
    assert pool.call_health()["ok-svc"]["ok"] is True


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


def test_mcp_persist_uses_sdk_connected_listener(tmp_path, monkeypatch):
    import importlib
    import json
    from floodmind.agent.mcp_client import get_mcp_client_pool
    from floodmind_desktop_sidecar import catalog_api

    monkeypatch.setattr(catalog_api, "_mcp_path", lambda: tmp_path / "mcp.json")
    pool = get_mcp_client_pool()
    before = list(getattr(pool, "_server_connected_listeners", []))
    importlib.reload(importlib.import_module("floodmind_desktop_sidecar.floodmind_agent"))
    after = list(getattr(pool, "_server_connected_listeners", []))
    listener = next(l for l in after if l not in before)

    listener({"name": "runtime-svc", "transport": "stdio", "command": "python"}, object())

    data = json.loads((tmp_path / "mcp.json").read_text(encoding="utf-8"))
    assert [s["name"] for s in data["servers"]] == ["runtime-svc"]


def test_file_generated_becomes_artifact():
    out = translate_event({"type": "file_generated", "filename": "r.xlsx", "download_url": "/x", "size": 10})
    assert out == [{"type": "artifact", "kind": "file", "name": "r.xlsx", "path": "/x", "size": 10}]


def test_file_generated_preserves_explicit_artifact_metadata():
    out = translate_event({
        "type": "file_generated",
        "filename": "r.xlsx",
        "download_url": "/x",
        "final": False,
        "exists": False,
        "source": "declared",
    })
    assert out == [{
        "type": "artifact",
        "kind": "file",
        "name": "r.xlsx",
        "path": "/x",
        "final": False,
        "exists": False,
        "source": "declared",
    }]


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


def test_resolve_llm_passes_provider_to_model_client(monkeypatch):
    """SDK v1.0.1 routes provider-specific pipelines from ModelClient.provider.

    The desktop resolves activeModel + activeProvider itself, so it must pass the
    resolved provider through when constructing ModelClient; otherwise DeepSeek /
    DashScope / Kimi / MiniMax requests fall back to generic OpenAI-compatible
    handling.
    """
    import importlib
    from floodmind.config.model_resolver import ResolvedModel
    from floodmind_desktop_sidecar.floodmind_agent import FloodMindAgent

    captured = {}

    class FakeMC:
        def __init__(self, **kw):
            captured.update(kw)

    rm = ResolvedModel(
        provider="deepseek",
        id="deepseek-reasoner",
        name="DeepSeek Reasoner",
        api_key="sk-ds",
        base_url="https://api.deepseek.com/v1",
        temperature=0.1,
        max_tokens=8192,
        context_window=65536,
        supports_reasoning=True,
        supports_vision=False,
    )

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

    a = FloodMindAgent.__new__(FloodMindAgent)
    monkeypatch.setattr(
        FloodMindAgent,
        "_desktop_block",
        lambda self: {"activeModel": "deepseek-reasoner", "activeProvider": "deepseek", "enableReasoning": True},
    )

    llm = a._resolve_llm()

    assert isinstance(llm, FakeMC)
    assert captured["provider"] == "deepseek"
    assert captured["model_name"] == "deepseek-reasoner"
    assert captured["enable_thinking"] is True
    assert a._resolved_context_window == 65536


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
    a._build_agent = lambda sid, pd, mode=None: ("AGENT", sid, pd)  # avoid real agent construction

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
    assert captured["provider"] == "openai"
    assert isinstance(a._llm, FakeMC)


def test_resolve_llm_defaults_reasoning_to_model_capability(monkeypatch):
    """无 enableReasoning 标志时，推理模型默认开启 thinking（v2.0.1 修复）。"""
    import importlib
    from floodmind.config.model_resolver import ResolvedModel
    from floodmind_desktop_sidecar.floodmind_agent import FloodMindAgent

    captured: dict = {}
    instances: list = []

    class FakeMC:
        def __init__(self, **kw):
            captured.update(kw)
            instances.append(self)

    # 推理模型，desktop 块无 enableReasoning → 默认开
    rm = ResolvedModel(
        provider="minimax", id="MiniMax-M3", name="MiniMax M3",
        api_key="sk", base_url="https://api.minimaxi.com/v1",
        temperature=0.3, max_tokens=8192, context_window=131072,
        supports_reasoning=True, supports_vision=False,
    )
    monkeypatch.setattr(
        importlib.import_module("floodmind.config.model_resolver"),
        "resolve_model", lambda model_key=None, provider_id=None: rm,
    )
    monkeypatch.setattr(
        importlib.import_module("floodmind.agent.native.model_client"),
        "ModelClient", FakeMC,
    )
    monkeypatch.setattr(
        importlib.import_module("floodmind.config.settings"),
        "reload_config", lambda: None,
    )
    monkeypatch.setattr(
        FloodMindAgent, "_desktop_block",
        lambda self: {"activeModel": "MiniMax-M3", "activeProvider": "minimax"},
    )

    a = FloodMindAgent.__new__(FloodMindAgent)
    a._agent = type("A", (), {"session_id": "s1"})()
    a._build_agent = lambda sid, pd, mode=None: ("AGENT", sid, pd)
    assert a.reload_model() is True
    assert captured["enable_thinking"] is True
    assert a._model_supports_reasoning is True
    # 壳：enable_reasoning 实例属性让 SDK _init_model_client 读到 thinking 开关。
    assert instances and getattr(instances[-1], "enable_reasoning", False) is True

    # 非推理模型 → 默认关
    rm2 = ResolvedModel(
        provider="openai", id="plain", name="Plain",
        api_key="sk", base_url="https://x/v1",
        temperature=0.3, max_tokens=8192, context_window=32768,
        supports_reasoning=False, supports_vision=False,
    )
    monkeypatch.setattr(
        importlib.import_module("floodmind.config.model_resolver"),
        "resolve_model", lambda model_key=None, provider_id=None: rm2,
    )
    captured.clear()
    a2 = FloodMindAgent.__new__(FloodMindAgent)
    a2._agent = type("A", (), {"session_id": "s2"})()
    a2._build_agent = lambda sid, pd, mode=None: ("AGENT", sid, pd)
    assert a2.reload_model() is True
    assert captured["enable_thinking"] is False
    assert a2._model_supports_reasoning is False


def test_build_agent_uses_public_agent_full_runtime(monkeypatch, tmp_path):
    import importlib
    from floodmind_desktop_sidecar.floodmind_agent import FloodMindAgent
    import floodmind_desktop_sidecar.floodmind_agent as fagent

    captured = {}

    class FakeMemory:
        def __init__(self, **kw):
            captured["memory_kwargs"] = kw

    class FakeRaw:
        def __init__(self, memory, session_id):
            self.memory = memory
            self.session_id = session_id
            self._orchestrator_registry = type("R", (), {"all": lambda self: []})()
            self._specialist_registry = type("R", (), {"all": lambda self: []})()

    class FakePublicAgent:
        def __init__(self, **kw):
            captured["agent_kwargs"] = kw
            self.raw = FakeRaw(kw["memory"], kw["session_id"])

    monkeypatch.setattr(importlib.import_module("floodmind.memory.dual_memory"), "DualMemory", FakeMemory)
    monkeypatch.setattr(importlib.import_module("floodmind.agent"), "Agent", FakePublicAgent, raising=False)

    workspace = type("WS", (), {"workspace_dir": tmp_path})()
    a = FloodMindAgent.__new__(FloodMindAgent)
    a._llm = "LLM"
    a._resolved_context_window = 1234
    a._permission_handler = object()
    a._desktop_block = lambda: {"enableReasoning": True, "enableSearch": True}

    agent = a._build_agent("sid-1", str(tmp_path / "mem"), workspace=workspace)

    assert isinstance(agent, FakePublicAgent)
    assert captured["memory_kwargs"]["session_id"] == "sid-1"
    assert captured["memory_kwargs"]["persist_dir"] == str(tmp_path / "mem")
    assert captured["memory_kwargs"]["llm"] == "LLM"
    assert captured["memory_kwargs"]["context_window"] == 1234
    kwargs = captured["agent_kwargs"]
    assert kwargs["llm"] == "LLM"
    assert kwargs["memory"] is agent.raw.memory
    assert kwargs["session_id"] == "sid-1"
    assert kwargs["permission_handler"] is a._permission_handler
    assert kwargs["max_iterations"] == 50
    assert kwargs["enable_reasoning"] is True
    assert kwargs["enable_search"] is True
    assert kwargs["workspace"] is workspace
    assert kwargs["bare"] is False
    assert kwargs["permission_decision_hook"] is fagent._permission_decision_hook
    assert str(tmp_path) in kwargs["system_prompt"]


def test_build_agent_raises_if_public_agent_drops_memory(monkeypatch, tmp_path):
    import importlib
    import pytest

    from floodmind_desktop_sidecar.floodmind_agent import FloodMindAgent

    captured = {}

    class FakeMemory:
        pass

    class MisbehavingPublicAgent:
        def __init__(self, **kw):
            captured["agent_kwargs"] = kw
            # raw does NOT expose the desktop memory/session_id → invariant fails
            self.raw = type("R", (), {"memory": None, "session_id": None})()

    monkeypatch.setattr(importlib.import_module("floodmind.memory.dual_memory"), "DualMemory", lambda **_kw: FakeMemory())
    monkeypatch.setattr(importlib.import_module("floodmind.agent"), "Agent", MisbehavingPublicAgent, raising=False)

    workspace = type("WS", (), {"workspace_dir": tmp_path})()
    a = FloodMindAgent.__new__(FloodMindAgent)
    a._llm = "LLM"
    a._resolved_context_window = 1000
    a._permission_handler = object()
    a._desktop_block = lambda: {}

    with pytest.raises(RuntimeError):
        a._build_agent("sid-2", str(tmp_path / "mem"), workspace=workspace)
    assert captured["agent_kwargs"]["permission_decision_hook"] is not None


def test_build_agent_mode_ask_uses_bare_no_tools(monkeypatch, tmp_path):
    import importlib
    from floodmind_desktop_sidecar.floodmind_agent import FloodMindAgent

    captured = {}

    class FakeMemory:
        pass

    class FakeRaw:
        def __init__(self, memory, session_id):
            self.memory = memory
            self.session_id = session_id

    class FakePublicAgent:
        def __init__(self, **kw):
            captured["agent_kwargs"] = kw
            self.raw = FakeRaw(kw["memory"], kw["session_id"])

    monkeypatch.setattr(importlib.import_module("floodmind.memory.dual_memory"), "DualMemory", lambda **_kw: FakeMemory())
    monkeypatch.setattr(importlib.import_module("floodmind.agent"), "Agent", FakePublicAgent, raising=False)

    workspace = type("WS", (), {"workspace_dir": tmp_path})()
    a = FloodMindAgent.__new__(FloodMindAgent)
    a._llm = "LLM"
    a._resolved_context_window = 1234
    a._permission_handler = object()
    a._desktop_block = lambda: {}

    agent = a._build_agent("sid-1", str(tmp_path / "mem"), workspace=workspace, mode="ask")
    kwargs = captured["agent_kwargs"]
    assert isinstance(agent, FakePublicAgent)
    assert kwargs["bare"] is True
    assert kwargs["tools"] == []
    assert "问答" in kwargs["system_prompt"]
    assert str(tmp_path) in kwargs["system_prompt"]


def test_build_agent_mode_plan_uses_full_runtime(monkeypatch, tmp_path):
    """Plan mode runs the full runtime so the model can call create_plan."""
    import importlib
    from floodmind_desktop_sidecar.floodmind_agent import FloodMindAgent

    captured = {}

    class FakeMemory:
        pass

    class FakeRaw:
        def __init__(self, memory, session_id):
            self.memory = memory
            self.session_id = session_id

    class FakePublicAgent:
        def __init__(self, **kw):
            captured["agent_kwargs"] = kw
            self.raw = FakeRaw(kw["memory"], kw["session_id"])

    monkeypatch.setattr(importlib.import_module("floodmind.memory.dual_memory"), "DualMemory", lambda **_kw: FakeMemory())
    monkeypatch.setattr(importlib.import_module("floodmind.agent"), "Agent", FakePublicAgent, raising=False)

    workspace = type("WS", (), {"workspace_dir": tmp_path})()
    a = FloodMindAgent.__new__(FloodMindAgent)
    a._llm = "LLM"
    a._resolved_context_window = 1234
    a._permission_handler = object()
    a._desktop_block = lambda: {}

    a._build_agent("sid-1", str(tmp_path / "mem"), workspace=workspace, mode="plan")
    kwargs = captured["agent_kwargs"]
    assert kwargs["bare"] is False
    assert kwargs["tools"] is None
    assert "计划" in kwargs["system_prompt"]
    assert "create_plan" in kwargs["system_prompt"]


def test_stream_rebuilds_agent_on_mode_change(tmp_path, monkeypatch):
    import threading
    from floodmind_desktop_sidecar.floodmind_agent import FloodMindAgent

    built: list[str] = []

    class FakeAgent:
        def __init__(self, sid="sid-1"):
            self.session_id = sid
            self.memory = object()

        def stream(self, _msg, **_kw):
            yield {"type": "answer_delta", "content": "hi"}

    def _fake_build(sid, persist_dir, workspace=None, mode="craft"):
        built.append(mode)
        return FakeAgent(sid)

    monkeypatch.chdir(tmp_path)
    a = FloodMindAgent.__new__(FloodMindAgent)
    a._stream_lock = threading.Lock()
    a._abort = threading.Event()
    a._agent = FakeAgent("sid-1")
    a._agent_mode = "craft"
    a._build_agent = _fake_build
    a._memory_target = lambda sid: (sid, "/tmp/mem")
    a._set_workspace = lambda: None
    a._snapshot_outputs = lambda: {}
    a._artifact_events_from_agent = lambda _a: []
    a._diff_outputs = lambda _b: []

    # ask mode differs from current (craft) → rebuild to ask.
    events = list(a.stream([{"role": "user", "content": "x"}], mode="ask"))
    assert built == ["ask"]
    assert a._agent_mode == "ask"
    assert a._agent.session_id == "sid-1"
    assert events[-1]["type"] == "done"

    # Same mode again → no rebuild.
    list(a.stream([{"role": "user", "content": "x"}], mode="ask"))
    assert built == ["ask"]

    # Back to craft → rebuild again.
    list(a.stream([{"role": "user", "content": "x"}], mode="craft"))
    assert built == ["ask", "craft"]
    assert a._agent_mode == "craft"


def test_permission_decision_hook_upgrades_allowed_to_ask():
    from floodmind_desktop_sidecar.floodmind_agent import _permission_decision_hook
    from floodmind.agent.runtime.contracts.permissions import (
        PermissionBehavior,
        PermissionDecision,
        ToolPermissionPolicy,
    )

    decision = PermissionDecision(behavior=PermissionBehavior.ALLOW, reason="ok")
    result = _permission_decision_hook("WriteFile", {}, decision, ToolPermissionPolicy(policy_type="write"))

    assert result.behavior == PermissionBehavior.ASK


def test_artifact_events_from_sdk_agent_artifacts(tmp_path):
    from floodmind_desktop_sidecar.floodmind_agent import FloodMindAgent

    report = tmp_path / "sdk-report.xlsx"
    report.write_bytes(b"data")

    class FakeAgent:
        artifacts = [{"kind": "file", "name": "SDK 报告", "path": str(report), "source": "sdk"}]

    a = FloodMindAgent.__new__(FloodMindAgent)
    events = list(a._artifact_events_from_agent(FakeAgent()))

    assert events == [{
        "type": "artifact",
        "kind": "file",
        "name": "SDK 报告",
        "path": os.path.abspath(os.path.normpath(str(report))),
        "final": True,
        "exists": True,
        "source": "sdk",
        "size": 4,
    }]


def test_set_workspace_uses_sdk_folder_first_workspace(tmp_path, monkeypatch):
    from floodmind_desktop_sidecar.floodmind_agent import FloodMindAgent
    import floodmind.tools as tools

    opened = tmp_path / "业务工作区"
    opened.mkdir()

    class FakeAgent:
        def __init__(self):
            self.workspace = None

        def bind_workspace(self, ws):
            self.workspace = ws

    captured_ctx = {}
    monkeypatch.setattr(
        tools,
        "set_session_context",
        lambda sid, **kw: captured_ctx.update({"sid": sid, **kw}),
    )

    a = FloodMindAgent.__new__(FloodMindAgent)
    a._agent = FakeAgent()
    a._workspace_manager = type("W", (), {"current_path": lambda self: str(opened)})()

    a._set_workspace()

    ws = a._agent.workspace
    assert ws is not None
    assert ws.is_folder_first is True
    assert ws.workspace_dir == opened.resolve()
    assert ws.state_dir == opened.resolve() / ".floodmind"
    assert ws.artifact_dir == opened.resolve() / ".floodmind" / "artifacts" / captured_ctx["sid"]
    assert captured_ctx["output_dir"] == str(opened.resolve())
    assert captured_ctx["workspace_dir"] == str(opened.resolve())
    assert captured_ctx["artifact_dir"] == str(ws.artifact_dir)
    assert a._output_dir == str(opened.resolve())


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
    assert all(os.path.isabs(art["path"]) for art in arts)
    assert all(art["path"].endswith(art["name"]) for art in arts)
    assert all(art["final"] is True for art in arts)
    assert all(art["exists"] is True for art in arts)
    assert all(art["source"] == "fallback" for art in arts)
    sizes = {art["name"]: art["size"] for art in arts}
    assert sizes == {"plot.png": 3, "report.xlsx": 3}


def test_diff_outputs_recurses_files_without_emitting_directories(tmp_path):
    from floodmind_desktop_sidecar.floodmind_agent import FloodMindAgent

    out = tmp_path / "outputs"
    existing_dir = out / "existing"
    existing_dir.mkdir(parents=True)
    (existing_dir / "before.txt").write_text("old", encoding="utf-8")

    a = FloodMindAgent.__new__(FloodMindAgent)
    a._output_dir = str(out)
    before = a._snapshot_outputs()

    (out / "top.txt").write_text("top", encoding="utf-8")
    (existing_dir / "nested.txt").write_text("nested", encoding="utf-8")
    new_dir = out / "new-dir"
    new_dir.mkdir()
    (new_dir / "chart.png").write_bytes(b"img")

    artifacts = list(a._diff_outputs(before))

    assert [art["name"] for art in artifacts] == ["nested.txt", "chart.png", "top.txt"]
    assert [os.path.relpath(art["path"], out) for art in artifacts] == [
        os.path.join("existing", "nested.txt"),
        os.path.join("new-dir", "chart.png"),
        "top.txt",
    ]
    assert all(os.path.isabs(art["path"]) for art in artifacts)
    assert all(art["exists"] is True for art in artifacts)
    assert all(art["source"] == "fallback" for art in artifacts)
    assert all(art["name"] not in {"existing", "new-dir"} for art in artifacts)


def test_diff_outputs_ignores_hidden_sdk_managed_dirs(tmp_path):
    """`.floodmind/` (sessions/checkpoints/memory) churns on every run and must
    never surface as artifacts."""
    from floodmind_desktop_sidecar.floodmind_agent import FloodMindAgent

    out = tmp_path / "ws"
    out.mkdir()
    (out / "user.txt").write_text("user", encoding="utf-8")
    hidden = out / ".floodmind" / "sessions" / "s1" / "checkpoints" / "ckpt-1"
    hidden.mkdir(parents=True)
    (hidden / "manifest.json").write_text("{}", encoding="utf-8")
    (hidden / "state.json").write_text("{}", encoding="utf-8")

    a = FloodMindAgent.__new__(FloodMindAgent)
    a._output_dir = str(out)
    before = a._snapshot_outputs()
    assert before == {"user.txt": before["user.txt"]}

    # A run adds a user-visible output AND writes more checkpoint churn.
    (out / "report.xlsx").write_bytes(b"new")
    (hidden / "manifest.json").write_text('{"x":1}', encoding="utf-8")
    mem = out / ".floodmind" / "sessions" / "s1" / "memory"
    mem.mkdir(parents=True)
    (mem / "turns.json").write_text("[]", encoding="utf-8")

    artifacts = list(a._diff_outputs(before))
    assert [art["name"] for art in artifacts] == ["report.xlsx"]



def test_build_artifact_event_preserves_missing_declared_path(tmp_path):
    from floodmind_desktop_sidecar.floodmind_agent import _build_artifact_event

    missing = tmp_path / "missing.xlsx"
    event = _build_artifact_event(str(missing), source="declared")

    assert event["type"] == "artifact"
    assert event["kind"] == "file"
    assert event["name"] == "missing.xlsx"
    assert event["path"] == os.path.abspath(os.path.normpath(str(missing)))
    assert event["final"] is True
    assert event["exists"] is False
    assert event["source"] == "declared"
    assert "size" not in event


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


def test_stream_prefers_sdk_artifacts_and_dedupes_diff(tmp_path, monkeypatch):
    from floodmind_desktop_sidecar.floodmind_agent import FloodMindAgent

    out = tmp_path / "out"
    out.mkdir()
    report = out / "report.xlsx"

    class FakeAgent:
        @property
        def artifacts(self):
            return [{"kind": "file", "name": "report.xlsx", "path": str(report), "source": "sdk"}]

        def stream(self, _msg):
            report.write_bytes(b"new")
            yield {"type": "answer_delta", "content": "done"}

    a = FloodMindAgent.__new__(FloodMindAgent)
    a._agent = FakeAgent()
    a._workspace_manager = None
    monkeypatch.setattr(a, "_set_workspace", lambda: setattr(a, "_output_dir", str(out)))

    events = list(a.stream([{"role": "user", "content": "hi"}]))
    artifacts = [e for e in events if e.get("type") == "artifact"]

    assert len(artifacts) == 1
    assert artifacts[0]["name"] == "report.xlsx"
    assert artifacts[0]["source"] == "sdk"
    assert events[-1]["type"] == "done"


    # _memory_target uses _app_data_dir() == cwd.
    monkeypatch.chdir(tmp_path)
    from floodmind_desktop_sidecar.floodmind_agent import FloodMindAgent

    built = []
    a = FloodMindAgent.__new__(FloodMindAgent)
    a._build_agent = lambda sid, pd, mode=None: built.append((sid, pd)) or ("AGENT", sid, pd)

    a.activate_conversation("sess-xyz")

    assert built == [("sess-xyz", str(tmp_path / "sess-xyz" / "memory"))]
    assert a._agent == ("AGENT", "sess-xyz", str(tmp_path / "sess-xyz" / "memory"))


def test_activate_conversation_swallows_errors(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    from floodmind_desktop_sidecar.floodmind_agent import FloodMindAgent

    a = FloodMindAgent.__new__(FloodMindAgent)
    a._agent = "ORIGINAL"
    a._build_agent = lambda sid, pd, mode=None: (_ for _ in ()).throw(RuntimeError("nope"))

    a.activate_conversation("sess-1")     # must not raise
    assert a._agent == "ORIGINAL"         # left untouched on failure


def test_generate_title_invokes_llm_and_cleans_output(monkeypatch):
    import importlib
    from floodmind_desktop_sidecar.floodmind_agent import FloodMindAgent

    class FakeResult:
        content = "  1. 帮我画个销售折线图\nignore me"

    class FakeRM:
        provider = "openai"
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
    assert FakeMC.last_kwargs["provider"] == "openai"
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
        provider = "openai"
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
    assert captured["client_kwargs"]["provider"] == "openai"


def test_generate_title_returns_empty_on_failure(monkeypatch):
    import importlib
    from floodmind_desktop_sidecar.floodmind_agent import FloodMindAgent

    class FakeRM:
        provider = "test-provider"
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


def test_set_workspace_for_uses_sdk_folder_first_workspace(tmp_path, monkeypatch):
    from floodmind_desktop_sidecar.floodmind_agent import FloodMindAgent
    import floodmind.tools as tools

    opened = tmp_path / "后台工作区"
    opened.mkdir()
    captured_ctx = {}
    monkeypatch.setattr(
        tools,
        "set_session_context",
        lambda sid, **kw: captured_ctx.update({"sid": sid, **kw}),
    )

    a = FloodMindAgent.__new__(FloodMindAgent)
    ws = a._set_workspace_for(str(opened))

    assert ws is not None
    assert ws.is_folder_first is True
    assert ws.workspace_dir == opened.resolve()
    assert captured_ctx["output_dir"] == str(opened.resolve())
    assert captured_ctx["workspace_dir"] == str(opened.resolve())
    assert captured_ctx["artifact_dir"] == str(ws.artifact_dir)


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
    a._build_agent = lambda sid, pd, workspace=None, mode=None: FakeAgent()
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
    a._build_agent = lambda sid, pd, workspace=None, mode=None: BoomAgent()
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
    a._build_agent = lambda sid, pd, workspace=None, mode=None: FakeAgent()
    import types
    a._set_workspace_for = lambda path: types.SimpleNamespace(user_dir=str(out))

    events, artifacts, final_text = a.run_headless("sess-x", "/ws/A", "go")
    assert a._agent == "FOREGROUND_AGENT"
    names = {(art["kind"], art["name"]) for art in artifacts}
    assert ("file", "report.xlsx") in names
    assert ("image", "chart.png") in names
    assert all(art["final"] is True for art in artifacts)
    assert all(art["exists"] is True for art in artifacts)
    assert all(art["source"] == "fallback" for art in artifacts)
    assert {art["name"]: art["size"] for art in artifacts} == {
        "chart.png": 3,
        "report.xlsx": 4,
    }
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
    a._build_agent = lambda sid, pd, workspace=None, mode=None: FakeAgent()
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
    a._build_agent = lambda sid, persist_dir, workspace=None, mode=None: built.append(sid) or types.SimpleNamespace(session_id=sid)
    rebinds = []
    a._set_workspace = lambda: rebinds.append(True)

    assert a.reload_persona() is True
    assert built == ["sid-1"]          # rebuilt with the SAME session_id
    assert rebinds == [True]           # workspace/session context re-bound for the fresh agent
    assert a._agent.session_id == "sid-1"


def test_permission_decision_hook_respects_policy_and_deny():
    from floodmind_desktop_sidecar.floodmind_agent import _permission_decision_hook
    from floodmind.agent.runtime.contracts.permissions import (
        PermissionBehavior,
        PermissionDecision,
        ToolPermissionPolicy,
    )

    allow = PermissionDecision(behavior=PermissionBehavior.ALLOW, reason="ok")

    # non-readonly policies → upgraded to ASK
    for ptype in ("exec", "write", "read_path", "network"):
        d = _permission_decision_hook("T", {}, allow, ToolPermissionPolicy(policy_type=ptype))
        assert d.behavior == PermissionBehavior.ASK, ptype

    # readonly/internal/ask policies → pass through unchanged
    for ptype in ("readonly", "internal", "ask"):
        d = _permission_decision_hook("T", {}, allow, ToolPermissionPolicy(policy_type=ptype))
        assert d is allow, ptype

    # SDK DENY is preserved (hook can only tighten, never loosen)
    deny = PermissionDecision(behavior=PermissionBehavior.DENY, reason="danger")
    d = _permission_decision_hook("Bash", {}, deny, ToolPermissionPolicy(policy_type="exec"))
    assert d is deny


def test_permission_decision_hook_denies_execution_in_ask_plan_mode():
    """Ask: every tool denied. Plan: readonly/internal allowed (create_plan +
    file reads), all execution tools denied."""
    from floodmind_desktop_sidecar import floodmind_agent as fa
    from floodmind.agent.runtime.contracts.permissions import (
        PermissionBehavior,
        PermissionDecision,
        ToolPermissionPolicy,
    )

    allow = PermissionDecision(behavior=PermissionBehavior.ALLOW, reason="ok")

    # Ask: nothing may run.
    fa._CURRENT_MODE["mode"] = "ask"
    for ptype in ("readonly", "exec", "write", "network", "ask", "internal"):
        d = fa._permission_decision_hook("SearchTools", {}, allow, ToolPermissionPolicy(policy_type=ptype))
        assert d.behavior == PermissionBehavior.DENY, ptype

    # Plan: plan tools + reads pass through, execution denied.
    fa._CURRENT_MODE["mode"] = "plan"
    for ptype in ("readonly", "internal"):
        d = fa._permission_decision_hook("create_plan", {}, allow, ToolPermissionPolicy(policy_type=ptype))
        assert d is allow, ptype
    for ptype in ("exec", "write", "network", "ask", "state_write"):
        d = fa._permission_decision_hook("Bash", {}, allow, ToolPermissionPolicy(policy_type=ptype))
        assert d.behavior == PermissionBehavior.DENY, ptype

    # Restore craft so other tests see the default path.
    fa._CURRENT_MODE["mode"] = "craft"


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


def test_mcp_stdio_liveness_uses_process_state():
    from floodmind.agent.mcp_client import McpClientConnection

    class Proc:
        def __init__(self, result):
            self._result = result

        def poll(self):
            return self._result

    conn = McpClientConnection("svc", transport="stdio")
    conn._initialized = True
    conn._process = Proc(None)
    assert conn.is_connected is True

    conn._process = Proc(1)
    assert conn.is_connected is False

    conn._initialized = False
    conn._process = Proc(None)
    assert conn.is_connected is False


def test_mcp_tool_names_sanitized_for_openai_endpoints():
    """MCP tool names are namespaced with ':' which OpenAI-compatible endpoints reject.

    The SDK build_mcp_tool_specs exposes sanitized model-visible names while the
    bound function keeps the original 'mcp:server:tool' call signature.
    """
    import re
    from floodmind.agent.mcp_client import build_mcp_tool_specs

    class FakeConn:
        transport = "stdio"  # v2.0.0: build_mcp_tool_specs 读 conn.transport
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


def test_public_agent_full_runtime_and_compatibility_proxies(monkeypatch):
    import importlib
    from floodmind.agent.api import Agent

    captured = {}

    class FakeNative:
        def __init__(self, **kw):
            captured["native_kwargs"] = kw
            self.memory = kw["memory"]
            self.session_id = kw["session_id"]
            self._orchestrator_registry = type("R", (), {"all": lambda self: []})()
            self.cleared = False
            self.stream_kwargs = None

        def bind_workspace(self, ws):
            self.workspace = ws

        def clear_memory(self):
            self.cleared = True

        def stream(self, message, **kw):
            self.stream_kwargs = {"message": message, **kw}
            yield {"type": "token_usage", "prompt_tokens": 1, "completion_tokens": 2, "total_tokens": 3}
            yield {"type": "file_generated", "filename": "x.txt", "download_url": "/x"}
            yield {"type": "final_text", "content": "done"}

    monkeypatch.setattr(importlib.import_module("floodmind.agent.api"), "NativeFloodAgent", FakeNative)

    memory = object()
    workspace = object()
    agent = Agent(
        llm="LLM",
        memory=memory,
        session_id="sid-public",
        workspace=workspace,
        permission_handler="perm",
        max_iterations=7,
        bare=False,
    )

    assert captured["native_kwargs"]["bare"] is False
    assert captured["native_kwargs"]["llm_service"] == "LLM"
    assert captured["native_kwargs"]["memory"] is memory
    assert captured["native_kwargs"]["session_id"] == "sid-public"
    assert captured["native_kwargs"]["workspace"] is workspace
    assert captured["native_kwargs"]["permission_handler"] == "perm"
    assert captured["native_kwargs"]["max_iterations"] == 7
    assert captured["native_kwargs"]["tools"] is None
    assert agent.memory is memory
    assert agent.session_id == "sid-public"

    events = list(agent.stream("hi", abort_check="abort", attachments=["att"]))
    assert events[-1]["content"] == "done"
    assert agent.raw.stream_kwargs == {"message": "hi", "abort_check": "abort", "attachments": ["att"]}
    assert agent.last_usage == {"prompt_tokens": 1, "completion_tokens": 2, "total_tokens": 3}
    assert agent.artifacts == [{"type": "file_generated", "filename": "x.txt", "download_url": "/x"}]
    agent.clear_memory()
    assert agent.raw.cleared is True

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


def test_stream_waits_after_pause_for_lock_to_free(tmp_path, monkeypatch):
    """After a pause (abort raised) the previous run may still hold the lock
    while its SDK run unwinds to the next boundary — a new request must WAIT
    for the lock instead of failing with 已有任务正在执行."""
    import time

    monkeypatch.chdir(tmp_path)

    class BlockingAgent:
        def stream(self, _msg, **_kw):
            yield {"type": "answer_delta", "content": "x"}
            release.wait(timeout=5)
            yield {"type": "answer_delta", "content": "y"}

    release = threading.Event()
    a = _concurrent_agent()
    a._agent = BlockingAgent()

    out1: list = []
    t1 = threading.Thread(target=lambda: out1.extend(a.stream([{"role": "user", "content": "hi"}])))
    t1.start()
    time.sleep(0.05)  # run1 holds the stream lock
    a._abort.set()    # simulate the user pausing run1 mid-stream

    out2: list = []
    t2 = threading.Thread(target=lambda: out2.extend(a.stream([{"role": "user", "content": "resume"}])))
    t2.start()
    time.sleep(0.3)  # let run2 reach the lock-wait loop
    assert out2 == [], "post-pause resume should wait for the lock, not fail fast"

    release.set()
    t1.join(timeout=2)
    t2.join(timeout=3)
    assert out2 and out2[-1]["type"] == "done"
    assert all(e.get("type") != "error" for e in out2)


def _wait_lock_free(a, timeout: float = 3.0) -> None:
    """Wait for the detached run thread to release _stream_lock on completion."""
    import time

    deadline = time.time() + timeout
    while a._stream_lock.locked() and time.time() < deadline:
        time.sleep(0.05)
    assert not a._stream_lock.locked()


def test_stream_releases_lock_and_allows_followup(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)

    class DoneAgent:
        def stream(self, _msg, **_kw):
            yield {"type": "answer_delta", "content": "ok"}

    a = _concurrent_agent()
    a._agent = DoneAgent()

    out = list(a.stream([{"role": "user", "content": "hi"}]))
    assert out[-1]["type"] == "done"
    _wait_lock_free(a)  # lock released by the run thread on completion
    # Follow-up run works because the lock was released.
    out2 = list(a.stream([{"role": "user", "content": "again"}]))
    assert out2[-1]["type"] == "done"
    _wait_lock_free(a)


def test_stream_keeps_running_and_releases_on_disconnect(tmp_path, monkeypatch):
    """重连对账：客户端断连不再 abort——run 后台继续、事件缓冲，完成后释放锁。"""
    monkeypatch.chdir(tmp_path)

    class LongAgent:
        def stream(self, _msg, **_kw):
            for i in range(5):
                yield {"type": "answer_delta", "content": str(i)}

    a = _concurrent_agent()
    a._agent = LongAgent()

    g = a.stream([{"role": "user", "content": "hi"}])
    next(g)                                   # consume one event; generator suspended
    g.close()                                 # simulate client disconnect (GeneratorExit)
    assert not a._abort.is_set()              # 不再 abort：run 继续缓冲
    _wait_lock_free(a)                        # 锁由 run 线程在完成后释放
    # 断连期间 run 仍跑完并缓冲全部事件 → 可经游标补拉。
    events, done = a.run_events_since(0)
    assert done is True
    assert [e["type"] for e in events] == ["text"] * 5 + ["done"]


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


def test_list_checkpoints_empty_for_missing_dir(tmp_path, monkeypatch):
    """A non-existent session/checkpoint dir must yield [] (never raise)."""
    monkeypatch.chdir(tmp_path)
    from floodmind_desktop_sidecar.floodmind_agent import FloodMindAgent

    a = FloodMindAgent.__new__(FloodMindAgent)
    assert a.list_checkpoints("session-missing", str(tmp_path)) == []


def test_skill_frontmatter_helpers(tmp_path):
    """_read_skill_frontmatter + _set_skill_status parse/rewrite SKILL.md."""
    from floodmind_desktop_sidecar.floodmind_agent import (
        _read_skill_frontmatter,
        _set_skill_status,
    )

    md = tmp_path / "SKILL.md"
    md.write_text(
        "---\nname: hydrology-forecast\ndescription: 水文预报\nstatus: draft\n"
        "source: auto-generated-from-experience\ntrigger_keywords: []\n---\n\n# 内容\n",
        encoding="utf-8",
    )

    fm = _read_skill_frontmatter(md)
    assert fm["status"] == "draft"
    assert fm["source"] == "auto-generated-from-experience"

    updated = _set_skill_status(md.read_text(encoding="utf-8"), "active")
    assert "status: active" in updated
    assert "status: draft" not in updated

    # No status line → unchanged (can't approve).
    plain = "---\nname: x\n---\nbody\n"
    assert _set_skill_status(plain, "active") == plain


def test_snapshot_skips_intermediate_scripts_and_cache_dirs(tmp_path):
    """中间脚本(.py/.sh/.tmp)与 __pycache__ 不是最终产物，产物 diff 必须排除。"""
    from floodmind_desktop_sidecar.floodmind_agent import FloodMindAgent

    out = tmp_path / "ws"
    out.mkdir()
    (out / "report.docx").write_text("final", encoding="utf-8")
    (out / "chart.png").write_bytes(b"img")
    (out / "task").mkdir()
    (out / "task" / "script.py").write_text("print(1)", encoding="utf-8")
    (out / "task" / "helper.sh").write_text("ls", encoding="utf-8")
    (out / "task" / "notes.tmp").write_text("tmp", encoding="utf-8")
    cache = out / "task" / "__pycache__"
    cache.mkdir()
    (cache / "script.cpython-313.pyc").write_bytes(b"\x00")

    a = FloodMindAgent.__new__(FloodMindAgent)
    a._output_dir = str(out)
    snap = a._snapshot_outputs()

    # 最终成品保留；脚本/临时/缓存一律排除。
    assert "report.docx" in snap
    assert "chart.png" in snap
    assert all(not rel.endswith((".py", ".sh", ".tmp", ".pyc")) for rel in snap)
