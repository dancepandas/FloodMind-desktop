"""Adapter wrapping the real FloodMind SDK Agent behind our sidecar Agent seam.

Bridges the SDK's streamed events to the sidecar's flat NDJSON schema and adds
three desktop-specific behaviours the SDK stream alone does not provide:

* **Memory** — the SDK runs stateless when `memory=None` (graceful `hasattr`
  guards mean single-turn works but multi-turn history is silently lost). We
  build a `DualMemory` so conversation history persists, and rebind it per
  workspace so each folder gets isolated memory.
* **Artifacts** — `file_generated`/`image_generated` are emitted by the SDK
  *after* its stream loop has broken (`native_flood_agent.py` ~2458), so they
  never reach a stream consumer. We snapshot the workspace output dir before
  the run and diff it after, yielding our own `artifact` events for every new
  file — the desktop-native way (and exactly how the SDK's own
  `ArtifactWatcher` reasons about it).
* **Permission** — `exit_plan_mode` / `UpdateProjectInstructions` carry an ASK
  policy; our synchronous `permission_handler` returning True does NOT cover
  ASK-policy tools, so the executor would busy-wait up to 300 s for a user
  response we never send. We auto-respond via `AskService.respond` the moment
  a `permission_ask` event appears, keeping the desktop non-blocking.
"""
from __future__ import annotations

import contextlib
import os
import sys
import threading
from typing import Iterator

from .agent import Message
from .permissions import (
    PENDING_ASKS,
    PermissionCache,
    PermissionMode,
    permission_fingerprint,
)

# The SDK's ToolExecutionService runs tool functions in a ThreadPoolExecutor but
# does not copy contextvars into the worker thread. On the desktop we rely on
# SESSION_CONTEXT (output_dir/session_id) and the workspace contextvar being
# visible inside tools; without this patch the agent falls back to
# data/sessions/<id>/outputs instead of the user's workspace. Monkey-patch the
# executor class so every submit carries the caller's contextvars into the worker.
import concurrent.futures
import contextvars


class _ContextAwareThreadPoolExecutor(concurrent.futures.ThreadPoolExecutor):
    def submit(self, fn, /, *args, **kwargs):
        ctx = contextvars.copy_context()
        return super().submit(ctx.run, fn, *args, **kwargs)


concurrent.futures.ThreadPoolExecutor = _ContextAwareThreadPoolExecutor


# OpenAI-compatible endpoints (and several vLLM/one-api deployments) require tool
# names to match ^[a-zA-Z0-9_-]+$. The SDK namespaces MCP tools as
# "mcp:server_name:tool_name", which contains colons. We keep the internal
# "mcp:server:tool" call signature unchanged (the bound function still calls the
# pool with the original full name) but sanitize the model-visible ToolSpec.name.
def _patch_mcp_tool_names():
    import re
    try:
        from floodmind.agent import mcp_client
    except Exception:
        return

    _orig_build = mcp_client.build_mcp_tool_specs
    _valid_name = re.compile(r"^[a-zA-Z0-9_-]+$")

    def _build(conn, server_name, call_tool_fn):
        specs = _orig_build(conn, server_name, call_tool_fn)
        for spec in specs:
            if not _valid_name.match(spec.name):
                spec.name = re.sub(r"[^a-zA-Z0-9_-]+", "_", spec.name)
        return specs

    mcp_client.build_mcp_tool_specs = _build


_patch_mcp_tool_names()


# The SDK's model_presets.get_default_model_key() returns the catalog's FIRST
# model and deliberately ignores any persisted model selection. NativeFloodAgent
# injects that value into the system prompt before EVERY LLM call ("当前模型: X"),
# so after the user switches models in the GUI the model misreports itself as the
# catalog-first entry (e.g. deepseek-v4-pro) even though the desktop's ModelClient
# is already routing the request to the selected model (routing goes through
# FloodMindAgent._resolve_llm, which DOES honor desktop.activeModel). Patch the
# default-key resolver to prefer desktop.activeModel so the prompt — and thus the
# model's self-report — matches the model that actually answers. Idempotent.
def _patch_default_model_resolution():
    try:
        from floodmind.config import model_presets
    except Exception:
        return
    if getattr(model_presets.get_default_model_key, "_desktop_patched", False):
        return
    _orig = model_presets.get_default_model_key

    def _patched():
        try:
            from .config_api import _load_raw_settings

            desktop = _load_raw_settings().get("desktop")
            if isinstance(desktop, dict) and desktop.get("activeModel"):
                return str(desktop["activeModel"])
        except Exception:
            pass
        return _orig()

    _patched._desktop_patched = True
    model_presets.get_default_model_key = _patched


_patch_default_model_resolution()


def _patch_mcp_liveness():
    """Make MCP 'connected' status truthful.

    The SDK's ``McpClientConnection.is_connected`` is a static ``_initialized``
    flag — it stays True forever after a successful connect, even after a stdio
    subprocess has died (``process.poll()`` non-None) or the server is gone. So
    the desktop showed a green "已连接" dot for servers that were actually down.
    For stdio we check the subprocess is still alive; SSE has no cheap probe so
    we keep ``_initialized`` (best-effort).
    """
    try:
        from floodmind.agent.mcp_client import McpClientConnection
    except Exception:
        return

    @property
    def is_connected(self):  # type: ignore[override]
        if not getattr(self, "_initialized", False):
            return False
        proc = getattr(self, "_process", None)
        if proc is not None:
            return proc.poll() is None
        return True

    McpClientConnection.is_connected = is_connected


_patch_mcp_liveness()


# Per-server MCP tool-call health, updated by wrapping McpClientPool.call_tool.
# Connection-level "connected" is True the moment a stdio subprocess handshakes,
# but a tool can still fail at call time — e.g. hydro-rag's wrapper connects fine
# while the knowledge-base backend it talks to is down, surfacing only when a
# tool is actually invoked. This records the most recent call outcome so the UI
# can show "调用异常" instead of a misleading "已连接".
_MCP_CALL_HEALTH: dict[str, dict] = {}
# Result strings that indicate a tool call failed (the SDK wraps MCP errors as
# "MCP 工具 … 调用失败"; servers often surface backend-down as "无法连接").
_MCP_FAIL_MARKERS = (
    "调用失败", "无法连接", "连接失败", "ConnectionError",
    "ECONNREFUSED", "connection refused",
)


def _patch_mcp_call_health():
    try:
        from floodmind.agent.mcp_client import McpClientPool
    except Exception:
        return

    _orig_call_tool = McpClientPool.call_tool

    def _call_tool(self, full_name: str, arguments: dict):
        parts = full_name.split(":", 2)
        server = parts[1] if len(parts) >= 3 else full_name
        try:
            result = _orig_call_tool(self, full_name, arguments)
        except Exception as e:
            _MCP_CALL_HEALTH[server] = {"ok": False, "error": str(e)[:200]}
            raise
        if isinstance(result, str) and any(m in result for m in _MCP_FAIL_MARKERS):
            _MCP_CALL_HEALTH[server] = {"ok": False, "error": result[:200]}
        else:
            _MCP_CALL_HEALTH[server] = {"ok": True, "error": None}
        return result

    McpClientPool.call_tool = _call_tool


_patch_mcp_call_health()


def _persist_runtime_mcp(server_config: dict) -> None:
    """Append a runtime-loaded MCP (LoadMcpServer) to mcp.json so it survives
    restarts and shows in the MCP menu. No-op if it's already configured, and
    writes the file directly (no reconnect) so an in-flight run isn't disrupted.
    """
    import json

    try:
        from .catalog_api import _mcp_path, read_mcp_config, _validate_mcp_server_transport
    except Exception:
        return
    name = server_config.get("name")
    if not name:
        return
    servers = read_mcp_config()
    if any(s.get("name") == name for s in servers):
        return  # already persisted (e.g. startup connect_all, or a prior load)
    entry: dict = {"name": name, "transport": server_config.get("transport", "sse")}
    for k in ("command", "args", "env", "url", "headers"):
        if k in server_config:
            entry[k] = server_config[k]
    try:
        _validate_mcp_server_transport(entry)
    except Exception:
        return
    servers.append(entry)
    try:
        path = _mcp_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps({"servers": servers}, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"[sidecar] persisted runtime MCP '{name}' to mcp.json", file=sys.stderr)
    except Exception as e:
        print(f"[sidecar] persist runtime MCP failed: {e}", file=sys.stderr)


def _patch_mcp_persist_runtime():
    """Wrap McpClientPool.connect_server so any newly-connected server that
    isn't already in mcp.json gets persisted. This makes agent-created MCPs
    (LoadMcpServer) durable + visible in the MCP menu across restarts."""
    try:
        from floodmind.agent.mcp_client import McpClientPool
    except Exception:
        return

    _orig_connect = McpClientPool.connect_server

    def _connect_server(self, server_config: dict):
        conn = _orig_connect(self, server_config)
        try:
            _persist_runtime_mcp(server_config)
        except Exception as e:
            print(f"[sidecar] runtime MCP persist hook error: {e}", file=sys.stderr)
        return conn

    McpClientPool.connect_server = _connect_server


_patch_mcp_persist_runtime()


_IMAGE_EXTS = (".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp")


def translate_event(raw: dict) -> list[dict]:
    """Map one raw SDK event to zero-or-more sidecar-schema events.

    Pure function — no network, no SDK import — so it is unit-testable in
    isolation. Unknown event types pass through with their type preserved so
    new SDK events are visible rather than silently dropped.
    """
    t = raw.get("type")

    if t == "answer_delta":
        return [{"type": "text", "content": raw.get("content", "")}]
    if t == "thought_delta":
        return [{"type": "thinking", "content": raw.get("content", "")}]
    if t == "action_start":
        return [{"type": "tool_start", "call_id": raw.get("call_id", ""),
                 "tool_name": raw.get("tool_name", ""), "input": raw.get("tool_input", "")}]
    if t == "action_end":
        return [{"type": "tool_end", "call_id": raw.get("call_id", ""),
                 "tool_name": raw.get("tool_name", ""),
                 "status": raw.get("status", ""), "output": raw.get("content", "")}]
    if t == "workflow_plan":
        return [{"type": "plan", "title": raw.get("title", ""),
                 "steps": raw.get("steps", [])}]
    if t == "workflow_step":
        return [{"type": "step", "key": raw.get("step_key", raw.get("key", "")),
                 "status": raw.get("status", ""), "title": raw.get("title", ""),
                 "outcome": raw.get("outcome", "")}]
    if t in ("file_generated", "image_generated"):
        # NOTE: in practice the SDK does not yield these to stream consumers
        # (emitted post-loop); FloodMindAgent.stream surfaces artifacts via an
        # output-dir diff instead. Kept for completeness/test fidelity.
        return [{"type": "artifact",
                 "kind": "image" if t == "image_generated" else "file",
                 "name": raw.get("filename", raw.get("file_name", "")),
                 "path": raw.get("image_url", raw.get("download_url", ""))}]
    if t == "permission_ask":
        return [{"type": "permission", "ask_id": raw.get("ask_id", ""),
                 "call_id": raw.get("call_id", ""), "tool_name": raw.get("tool_name", ""),
                 "reason": raw.get("reason", ""), "input": raw.get("tool_input", {}),
                 "session_id": raw.get("session_id", "")}]
    if t == "token_usage":
        return [{"type": "usage", "prompt": raw.get("prompt_tokens", 0),
                 "completion": raw.get("completion_tokens", 0),
                 "total": raw.get("total_tokens", 0)}]
    if t in ("error", "llm_token_error", "artifact_warning"):
        # llm_token_error fires on out-of-balance LLM accounts; artifact_warning
        # on artifact problems. Surface both as user-visible errors.
        return [{"type": "error", "content": raw.get("content", "")}]

    # Noisy or redundant events we intentionally drop. context_compress is the
    # type the agent actually emits (the *_start/*_done variants are defined
    # but never called).
    if t in ("heartbeat", "final_text", "llm_step_start", "llm_step_end",
             "context_compress", "context_compress_start", "context_compress_done",
             "permission_resolved", "retry_attempt", "system", "attachment_context",
             "memory_status"):
        return []

    # Unknown event: minimal pass-through (drop nothing except the type key dup).
    return [{"type": t or "unknown", **{k: v for k, v in raw.items() if k != "type"}}]


class FloodMindAgent:
    """Sidecar Agent backed by the real FloodMind SDK.

    Implements the sidecar `Agent` protocol (`stream`/`clear_memory`/
    `rebind_workspace`). The SDK `Agent` is constructed lazily in __init__ (still
    deferring the heavy tool-registry build to first use where possible) and a
    `DualMemory` is supplied so multi-turn history works.
    """

    def __init__(self, permission_handler=None, workspace_manager=None):
        # The desktop can start before the user has configured an API key.
        # Degrade gracefully: the agent stays unbuilt until reload_model() succeeds
        # (e.g. after the user fills in the Settings GUI and saves).
        try:
            self._llm = self._resolve_llm()
        except Exception as e:
            print(f"[sidecar] ModelClient init failed (model not configured): {e}", file=sys.stderr)
            self._llm = self._load_llm_fallback()

        # Auto-approve by default; ASK-policy tools are handled in stream().
        self._permission_handler = permission_handler or (lambda tool_name, tool_input: True)
        # Honor the persisted permission mode from settings.json at startup so
        # the agent's behaviour matches what the GUI shows (and what the user
        # last saved), instead of always defaulting to trust-once until the
        # mode is re-saved.
        try:
            from .config_api import read_permissions_config

            self._permission_mode = PermissionMode(read_permissions_config().get("mode", "trust-once"))
        except Exception:
            self._permission_mode = PermissionMode.TRUST_ONCE
        self._permission_cache: PermissionCache | None = None
        self._workspace_manager = workspace_manager
        # Output dir captured during _set_workspace; used by the artifact diff.
        self._output_dir = None
        # Pause signal: set by pause(), polled by the SDK's abort_check during a
        # run. The executor aborts at the next LLM/tool boundary, discards the
        # partial round (not written to memory), and the next stream() resumes
        # from memory. Cleared at the start of each stream().
        self._abort = threading.Event()
        # Concurrency: Flask runs threaded=True, so a /api/chat stream can race a
        # concurrent workspace-open/model-reload/second-chat on another worker
        # thread. _stream_lock is held for an entire run and serializes chats
        # (two foreground streams would otherwise cross-bind the process-global
        # session context and write to the wrong workspace). _fg_lock is held
        # only briefly around self._agent swaps and the session-context write so
        # a rebind can't tear against a live _set_workspace. Both use getattr
        # guards in stream()/the mutators so bare __new__ test instances work.
        self._stream_lock = threading.Lock()
        self._fg_lock = threading.RLock()
        # The SDK's executor captures `memory` BY REFERENCE at construction
        # (NativeAgentExecutor(memory=self.memory)), so swapping self.memory later
        # is invisible to it. Per-workspace isolation therefore requires building
        # a whole new agent (→ new executor → new memory), not an attribute swap.
        # Seed the initial memory session from a workspace persisted across a
        # restart, so it matches the session _set_workspace will use on first run.
        from .workspace import session_id_for

        persisted = workspace_manager.current_path() if workspace_manager else None
        initial_sid = session_id_for(persisted) if persisted else "desktop-default"

        if self._llm is not None:
            try:
                self._agent = self._build_agent(*self._memory_target(initial_sid))
            except Exception as e:
                print(f"[sidecar] initial agent build failed: {e}", file=sys.stderr)
                self._agent = None
        else:
            self._agent = None

        # Apply user-disabled skills persisted under ~/.floodmind/skills/.
        try:
            from .catalog_api import apply_skills_disabled
            apply_skills_disabled()
        except Exception as e:
            print(f"[sidecar] apply disabled skills failed: {e}", file=sys.stderr)

        # Register custom skills persisted under ~/.floodmind/skills/.
        try:
            from .catalog_api import _register_custom_skills
            _register_custom_skills()
        except Exception as e:
            print(f"[sidecar] register custom skills failed: {e}", file=sys.stderr)

    def _desktop_block(self) -> dict:
        """The desktop-only selection block in settings.json (activeModel + flags)."""
        try:
            from .config_api import _load_raw_settings

            raw = _load_raw_settings()
        except Exception:
            return {}
        d = raw.get("desktop")
        return d if isinstance(d, dict) else {}

    def mcp_call_health(self) -> dict:
        """Per-server MCP tool-call health: {server: {ok, error}}.
        Populated by the McpClientPool.call_tool wrapper. Reflects whether the
        most recent tool call actually succeeded — a stronger signal than
        connection-level "connected" (a connected wrapper can still fail when
        the backend service it proxies is down)."""
        return dict(_MCP_CALL_HEALTH)

    def _resolve_llm(self):
        """Build a ModelClient for the desktop's active model via resolve_model().

        The SDK stores no top-level model-selection block; the active model is the
        first in the catalog. The desktop records the GUI's pick under
        ``desktop.activeModel`` and resolves it here so the right provider's
        api_key/base_url are used (cross-provider switching would otherwise pick
        up the wrong credentials). Generation params come from the model's own
        definition (single source of truth).
        """
        from floodmind.agent.native.model_client import ModelClient
        from floodmind.config.model_resolver import resolve_model

        desktop = self._desktop_block()
        active = desktop.get("activeModel") or None
        # provider_id disambiguates when two providers expose the same model id
        # (official deepseek vs a LAN OpenAI-compatible proxy both serving
        # deepseek-v4-flash); without it resolve_model picks the catalog-first
        # match, silently routing to the wrong provider.
        provider = desktop.get("activeProvider") or None
        rm = resolve_model(model_key=active, provider_id=provider)
        return ModelClient(
            api_key=rm.api_key,
            base_url=rm.base_url,
            model_name=rm.id,
            temperature=rm.temperature,
            max_tokens=rm.max_tokens,
            enable_thinking=bool(desktop.get("enableReasoning", False)),
        )

    def _load_llm_fallback(self):
        """Last-resort: ignore desktop.activeModel and use the first configured model.

        ``resolve_model(model_key=...)`` raises if the selected model is absent or
        its provider has no credentials. Falling back to the catalog's first model
        (which resolve_model() with no key returns) keeps the app usable when the
        GUI selection points at an unconfigured provider.
        """
        try:
            from floodmind.agent.native.model_client import ModelClient
            from floodmind.config.model_resolver import resolve_model

            rm = resolve_model()  # catalog-first, ignores desktop.activeModel
            if not rm.api_key:
                return None
            print(f"[sidecar] falling back to first configured model: {rm.provider}/{rm.id}", file=sys.stderr)
            return ModelClient(
                api_key=rm.api_key,
                base_url=rm.base_url,
                model_name=rm.id,
                temperature=rm.temperature,
                max_tokens=rm.max_tokens,
            )
        except Exception as e:
            print(f"[sidecar] ModelClient fallback also failed: {e}", file=sys.stderr)
            return None

    def _active_supports_vision(self) -> bool:
        """Whether the desktop's active model accepts image input.

        resolve_model() is the SDK's single source of truth (the curated flag
        set on the model definition); falling back to False on any error
        disables the image path rather than sending images to a model that
        would error out at the provider.
        """
        try:
            from floodmind.config.model_resolver import resolve_model

            desktop = self._desktop_block()
            rm = resolve_model(
                model_key=desktop.get("activeModel") or None,
                provider_id=desktop.get("activeProvider") or None,
            )
            return bool(getattr(rm, "supports_vision", False))
        except Exception:
            return False

    def _build_agent(self, session_id: str, persist_dir: str):
        """Construct a fresh SDK agent bound to a per-session DualMemory."""
        from floodmind.agent import create_flood_agent
        from floodmind.memory.dual_memory import DualMemory

        # enable_reasoning / enable_search are desktop session-level toggles
        # stored under the `desktop` block (the SDK no longer persists a model
        # selection block in settings.json).
        desktop = self._desktop_block()
        enable_reasoning = bool(desktop.get("enableReasoning", False))
        enable_search = bool(desktop.get("enableSearch", False))

        memory = DualMemory(
            session_id=session_id,
            persist_dir=persist_dir,
            llm=self._llm,
            context_window=32768,
        )

        # Desktop has an explicit workspace; tell the agent to search the whole
        # tree, not just the output/upload directory roots highlighted by the SDK
        # default system prompt.
        workspace_path = (
            self._workspace_manager.current_path()
            if self._workspace_manager else None
        )
        if workspace_path:
            system_prompt = (
                "你是一个智能助手，使用可用工具帮助用户完成任务。\n"
                f"当前工作区是：{workspace_path}\n"
                "用户提到的文件、数据或附件可能位于工作区的任何子目录中。"
                "搜索文件时，请以该工作区根目录为 path 参数进行递归搜索（例如 Glob 的 "
                f"path='{workspace_path}', pattern='**/*.xlsx'），不要只搜索输出目录或上传目录的根。"
            )
        else:
            system_prompt = "你是一个智能助手，使用可用工具帮助用户完成任务。"

        agent = create_flood_agent(
            llm_service=self._llm,
            memory=memory,
            session_id=session_id,
            permission_handler=self._permission_handler,
            max_iterations=50,
            enable_reasoning=enable_reasoning,
            enable_search=enable_search,
            system_prompt=system_prompt,
        )
        self._patch_tool_policies_for_desktop_permission(agent)
        return agent

    @staticmethod
    def _memory_target(session_id: str) -> tuple[str, str]:
        """(session_id, persist_dir) for a DualMemory under app-data."""
        from .workspace import _app_data_dir
        return session_id, str(_app_data_dir() / session_id / "memory")

    def _set_workspace(self):
        """Bind the agent's outputs/memory to a workspace folder.

        The SDK's PathService only permits writes inside the active workspace's
        user_dir/sandbox_base/writable_roots; with NO workspace set, the static
        write-prefixes point at the SDK's own package dir (not our app-data), so
        every write is denied. Therefore ALWAYS set a workspace: the user's
        folder if one is open, else a default under app-data. Errors are logged
        and swallowed so a workspace hiccup never kills chat.
        """
        from .workspace import _app_data_dir, session_id_for

        self._output_dir = None
        opened = self._workspace_manager.current_path() if self._workspace_manager else None
        if opened:
            user_dir, sid = opened, session_id_for(opened)
        else:
            # Default workspace so the agent always has somewhere writable.
            user_dir = str(_app_data_dir() / "default-workspace")
            sid = "desktop-default"

        try:
            from floodmind.agent.runtime.services.workspace_service import (
                build_workspace,
            )
            from floodmind.tools import set_session_context

            ws = build_workspace(
                sid,
                session_root=_app_data_dir(),
                user_dir=user_dir,
                sandbox_strategy="user_dir",
            ).ensure()
            # Bind the workspace as an INSTANCE attribute on the agent (not the
            # contextvar). The SDK's agent loop runs in a child thread that does
            # not inherit the floodmind_workspace contextvar; the SDK now reads
            # self._workspace (_effective_workspace) and re-binds the contextvar
            # inside _run_loop, so output_dir / upload_dir / PathService write &
            # read roots all resolve to the real workspace (fixes the C-drive bug).
            self._agent.bind_workspace(ws)
            set_session_context(sid, output_dir=str(ws.user_dir))
            self._output_dir = str(ws.user_dir)
            # The SDK bakes `会话输出目录: <output_dir>` into the cached prompt at
            # __init__ (_init_executors), BEFORE bind_workspace sets _workspace —
            # so at that moment _get_output_dir() returns the AppData fallback and
            # the LLM is permanently told to write under C:\...\data\sessions\<sid>
            # \outputs. Re-run _init_executors() now that _workspace is bound so the
            # prompt reflects the real workspace. (SDK-side fix pending: refresh the
            # cached prompt/session_env inside bind_workspace itself.)
            try:
                self._agent._init_executors()
            except Exception as e:
                print(f"[sidecar] _init_executors refresh failed: {e}", file=sys.stderr)
            print(
                f"[sidecar] workspace bound: user_dir={ws.user_dir} sid={sid} | "
                f"agent={type(self._agent).__name__} id={id(self._agent)} "
                f"_workspace_set={getattr(self._agent, '_workspace', None) is not None}",
                file=sys.stderr,
            )
        except Exception:
            print(f"[sidecar] workspace setup failed for {user_dir}; using SDK default",
                  file=sys.stderr)

    # ── artifact detection (output-dir diff) ───────────────────
    def _snapshot_outputs(self, output_dir: str | None = None) -> dict[str, float]:
        output_dir = output_dir or getattr(self, "_output_dir", None)
        if not output_dir:
            return {}
        try:
            return {
                f: os.path.getmtime(os.path.join(output_dir, f))
                for f in os.listdir(output_dir)
            }
        except OSError:
            return {}

    def _diff_outputs(self, before: dict[str, float],
                      output_dir: str | None = None) -> Iterator[dict]:
        """Yield one artifact event per file added to the output dir since `before`."""
        output_dir = output_dir or getattr(self, "_output_dir", None)
        if not output_dir:
            return
        try:
            now = {
                f: os.path.getmtime(os.path.join(output_dir, f))
                for f in os.listdir(output_dir)
            }
        except OSError:
            return
        for name in sorted(set(now) - set(before)):
            ext = os.path.splitext(name)[1].lower()
            kind = "image" if ext in _IMAGE_EXTS else "file"
            yield {
                "type": "artifact",
                "kind": kind,
                "name": name,
                # Absolute path — desktop can later "open in system app".
                "path": os.path.join(output_dir, name),
            }

    # ── permission: three-tier authorization ──────────────────
    def set_permission_mode(self, mode: str) -> None:
        """Update the global permission mode (always-trust | trust-once | always-ask)."""
        try:
            self._permission_mode = PermissionMode(mode)
        except ValueError:
            self._permission_mode = PermissionMode.TRUST_ONCE

    def _current_workspace_path(self) -> str | None:
        return self._workspace_manager.current_path() if self._workspace_manager else None

    def _ensure_permission_cache(self) -> PermissionCache:
        ws = self._current_workspace_path()
        if self._permission_cache is None or self._permission_cache.workspace != ws:
            self._permission_cache = PermissionCache(ws)
        return self._permission_cache

    def _patch_tool_policies_for_desktop_permission(self, agent) -> None:
        """Force desktop-level ASK for all non-readonly tools.

        The SDK's PermissionService only emits `permission_ask` events for tools
        whose native `permission_policy.policy_type` is ``ask``. Built-in tools
        like Bash/Write/ReadFile/WebSearch use ``exec``/``write``/``read_path``/
        ``network`` and are auto-approved after path/danger checks. To implement
        the desktop's three-tier authorization (always-trust / trust-once /
        always-ask), we attach a ``check_permissions_fn`` that upgrades the
        decision to ASK after the SDK's own policy checks have run. If the SDK
        check returned DENY (e.g. dangerous command or path outside workspace),
        that DENY is preserved.
        """
        from floodmind.agent.runtime.contracts.permissions import (
            PermissionBehavior,
            PermissionDecision,
        )

        keep_as_is = {"readonly", "internal", "ask"}

        def _make_check_fn(existing_fn, tool_name):
            def _check(tool_input):
                if existing_fn is not None:
                    try:
                        result = existing_fn(tool_input)
                        if hasattr(result, "behavior") and result.behavior == PermissionBehavior.DENY:
                            return result
                    except Exception:
                        pass
                return PermissionDecision(
                    behavior=PermissionBehavior.ASK,
                    reason=f"需要用户确认此操作（{tool_name}）",
                )

            return _check

        for registry in (
            getattr(agent, "_orchestrator_registry", None),
            getattr(agent, "_specialist_registry", None),
        ):
            if registry is None:
                continue
            for tool in registry.all():
                policy = getattr(tool, "permission_policy", None)
                policy_type = getattr(policy, "policy_type", None) if policy else None
                if policy_type in keep_as_is:
                    continue
                existing_fn = getattr(tool, "check_permissions_fn", None)
                tool.check_permissions_fn = _make_check_fn(existing_fn, tool.name)

    def _respond_to_ask(self, raw: dict, approved: bool) -> None:
        ask_id = raw.get("ask_id")
        session_id = raw.get("session_id")
        if not ask_id or not session_id:
            return
        try:
            from floodmind.agent.runtime.contracts.permissions import PermissionAskResponse
            from floodmind.agent.runtime.services.ask_service import get_ask_service

            get_ask_service().respond(
                PermissionAskResponse(session_id=session_id, ask_id=ask_id, approved=approved)
            )
        except Exception as e:
            print(f"[sidecar] respond to ask {ask_id} failed: {e}", file=sys.stderr)

    def _auto_approve(self, raw: dict) -> None:
        """Legacy convenience: unconditionally approve a permission_ask."""
        self._respond_to_ask(raw, approved=True)

    def _handle_permission_ask(self, raw: dict, ev: dict) -> dict:
        """Return the permission event that should be yielded to the UI.

        In 'always-trust' mode the ask is approved immediately and the event is
        marked approved=true so the UI can still log it.

        In 'trust-once' mode an approved fingerprint is also approved silently;
        otherwise the ask is registered as pending and yielded for user action.

        In 'always-ask' mode every ask is yielded pending user action.
        """
        tool_name = ev.get("tool_name", "")
        tool_input = ev.get("input", {})
        ask_id = ev.get("ask_id", "")
        session_id = ev.get("session_id", "")
        fingerprint = permission_fingerprint(tool_name, tool_input, self._current_workspace_path())

        if self._permission_mode == PermissionMode.ALWAYS_TRUST:
            self._respond_to_ask(raw, approved=True)
            return {**ev, "approved": True, "auto_approved": True}

        cache = self._ensure_permission_cache()
        if self._permission_mode == PermissionMode.TRUST_ONCE and cache.is_approved(fingerprint):
            self._respond_to_ask(raw, approved=True)
            return {**ev, "approved": True, "auto_approved": True}

        # Needs explicit user approval: register so /api/permission/respond can
        # look up the fingerprint and unblock the SDK executor.
        PENDING_ASKS.register(ask_id, session_id, fingerprint, tool_name, tool_input)
        return ev

    def respond_to_permission_ask(self, ask_id: str, approved: bool) -> dict:
        """Respond to a pending permission ask and update the trust cache.

        Returns {"ok": True} on success, {"error": ...} otherwise.
        """
        pending = PENDING_ASKS.pop(ask_id)
        if pending is None:
            return {"error": "未找到待处理的权限请求"}

        try:
            from floodmind.agent.runtime.contracts.permissions import PermissionAskResponse
            from floodmind.agent.runtime.services.ask_service import get_ask_service

            get_ask_service().respond(
                PermissionAskResponse(
                    session_id=pending.get("session_id", ""),
                    ask_id=ask_id,
                    approved=approved,
                )
            )
        except Exception as e:
            return {"error": f"响应权限请求失败：{e}"}

        if approved and self._permission_mode == PermissionMode.TRUST_ONCE:
            cache = self._ensure_permission_cache()
            fingerprint = permission_fingerprint(
                pending["tool_name"], pending["tool_input"], self._current_workspace_path()
            )
            cache.approve(fingerprint)

        return {"ok": True}

    # ── memory: per-workspace isolation + New Session ──────────
    def _fg(self):
        """Foreground mutation lock; a no-op for bare __new__ test instances."""
        lock = getattr(self, "_fg_lock", None)
        return lock if lock is not None else contextlib.nullcontext()

    def pause(self) -> None:
        """Signal the running stream to abort at the next LLM/tool boundary.

        The SDK executor polls the abort_check passed to stream(); when it fires
        the current (partial) round is discarded — NOT written to memory — and
        the run ends (terminal failed). The next stream() resumes from memory,
        so the user pauses, appends an instruction, and sends to resume.
        """
        self._abort.set()

    def append_instruction(self, text: str) -> None:
        """Append a user instruction to the agent's memory mid-run.

        The SDK's NativeAgentExecutor polls memory between iterations
        (`_inject_queued_user_messages`) and injects any new user message into
        the active run — steering the current turn if it has more iterations,
        or reviving at terminal state for a queued follow-up. DualMemory is
        RLock-guarded, so this is safe to call from the Flask thread while the
        agent's run-loop thread is streaming.
        """
        if not text or not text.strip():
            return
        try:
            with self._fg():
                mem = getattr(self._agent, "memory", None)
            if mem is not None and hasattr(mem, "add_user_message"):
                mem.add_user_message(text.strip())
        except Exception as e:
            print(f"[sidecar] append_instruction failed: {e}", file=sys.stderr)

    def rebind_workspace(self, path: str) -> None:
        """Rebuild the agent against a DualMemory keyed to this workspace.

        Reconstruction (not an attribute swap) is required because the SDK's
        executor captures `memory` by reference at construction. A fresh agent
        also means an in-flight stream (holding the old agent) is untouched —
        no race on a live executor's memory.
        """
        from .workspace import session_id_for

        session_id, persist_dir = self._memory_target(session_id_for(path))
        try:
            with self._fg():
                self._agent = self._build_agent(session_id, persist_dir)
        except Exception as e:
            print(f"[sidecar] workspace memory rebind failed for {path}: {e}", file=sys.stderr)

    def clear_memory(self) -> None:
        # In-place clear is sufficient: NativeFloodAgent.clear_memory() clears
        # self.memory, which is the very same object the executor holds.
        try:
            with self._fg():
                if hasattr(self._agent, "clear_memory"):
                    self._agent.clear_memory()
        except Exception as e:
            print(f"[sidecar] clear_memory failed: {e}", file=sys.stderr)

    def reload_model(self) -> bool:
        """Re-read model settings and rebuild the agent so config changes apply.

        Reuses the current session id + its persist_dir, so conversation memory
        is reloaded from disk (no history loss).

        Model resolution goes through resolve_model() (the SDK's single source of
        truth): reload_config() clears the SDK dict cache so the freshly-saved
        settings.json is re-read, then _resolve_llm() picks up the desktop's
        active model + the right provider credentials.
        """
        try:
            from floodmind.config.settings import reload_config

            reload_config()  # pick up the just-saved settings.json
            # When the agent was never built (first launch, no API key yet), use a
            # fresh default session so the first config save can bring it up.
            if self._agent is not None:
                sid = self._agent.session_id
            else:
                sid = "desktop-default"
            _, persist_dir = self._memory_target(sid)

            self._llm = self._resolve_llm()
            with self._fg():
                self._agent = self._build_agent(sid, persist_dir)
            return True
        except Exception as e:
            print(f"[sidecar] reload_model failed: {e}", file=sys.stderr)
            return False

    def reload_persona(self) -> bool:
        """Rebuild the agent so edited SOUL.md / global AGENTS.md take effect.

        A fresh NativeFloodAgent re-reads SOUL.md via _build_stable_prompt and
        gets a new ContextRuntime (AGENTS.md TTL cache cleared). Re-binding the
        workspace then re-runs _init_executors, baking the new identity into the
        cached prompt so the NEXT message sees it. History is preserved
        (persist_dir reused). Safe to call mid-stream: the in-flight generator
        holds the old agent; self._agent swaps on the next stream.
        """
        try:
            if self._agent is not None:
                sid = self._agent.session_id
            else:
                sid = "desktop-default"
            _, persist_dir = self._memory_target(sid)
            with self._fg():
                self._agent = self._build_agent(sid, persist_dir)
                self._set_workspace()  # rebind workspace + refresh cached prompt
            return True
        except Exception as e:
            print(f"[sidecar] reload_persona failed: {e}", file=sys.stderr)
            return False

    def activate_conversation(self, session_id: str) -> None:
        """Rebuild the SDK agent bound to this conversation's session_id.

        Reuses _build_agent + _memory_target so the conversation's DualMemory chat
        history is loaded from its own persist_dir. The experience library and
        long-term memory stay global (see docs/memory-model). A fresh agent also
        means an in-flight stream holding the old agent is untouched.
        """
        try:
            sid, persist_dir = self._memory_target(session_id)
            with self._fg():
                self._agent = self._build_agent(sid, persist_dir)
        except Exception as e:
            print(f"[sidecar] activate_conversation failed for {session_id}: {e}", file=sys.stderr)

    def _set_workspace_for(self, workspace_path: str) -> str | None:
        """Inject `workspace_path` into the CURRENT thread's contextvars.

        Mirrors _set_workspace but for an explicit path (used by run_headless so
        a background task runs in its own workspace without disturbing the
        foreground conversation's contextvars, which are per-thread).

        Returns the resolved Workspace object (caller binds it to its agent via
        bind_workspace, since headless builds a fresh agent), or None on failure.
        """
        from .workspace import _app_data_dir, session_id_for
        try:
            from floodmind.agent.runtime.services.workspace_service import (
                build_workspace,
            )
            from floodmind.tools import set_session_context

            sid = session_id_for(workspace_path)
            ws = build_workspace(
                sid,
                session_root=_app_data_dir(),
                user_dir=workspace_path,
                sandbox_strategy="user_dir",
            ).ensure()
            set_session_context(sid, output_dir=str(ws.user_dir))
            return ws
        except Exception as e:
            print(f"[sidecar] _set_workspace_for failed for {workspace_path}: {e}", file=sys.stderr)
            return None

    def run_headless(self, session_id: str, workspace_path: str, command: str):
        """Execute `command` in an isolated background session.

        Builds a FRESH agent (does not touch self._agent), sets the task's
        workspace in this thread's contextvars, streams the command, and returns
        (events, artifacts, final_text). Any failure is folded into an error
        event so the caller can record complete_task(success=False).
        """
        events: list[dict] = []
        artifacts: list[dict] = []
        final_text = ""
        try:
            ws = self._set_workspace_for(workspace_path)
            output_dir = str(ws.user_dir) if ws else None
            sid, persist_dir = self._memory_target(session_id)
            agent = self._build_agent(sid, persist_dir)
            # Bind the task workspace to the fresh agent (instance attribute,
            # not contextvar) — see _set_workspace for why this is required.
            if ws:
                agent.bind_workspace(ws)
                # Refresh the cached prompt (see _set_workspace): _init_executors ran
                # at construction with _workspace=None, baking the AppData fallback
                # output dir into the prompt the LLM sees.
                try:
                    agent._init_executors()
                except Exception as e:
                    print(f"[sidecar] headless _init_executors refresh failed: {e}", file=sys.stderr)
            before = self._snapshot_outputs(output_dir)
            for raw in agent.stream(command):
                for ev in translate_event(raw):
                    if ev.get("type") == "done":
                        continue
                    if ev.get("type") == "permission":
                        # Automated/headless tasks run unattended — auto-approve
                        # every permission ask so the SDK executor doesn't block
                        # waiting for a user response that never comes (which
                        # otherwise hangs the task unless the global mode is
                        # always-trust). The trust-once/always-ask mode only
                        # governs the foreground interactive conversation.
                        self._respond_to_ask(raw, approved=True)
                        ev = {**ev, "approved": True, "auto_approved": True}
                    events.append(ev)
                    if ev.get("type") == "artifact":
                        artifacts.append(
                            {"kind": ev.get("kind", "file"),
                             "name": ev.get("name", ""),
                             "path": ev.get("path", "")}
                        )
                    elif ev.get("type") == "text":
                        final_text += ev.get("content", "")
            # The SDK does not reliably emit file_generated/image_generated to
            # stream consumers, so diff the output dir the same way stream() does.
            for ev in self._diff_outputs(before, output_dir):
                events.append(ev)
                artifacts.append(
                    {"kind": ev.get("kind", "file"),
                     "name": ev.get("name", ""),
                     "path": ev.get("path", "")}
                )
        except Exception as e:
            events.append({"type": "error", "content": f"后台执行出错：{e}"})
        return events, artifacts, final_text

    def generate_title(self, message: str) -> str:
        """LLM-generate a short Chinese title using the DESKTOP's active model.

        Mirrors _resolve_llm: resolve_model() is given the GUI's activeModel +
        activeProvider so the SAME provider/credentials the user selected are
        used. resolve_model() with no args picks the catalog-first provider,
        which can be a different region/key (e.g. official deepseek vs a LAN
        proxy serving the same model id) and 401 on title generation — leaving
        every conversation stuck on the "新会话" fallback title. '' on any
        failure so callers keep a fallback.
        """
        import re
        try:
            from floodmind.agent.native.model_client import ModelClient
            from floodmind.config.model_resolver import resolve_model

            desktop = self._desktop_block()
            active = desktop.get("activeModel") or None
            provider = desktop.get("activeProvider") or None
            try:
                rm = resolve_model(model_key=active, provider_id=provider)
            except Exception:
                # Selected model/provider unconfigured — fall back to the
                # catalog default rather than failing title generation entirely.
                rm = resolve_model()
            # max_tokens must accommodate reasoning models: they emit their
            # chain-of-thought into reasoning_content BEFORE the answer lands in
            # content, so a small budget (e.g. 60) gets exhausted mid-reasoning
            # and content comes back empty. 10000 lets the reasoning finish and a
            # short title through; non-reasoning models simply stop early.
            llm = ModelClient(
                api_key=rm.api_key,
                base_url=rm.base_url,
                model_name=rm.id,
                temperature=0.2,
                max_tokens=10000,
                enable_thinking=False,
            )
            prompt = (
                "请根据用户问题拟一个简短的中文会话标题，用于左侧历史会话列表展示。"
                "要求：10到18个字，突出任务目标，不要带引号，不要解释，不要句号。\n\n"
                f"用户问题：{message}"
            )
            result = llm.invoke(prompt)
            if result is None or not hasattr(result, "content"):
                return ""
            raw = (getattr(result, "content", "") or "").strip()
            lines = raw.splitlines() if raw else []
            if not lines:
                return ""
            title = lines[0].strip().strip('"""')
            title = re.sub(r"^[#\-*\d.\s]+", "", title).strip()
            return title[:24] if title else ""
        except Exception as e:
            print(f"[sidecar] generate_title failed: {e}", file=sys.stderr)
            return ""

    # ── main entry ─────────────────────────────────────────────
    def stream(self, messages: list[Message], attachments: list | None = None) -> Iterator[dict]:
        # Serialize foreground chats: only one /api/chat run at a time. The
        # shared self._agent + the process-global session context mean two
        # concurrent streams could otherwise cross-bind workspaces. Acquire the
        # stream lock non-blocking so a second request fails fast instead of
        # queueing behind a (possibly long) run. getattr guard keeps bare
        # __new__ test instances working (no _stream_lock attribute set).
        stream_lock = getattr(self, "_stream_lock", None)
        acquired = stream_lock.acquire(blocking=False) if stream_lock is not None else True
        abort = getattr(self, "_abort", None)
        try:
            if not acquired:
                yield {"type": "error", "content": "已有任务正在执行，请等待当前任务结束。"}
                yield {"type": "done"}
                return

            # We hold the stream lock for this run — safe to reset any stale
            # pause signal from a previous run. Done AFTER the acquire check so
            # a rejected (busy) request never clears the active run's abort.
            if abort is not None:
                abort.clear()

            if getattr(self, "_agent", None) is None:
                yield {"type": "error", "content": "模型未配置，请先在左侧「设置」中配置 API Key 后保存。"}
                yield {"type": "done"}
                return

            user_text = messages[-1]["content"] if messages else ""
            abort_check = abort.is_set if abort is not None else None

            # Normalize any image attachments into SDK Attachment objects with a
            # real on-disk path. Errors are surfaced as NDJSON error events but
            # do not abort the whole turn (one bad image shouldn't kill the run).
            # Images are single-turn only — never persisted to memory by us.
            sdk_attachments: list = []
            if attachments:
                from .attachments import normalize_attachments
                from .workspace import _app_data_dir

                staging_dir = _app_data_dir() / "image-staging"
                ws_root = self._current_workspace_path()
                sdk_attachments, att_errors = normalize_attachments(
                    attachments, ws_root, staging_dir
                )
                # Non-vision active model: drop ALL images and tell the user.
                # The front-end also disables entry; this is the authoritative
                # back-stop so a stale GUI can't send images to a text model.
                if sdk_attachments and not self._active_supports_vision():
                    sdk_attachments = []
                    yield {"type": "error",
                           "content": "当前模型不支持图片输入，请在设置中切换到视觉模型。"}
                for msg in att_errors:
                    yield {"type": "error", "content": f"⚠️ {msg}"}

            before: dict[str, float] = {}
            errored = False
            agent = None
            try:
                # Bind workspace + capture the agent reference under the
                # foreground lock so a concurrent rebind/reload can't swap
                # self._agent mid-bind. The (long) iteration then runs without
                # the lock, against the locally-captured agent — an in-flight
                # rebuild leaves this stream iterating the old agent, exactly
                # as the rebind docstring promises.
                with self._fg():
                    self._set_workspace()
                    agent = self._agent
                    before = self._snapshot_outputs()
                # Pass abort_check only when armed (production always sets _abort
                # in __init__). Test stubs mimic the SDK stream() signature
                # optionally, so we avoid forcing the kwarg on them.
                stream_kwargs = {"abort_check": abort_check} if abort_check is not None else {}
                if sdk_attachments:
                    stream_kwargs["attachments"] = sdk_attachments
                for raw in agent.stream(user_text, **stream_kwargs):
                    for ev in translate_event(raw):
                        if ev.get("type") == "permission":
                            ev = self._handle_permission_ask(raw, ev)
                        yield ev
            except Exception as e:
                # A mid-stream SDK failure (network drop, 401, internal error) must
                # still surface to the UI: fetch won't reject on a half-closed body,
                # so without this the user gets a silent partial answer.
                errored = True
                yield {"type": "error", "content": f"代理执行出错：{e}"}

            # Artifacts: the SDK emits file/image_generated after its loop breaks, so
            # they never reach the stream. Diff the output dir instead. Skip on crash
            # so we don't report half-written files as deliverables.
            if not errored:
                for ev in self._diff_outputs(before):
                    yield ev
            yield {"type": "done"}
        finally:
            # A client disconnect raises GeneratorExit here (Flask closes the
            # response). Set the abort signal so the SDK run stops at its next
            # boundary instead of leaking an orphaned run that keeps burning
            # tokens and writing files the user never sees. Harmless on normal
            # completion — the next stream() clears it.
            if abort is not None and acquired:
                abort.set()
            if stream_lock is not None and acquired:
                stream_lock.release()
