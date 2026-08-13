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
import time
from typing import Iterator

from .agent import Message
from .permissions import (
    PENDING_ASKS,
    PermissionCache,
    PermissionMode,
    permission_fingerprint,
)

# SDK v1.0.1's ToolExecutionService copies contextvars inside the SDK-owned
# executor path, so the desktop no longer replaces ThreadPoolExecutor globally.
# Keep workspace/session binding explicit in _set_workspace() instead of applying
# a process-wide monkey patch that would affect Flask and third-party libraries.


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


def _register_mcp_persist_listener():
    """Persist runtime-loaded MCPs via the SDK pool lifecycle hook.

    This keeps durability + desktop menu visibility in the product layer without
    monkey-patching ``McpClientPool.connect_server``.
    """
    try:
        from floodmind.agent.mcp_client import get_mcp_client_pool
    except Exception:
        return

    def _on_server_connected(server_config: dict, _conn) -> None:
        try:
            _persist_runtime_mcp(server_config)
        except Exception as e:
            print(f"[sidecar] runtime MCP persist hook error: {e}", file=sys.stderr)

    try:
        get_mcp_client_pool().add_server_connected_listener(_on_server_connected)
    except Exception:
        return


_register_mcp_persist_listener()


# Module-level holder for the work mode of the currently-running foreground
# stream. The SDK runs the agent loop in a child thread, so a plain mutable
# holder (not a contextvar, which is unreliable across the SDK thread) is read
# by the permission hook at tool-call time. Streams are serialized by
# _stream_lock, so a single holder is safe.
_CURRENT_MODE: dict[str, str] = {"mode": "craft"}

# After a pause, the SDK run can only abort at its next LLM/tool boundary — if
# that LLM call is slow, the stream lock stays held. A new request waits up to
# this long for the lock to free instead of failing the post-pause resume.
_LOCK_WAIT_AFTER_PAUSE_MS = 15000


def _permission_decision_hook(tool_name, tool_input, sdk_decision, permission_policy):
    """Desktop permission policy as an SDK host-level hook (v1.1.0).

    Replaces the old ``_patch_tool_policies_for_desktop_permission`` monkey patch
    of ``check_permissions_fn``. The SDK runs its base permission decision
    (path/danger/planning hard gates) first, then calls us. We upgrade
    ALLOW → ASK so every non-readonly tool hits the desktop's three-tier
    authorization (always-trust / trust-once / always-ask). DENY and
    readonly/internal/ask policies pass through unchanged; the SDK's monotonic
    guard independently prevents any loosening, so returning ASK is always safe.

    In Ask mode every tool call is DENYed (the SDK's bare agent still exposes
    the catalog-browser SearchTools/GetTool, so even with ``tools=[]`` the model
    can see them — this backstop guarantees nothing executes). In Plan mode the
    agent runs the full runtime so the model can call the plan tools
    (``create_plan``/``update_plan`` are ``readonly`` policy) and read files to
    inform the plan, while every execution tool stays DENYed.
    """
    from floodmind.agent.runtime.contracts.permissions import (
        PermissionBehavior,
        PermissionDecision,
    )

    mode = _CURRENT_MODE.get("mode", "craft")
    if mode != "craft":
        policy_type = getattr(permission_policy, "policy_type", None) if permission_policy else None
        if mode == "ask":
            return PermissionDecision(
                behavior=PermissionBehavior.DENY,
                reason="当前「问答」模式不允许调用工具",
            )
        # plan：只放行只读/内部（create_plan、update_plan、文件读取），
        # 一切写/执行/网络/审批类工具全部 DENY。
        if policy_type in ("readonly", "internal"):
            return sdk_decision
        return PermissionDecision(
            behavior=PermissionBehavior.DENY,
            reason="当前「计划」模式只允许制定计划，不允许执行",
        )

    policy_type = getattr(permission_policy, "policy_type", None) if permission_policy else None
    if policy_type in ("readonly", "internal", "ask"):
        return sdk_decision
    if getattr(sdk_decision, "behavior", None) == PermissionBehavior.DENY:
        return sdk_decision
    return PermissionDecision(
        behavior=PermissionBehavior.ASK,
        reason=f"需要用户确认此操作（{tool_name}）",
    )


# Per-mode system-prompt appendices. Craft (default) keeps the plain workspace
# prompt; Ask/Plan run on a bare no-tools agent whose prompt tells the model not
# to call tools, so the semantics hold even though the SDK still registers the
# read-only SearchTools/GetTool catalog helpers in bare mode.
_MODE_SYSTEM_PROMPTS = {
    "ask": (
        "\n\n当前处于「问答」模式：只回答用户的问题，不要调用任何工具，"
        "不要执行任何操作，直接给出回答。"
    ),
    "plan": (
        "\n\n当前处于「计划」模式：请先调用 create_plan 工具制定一份详细的执行计划"
        "（明确用户意图、预期交付物与执行步骤）。创建计划后立即以一句话结束本轮"
        "（例如『计划已创建，等待您的确认』），不要调用 exit_plan_mode，不要调用任何"
        "其他工具，不要执行或生成任何文件。执行将在用户确认后另行进行。"
    ),
}


_IMAGE_EXTS = (".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp")

# v2.0.0 BackgroundTask.status：终态集合（非终态 = starting/running/
# kill_requested/terminating）。用于判定旧 agent 是否还能释放。
_BG_TERMINAL_STATUSES = frozenset({
    "completed", "failed", "killed", "kill_failed", "orphaned",
})


def _tail_file(path, n: int = 200) -> str:
    """Read the last ``n`` lines of a file (UTF-8, errors replaced). Returns "" on any issue.

    Reads backward in bounded chunks until ``n + 1`` newline boundaries are found,
    so very long lines don't truncate the window (a fixed 64KB tail block could).
    """
    try:
        with open(path, "rb") as f:
            f.seek(0, os.SEEK_END)
            size = f.tell()
            chunk = 64 * 1024
            start = size
            newlines = 0
            need = n + 1
            while start > 0 and newlines < need:
                read_start = max(0, start - chunk)
                f.seek(read_start)
                data = f.read(start - read_start)
                start = read_start
                newlines += data.count(b"\n")
            f.seek(start)
            raw = f.read()
        # Drop the partial leading line (only counts newlines fully seen).
        lines = raw.decode("utf-8", "replace").splitlines()
        return "\n".join(lines[-n:])
    except Exception:
        return ""


def _build_artifact_event(
    path,
    *,
    output_dir=None,
    name=None,
    kind=None,
    final=True,
    source="fallback",
) -> dict:
    """Build a normalized artifact event without dropping missing paths."""
    raw_path = os.fspath(path)
    if output_dir and not os.path.isabs(raw_path):
        raw_path = os.path.join(os.fspath(output_dir), raw_path)
    normalized = os.path.abspath(os.path.normpath(raw_path))
    artifact_name = name if name is not None else os.path.basename(normalized)
    if kind is None:
        ext = os.path.splitext(artifact_name)[1].lower()
        kind = "image" if ext in _IMAGE_EXTS else "file"
    exists = os.path.isfile(normalized)
    event = {
        "type": "artifact",
        "kind": kind,
        "name": artifact_name,
        "path": normalized,
        "final": final,
        "exists": exists,
        "source": source,
    }
    if exists:
        try:
            event["size"] = os.path.getsize(normalized)
        except OSError:
            pass
    return event


_ARTIFACT_OPTIONAL_FIELDS = ("final", "exists", "size", "source")


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
        event = {"type": "artifact",
                 "kind": "image" if t == "image_generated" else "file",
                 "name": raw.get("filename", raw.get("file_name", "")),
                 "path": raw.get("image_url", raw.get("download_url", ""))}
        for field in _ARTIFACT_OPTIONAL_FIELDS:
            if field in raw:
                event[field] = raw[field]
        return [event]
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
        self._resolved_context_window = 32768  # safe fallback, updated by _resolve_llm
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
        # Retired agent wrappers still owning non-terminal background tasks.
        # The SDK's BackgroundTaskService is bound PER AGENT; when we rebuild the
        # agent (model/persona/conversation/workspace/mode switch), the old
        # wrapper's cleanup would kill its running tasks. Keep a reference so GC
        # can't collect them; prune once their tasks all become terminal.
        self._retired_agents: list = []
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

        # The mode the current _agent was built with. The persisted desktop
        # workMode seeds the first build; per-request modes in stream() override
        # it and rebuild when they differ.
        self._agent_mode = self._desktop_block().get("workMode", "craft")
        if self._agent_mode not in _MODE_SYSTEM_PROMPTS and self._agent_mode != "craft":
            self._agent_mode = "craft"

        if self._llm is not None:
            try:
                self._replace_agent(self._build_agent(*self._memory_target(initial_sid), mode=getattr(self, "_agent_mode", "craft")))
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
        Provided by the SDK MCP pool; desktop only surfaces it in the MCP UI."""
        try:
            from floodmind.agent.mcp_client import get_mcp_client_pool
            return get_mcp_client_pool().call_health()
        except Exception:
            return {}

    def _resolve_llm(self):
        """Build a ModelClient for the desktop's active model via resolve_model().

        The SDK stores no top-level model-selection block; the active model is the
        first in the catalog. The desktop records the GUI's pick under
        ``desktop.activeModel`` and resolves it here so the right provider's
        api_key/base_url are used (cross-provider switching would otherwise pick
        up the wrong credentials). Generation params come from the model's own
        definition (single source of truth).

        Also stores the resolved context_window on ``self._resolved_context_window``
        so ``_build_agent`` can pass the per-model value to DualMemory instead of a
        blanket hardcoded default.
        """
        from floodmind.agent.native.model_client import ModelClient
        from floodmind.config.model_resolver import resolve_model

        desktop = self._desktop_block()
        active = desktop.get("activeModel") or None
        provider = desktop.get("activeProvider") or None
        rm = resolve_model(model_key=active, provider_id=provider)
        self._resolved_context_window = rm.context_window
        # 推理默认随模型能力：settings 里没显式 enableReasoning 时，推理模型默认开
        #（否则 MiniMax-M3 等模型不发 thinking 增量 → 「模型思考中」指示不显示）。
        self._model_supports_reasoning = bool(getattr(rm, "supports_reasoning", False))
        enable_reasoning = bool(desktop.get("enableReasoning", self._model_supports_reasoning))
        mc = ModelClient(
            api_key=rm.api_key,
            base_url=rm.base_url,
            model_name=rm.id,
            temperature=rm.temperature,
            max_tokens=rm.max_tokens,
            enable_thinking=enable_reasoning,
            provider=rm.provider,
        )
        # 桌面端外层壳（SDK v2.0.1）：_init_model_client 读 llm_service.enable_reasoning
        # 而非 enable_thinking，会把传入的 ModelClient 重建为 enable_thinking=False。
        # 设实例属性让 SDK 正确读到思考开关；SDK 修后去掉。
        mc.enable_reasoning = enable_reasoning
        return mc

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
            self._resolved_context_window = rm.context_window
            print(f"[sidecar] falling back to first configured model: {rm.provider}/{rm.id}", file=sys.stderr)
            return ModelClient(
                api_key=rm.api_key,
                base_url=rm.base_url,
                model_name=rm.id,
                temperature=rm.temperature,
                max_tokens=rm.max_tokens,
                provider=rm.provider,
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

    def _build_workspace_for_path(self, session_id: str, path: str):
        """Build the SDK v1.0.1 folder-first workspace for a desktop path.

        User-authorized external readable paths (registered via /api/external-paths
        when a file outside the workspace is dropped/pasted) are injected as
        ``readable_roots`` — an exact file path allows reading only that file.
        ``_set_workspace`` re-runs this on every stream, so a registration made
        before the next send takes effect automatically (no live rebind).
        """
        from floodmind.agent.runtime.services.workspace_service import build_folder_workspace

        from .external_paths import read_external_paths

        return build_folder_workspace(
            session_id,
            primary_dir=path,
            readable_roots=tuple(read_external_paths(path)),
        ).ensure()

    def current_workspace_root(self) -> str:
        """Public accessor: the current workspace root (default-workspace when none open)."""
        user_dir, _sid = self._current_workspace_target()
        return user_dir

    # ── background tasks (exec_bash run_in_background) ─────────
    def _replace_agent(self, new_agent):
        """Swap the active agent, retaining the old wrapper while its background
        tasks are non-terminal (SDK cleanup would otherwise kill them)."""
        old = getattr(self, "_agent", None)
        self._agent = new_agent
        retired = getattr(self, "_retired_agents", None)
        if retired is not None and old is not None and old is not new_agent:
            retired.append(old)
            self._prune_retired_agents()

    def _bg_agents(self):
        """The active agent + retired wrappers still owning background tasks."""
        out = []
        active = getattr(self, "_agent", None)
        if active is not None:
            out.append(active)
        out.extend(getattr(self, "_retired_agents", []))
        return out

    def _prune_retired_agents(self):
        """Drop retired agents once all their tasks are terminal (frees memory,
        and lets the SDK release the processes)."""
        keep = []
        for agent in self._retired_agents:
            fn = getattr(agent, "list_background_tasks", None)
            has_active = False
            if callable(fn):
                try:
                    tasks = fn() or []
                    has_active = any(
                        isinstance(t, dict)
                        and t.get("status") not in _BG_TERMINAL_STATUSES
                        for t in tasks
                    )
                except Exception:
                    has_active = True  # 无法确认终态 → 保留，防误杀
            if has_active:
                keep.append(agent)
        self._retired_agents = keep

    def list_background_tasks(self) -> list[dict]:
        """Serialize background tasks across the active + retired agents.

        Uses the SDK v2.0.1 public ``Agent.list_background_tasks()`` (no private
        access). ``tail`` is refreshed live from the task's stdout file so a
        running task shows its current output tail, not only the completion
        snapshot.
        """
        out: list[dict] = []
        seen: set[str] = set()
        for agent in self._bg_agents():
            fn = getattr(agent, "list_background_tasks", None)
            if not callable(fn):
                continue
            try:
                tasks = fn() or []
            except Exception as e:
                print(f"[sidecar] bg list failed: {e}", file=sys.stderr)
                continue  # 单个 agent 失败不拖垮整体
            for t in tasks:
                if not isinstance(t, dict) or t.get("task_id") in seen:
                    continue
                seen.add(t.get("task_id"))
                if not t.get("tail"):
                    try:
                        t = {**t, "tail": _tail_file(t.get("stdout_path", ""), 200)}
                    except Exception:
                        pass
                out.append(t)
        return out

    def kill_background_task(self, task_id: str) -> bool:
        """Terminate a running background task across active/retired agents
        (SDK v2.0.1 public ``Agent.kill_background_task``)."""
        for agent in self._bg_agents():
            fn = getattr(agent, "kill_background_task", None)
            if not callable(fn):
                continue
            try:
                if fn(task_id):
                    return True
            except Exception as e:
                print(f"[sidecar] bg kill failed (task={task_id}): {e}", file=sys.stderr)
                continue
        return False

    def _current_workspace_target(self) -> tuple[str, str]:
        """Return (user_dir, sid) for the current desktop workspace or fallback."""
        from .workspace import _app_data_dir, session_id_for

        opened = self._workspace_manager.current_path() if self._workspace_manager else None
        if opened:
            return opened, session_id_for(opened)
        return str(_app_data_dir() / "default-workspace"), "desktop-default"

    @staticmethod
    def _agent_raw(agent):
        """Return the native SDK agent behind public Agent wrappers."""
        return getattr(agent, "raw", agent)

    def _build_agent(self, session_id: str, persist_dir: str, workspace=None, mode="craft"):
        """Construct a fresh SDK agent bound to a per-session DualMemory.

        ``mode`` selects the work mode: ``craft`` (default) uses the full runtime
        with all tools; ``ask``/``plan`` build a bare no-tools agent whose
        system prompt forbids tool use, so Ask answers directly and Plan (stage
        one) only proposes a plan.
        """
        from floodmind.memory.dual_memory import DualMemory

        # enable_reasoning / enable_search are desktop session-level toggles
        # stored under the `desktop` block (the SDK no longer persists a model
        # selection block in settings.json).
        desktop = self._desktop_block()
        enable_reasoning = bool(desktop.get("enableReasoning", getattr(self, "_model_supports_reasoning", False)))
        enable_search = bool(desktop.get("enableSearch", False))

        if mode not in _MODE_SYSTEM_PROMPTS and mode != "craft":
            mode = "craft"

        memory = DualMemory(
            session_id=session_id,
            persist_dir=persist_dir,
            llm=self._llm,
            context_window=self._resolved_context_window,
        )

        if workspace is None:
            user_dir, _fallback_sid = self._current_workspace_target()
            workspace = self._build_workspace_for_path(session_id, user_dir)

        # Desktop has an explicit workspace; tell the agent to search the whole
        # tree, not just the output/upload directory roots highlighted by the SDK
        # default system prompt.
        workspace_path = str(workspace.workspace_dir) if workspace is not None else (
            self._workspace_manager.current_path()
            if self._workspace_manager else None
        )
        if workspace_path:
            system_prompt = (
                "你是一个智能助手，使用可用工具帮助用户完成任务。\n"
                f"当前工作区是：{workspace_path}\n"
                "用户提到的文件、数据或附件可能位于工作区的任何子目录中。"
                "搜索文件时，请以该工作区根目录为 path 参数进行递归搜索（例如 Glob 的 "
                f"path='{workspace_path}', pattern='**/*.xlsx'），不要只搜索输出目录或上传目录的根。\n"
                # 附件引用引导：用户以附件引用的工作区外路径已按精确路径授权读取，
                # 直接读引用路径本身；不要推测其他位置（v1.1.5 起已装 skill 源可读）。
                "用户在 [引用文件] 中列出的路径若位于工作区外（绝对路径），已授权读取该路径（文件本身或目录整棵子树）。"
                "请只读取引用中给出的精确路径，不要推测其他位置。"
                "已安装的 skill 源文件（site-packages/skills 下）可直接读取（只读授权），"
                "也可用 GetSkill/GetTool 查看说明；不要读取 SDK 包内部源码（site-packages/floodmind 下）。\n"
                "读取文件请使用 Read/Glob 工具，不要使用 Bash（exec_bash）去查看文件内容。\n"
                "不要向引用目录（工作区外的只读授权路径）写入任何文件；需要中转/临时文件时请写入工作区。"
            )
        else:
            system_prompt = "你是一个智能助手，使用可用工具帮助用户完成任务。"
        if mode != "craft":
            system_prompt = system_prompt + _MODE_SYSTEM_PROMPTS[mode]

        from floodmind.agent import Agent

        # Public Agent full-runtime is the only construction path since SDK
        # v1.1.0; the temporary create_flood_agent() fallback was removed.
        # Ask 用 bare 无工具嵌入（只答不动手）；Plan 用完整 runtime 以便模型调用
        # create_plan/update_plan 等计划工具（执行类工具由权限 hook 拦掉）。
        bare = mode == "ask"
        agent = Agent(
            llm=self._llm,
            memory=memory,
            session_id=session_id,
            permission_handler=self._permission_handler,
            permission_decision_hook=_permission_decision_hook,
            max_iterations=50,
            enable_reasoning=enable_reasoning,
            enable_search=enable_search,
            system_prompt=system_prompt,
            workspace=workspace,
            bare=bare,
            tools=[] if bare else None,
        )
        raw_agent = self._agent_raw(agent)
        if getattr(raw_agent, "memory", None) is not memory:
            raise RuntimeError("public Agent did not preserve desktop memory")
        if getattr(raw_agent, "session_id", None) != session_id:
            raise RuntimeError("public Agent did not preserve desktop session_id")
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
        from .workspace import _app_data_dir

        self._output_dir = None
        user_dir, sid = self._current_workspace_target()

        try:
            from floodmind.tools import set_session_context

            ws = self._build_workspace_for_path(sid, user_dir)
            # Bind defensively too: agents built before this migration path (or test
            # doubles) still need an explicit workspace update. New agents should be
            # constructed with workspace=ws so their cached prompt/executors are
            # correct from the start.
            self._agent.bind_workspace(ws)
            set_session_context(
                sid,
                output_dir=str(ws.user_dir),  # legacy/default user-visible write root
                cwd=str(ws.default_cwd),
                workspace_dir=str(ws.workspace_dir),
                state_dir=str(ws.state_dir) if ws.state_dir else None,
                artifact_dir=str(ws.artifact_dir) if ws.artifact_dir else None,
                tmp_dir=str(ws.tmp_dir) if ws.tmp_dir else None,
                scripts_dir=str(ws.scripts_dir) if ws.scripts_dir else None,
            )
            # Keep the desktop fallback diff on the user-visible workspace root for
            # now; SDK artifacts are read separately from Agent.artifacts.
            self._output_dir = str(ws.user_dir)
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
        snapshot: dict[str, float] = {}
        try:
            for root, dirs, files in os.walk(output_dir):
                # Prune hidden / SDK-managed dirs (`.floodmind`, `.git`, …). They
                # hold internal state — sessions, checkpoints, memory, sandboxes —
                # which churns on every run and must never surface as "artifacts".
                dirs[:] = [d for d in dirs if not d.startswith(".")]
                for filename in files:
                    path = os.path.join(root, filename)
                    relative_path = os.path.relpath(path, output_dir)
                    try:
                        snapshot[relative_path] = os.path.getmtime(path)
                    except OSError:
                        continue
        except OSError:
            return {}
        return snapshot

    def _artifact_events_from_agent(self, agent=None) -> Iterator[dict]:
        """Yield normalized artifact events from the SDK Agent.artifacts cache.

        SDK v1.0.1 exposes post-loop artifacts via Agent.artifacts. Prefer that
        public cache over filesystem diffing, but keep diff as a fallback until the
        SDK stream/artifact contract is proven stable in all desktop scenarios.
        """
        agent = agent or getattr(self, "_agent", None)
        if agent is None:
            return
        artifacts = getattr(agent, "artifacts", None) or []
        seen: set[tuple[str, str]] = set()
        for art in artifacts:
            if not isinstance(art, dict):
                continue
            path = art.get("path") or art.get("download_url") or art.get("image_url")
            name = art.get("name") or art.get("filename") or art.get("file_name")
            if not path and not name:
                continue
            event = _build_artifact_event(
                path or name,
                name=name,
                kind=art.get("kind"),
                final=art.get("final", True),
                source=art.get("source", "sdk"),
            )
            for field in ("exists", "size"):
                if field in art:
                    event[field] = art[field]
            key = (event.get("kind", ""), event.get("path") or event.get("name", ""))
            if key in seen:
                continue
            seen.add(key)
            yield event

    def _diff_outputs(self, before: dict[str, float],
                      output_dir: str | None = None) -> Iterator[dict]:
        """Yield one artifact event per file added recursively since `before`."""
        output_dir = output_dir or getattr(self, "_output_dir", None)
        if not output_dir:
            return
        now = self._snapshot_outputs(output_dir)
        for relative_path in sorted(set(now) - set(before)):
            yield _build_artifact_event(relative_path, output_dir=output_dir)

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

        Also resolves any permission ask the executor is blocked on: the abort
        check only runs at the top of the executor's state loop, so a pending
        ``awaiting_permission`` would otherwise stall the run (and hold the
        stream lock) for the ask timeout. Denying the pending asks unblocks the
        executor so the abort fires at the next boundary.
        """
        self._abort.set()
        try:
            from .permissions import PENDING_ASKS
            from floodmind.agent.runtime.services.ask_service import get_ask_service
            from floodmind.agent.runtime.contracts.permissions import PermissionAskResponse

            svc = get_ask_service()
            for entry in PENDING_ASKS.all_pending():
                PENDING_ASKS.pop(entry["ask_id"])
                try:
                    svc.respond(PermissionAskResponse(
                        session_id=entry.get("session_id", ""),
                        ask_id=entry["ask_id"],
                        approved=False,
                    ))
                except Exception:
                    pass
        except Exception:
            pass
        # NOTE: we deliberately do NOT close the active stream generator here —
        # closing a generator running in another thread injects GeneratorExit
        # into the SDK mid-run, whose cleanup can raise OSError(EINVAL). Resolving
        # the pending asks + setting abort lets the SDK unwind at its next
        # boundary and the stream lock release on its own.

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
                self._replace_agent(self._build_agent(session_id, persist_dir, mode=getattr(self, "_agent_mode", "craft")))
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
                self._replace_agent(self._build_agent(sid, persist_dir, mode=getattr(self, "_agent_mode", "craft")))
            return True
        except Exception as e:
            print(f"[sidecar] reload_model failed: {e}", file=sys.stderr)
            return False

    def reload_persona(self) -> bool:
        """Rebuild the agent so edited SOUL.md / global AGENTS.md take effect.

        A fresh NativeFloodAgent re-reads SOUL.md via _build_stable_prompt and
        gets a new ContextRuntime (AGENTS.md TTL cache cleared). The fresh agent is
        constructed with the current folder-first Workspace, so the cached prompt
        sees the right identity + workspace on the NEXT message. History is preserved
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
                self._replace_agent(self._build_agent(sid, persist_dir, mode=getattr(self, "_agent_mode", "craft")))
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
                self._replace_agent(self._build_agent(sid, persist_dir, mode=getattr(self, "_agent_mode", "craft")))
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
        from .workspace import session_id_for
        try:
            from floodmind.tools import set_session_context

            sid = session_id_for(workspace_path)
            ws = self._build_workspace_for_path(sid, workspace_path)
            set_session_context(
                sid,
                output_dir=str(ws.user_dir),
                cwd=str(ws.default_cwd),
                workspace_dir=str(ws.workspace_dir),
                state_dir=str(ws.state_dir) if ws.state_dir else None,
                artifact_dir=str(ws.artifact_dir) if ws.artifact_dir else None,
                tmp_dir=str(ws.tmp_dir) if ws.tmp_dir else None,
                scripts_dir=str(ws.scripts_dir) if ws.scripts_dir else None,
            )
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
            # Automated/scheduled tasks always execute (craft), never ask/plan.
            agent = self._build_agent(sid, persist_dir, workspace=ws, mode="craft")
            before = self._snapshot_outputs(output_dir)
            _CURRENT_MODE["mode"] = "craft"  # hook must not block headless tools
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
                        artifacts.append({
                            key: ev[key]
                            for key in ("kind", "name", "path", *_ARTIFACT_OPTIONAL_FIELDS)
                            if key in ev
                        })
                    elif ev.get("type") == "text":
                        final_text += ev.get("content", "")
            # Prefer SDK v1.0.1's public Agent.artifacts cache; fall back to
            # output-dir diff for older/partial artifact paths.
            artifact_keys = set()
            for ev in self._artifact_events_from_agent(agent):
                events.append(ev)
                artifacts.append({
                    key: ev[key]
                    for key in ("kind", "name", "path", *_ARTIFACT_OPTIONAL_FIELDS)
                    if key in ev
                })
                artifact_keys.add((ev.get("kind"), ev.get("path") or ev.get("name")))
            for ev in self._diff_outputs(before, output_dir):
                key = (ev.get("kind"), ev.get("path") or ev.get("name"))
                if key in artifact_keys:
                    continue
                events.append(ev)
                artifacts.append({
                    key: ev[key]
                    for key in ("kind", "name", "path", *_ARTIFACT_OPTIONAL_FIELDS)
                    if key in ev
                })
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
                provider=rm.provider,
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

    def _ensure_agent_mode(self, mode: str) -> None:
        """Rebuild the agent when the requested work mode differs from the current one.

        Must be called under the foreground lock (it swaps self._agent). Session
        history reloads from disk, so a mode switch never loses the conversation.
        """
        if mode not in _MODE_SYSTEM_PROMPTS and mode != "craft":
            mode = "craft"
        if getattr(self, "_agent", None) is None:
            return
        if getattr(self, "_agent_mode", "craft") == mode:
            return
        sid = self._agent.session_id
        _, persist_dir = self._memory_target(sid)
        self._replace_agent(self._build_agent(sid, persist_dir, mode=mode))
        self._agent_mode = mode

    # ── main entry ─────────────────────────────────────────────
    # ── run event buffer (重连对账) ──────────────────────────
    def _reset_run_buffer(self) -> dict:
        """Start a fresh buffered run ledger for the active stream."""
        self._run_buffer = {"events": [], "done": False}
        return self._run_buffer

    def _append_run_event(self, ev: dict) -> None:
        buf = getattr(self, "_run_buffer", None)
        if buf is not None:
            buf["events"].append(ev)

    def _finish_run_buffer(self) -> None:
        buf = getattr(self, "_run_buffer", None)
        if buf is not None:
            buf["done"] = True

    def run_events_since(self, since: int = 0) -> tuple[list, bool]:
        """Return (buffered wire events from index ``since``, run_done).

        The active stream appends every translated event in order, so a
        reconnecting frontend can replay what it missed. No active run → empty +
        done (treated as settled)."""
        buf = getattr(self, "_run_buffer", None)
        if buf is None:
            return [], True
        return buf["events"][since:], buf["done"]

    # ── checkpoint resume (断点续跑) ─────────────────────────
    def list_checkpoints(self, session_id: str, workspace_path: str) -> list[dict]:
        """List a conversation's checkpoints, newest first.

        The SDK executor auto-writes checkpoints at loop boundaries under
        ``<workspace>/.floodmind/sessions/<session_id>/checkpoints/``. Returns
        CheckpointSummary dicts (checkpoint_id/status/iteration/created_at/
        has_files_snapshot). Empty on any error — a missing dir or bad session
        must never 500 the UI.
        """
        from pathlib import Path
        from floodmind.agent.runtime.services.checkpoint_service import CheckpointService

        base_dir = str(Path(workspace_path) / ".floodmind" / "sessions")
        try:
            svc = CheckpointService(base_dir=base_dir)
            records = svc.list(session_id)
            records.sort(key=lambda r: r.created_at, reverse=True)
            return [r.model_dump(mode="json") for r in records]
        except Exception as e:
            print(f"[sidecar] list_checkpoints failed: {e!r}", file=sys.stderr)
            return []

    def resume_stream(self, checkpoint_id: str, user_message: str = "") -> Iterator[dict]:
        """Resume an interrupted run from a checkpoint, streaming legacy events.

        ``agent.resume()`` is synchronous — it drives the executor's
        ``run_from_state`` to completion. We run it on a background thread and
        capture the executor's event_bus in real-time, so the resumed run streams
        like a normal chat: thinking/text/tool deltas, live permission asks,
        then artifacts + done. On client disconnect the generator's finally joins
        the thread, so the resumed run finishes before the foreground lock is
        released (only one run may mutate the shared agent at a time).
        """
        import queue as _queue
        import threading

        stream_lock = getattr(self, "_stream_lock", None)
        acquired = stream_lock.acquire(blocking=False) if stream_lock is not None else True
        abort = getattr(self, "_abort", None)
        try:
            if not acquired:
                yield {"type": "error", "content": "已有任务正在执行，请等待当前任务结束。"}
                yield {"type": "done"}
                return
            if abort is not None:
                abort.clear()
            if getattr(self, "_agent", None) is None:
                yield {"type": "error", "content": "模型未配置，请先在左侧「设置」中配置 API Key 后保存。"}
                yield {"type": "done"}
                return

            with self._fg():
                # Bind the workspace (also sets _output_dir for artifact diffing)
                # and capture the agent reference so a concurrent rebind can't
                # swap it mid-resume.
                self._set_workspace()
                agent = self._agent
            raw = self._agent_raw(agent)
            executor = getattr(raw, "_orchestrator_executor", None)
            bus = getattr(executor, "event_bus", None) if executor is not None else None
            if bus is None:
                yield {"type": "error", "content": "该会话不支持从检查点恢复（缺少执行器）。"}
                yield {"type": "done"}
                return

            before = self._snapshot_outputs()
            q: _queue.Queue = _queue.Queue()
            _SENTINEL = object()

            def _listener(ev):
                q.put(ev)

            bus.add_listener(_listener)
            outcome: dict = {}

            def _run():
                try:
                    outcome["final"] = agent.resume(checkpoint_id, user_message)
                except Exception as e:  # noqa: BLE001
                    outcome["error"] = e
                finally:
                    q.put(_SENTINEL)

            thread = threading.Thread(target=_run, daemon=True)
            thread.start()

            errored = False
            try:
                while True:
                    try:
                        ev = q.get(timeout=0.5)
                    except _queue.Empty:
                        if not thread.is_alive() and "error" not in outcome:
                            break
                        continue
                    if ev is _SENTINEL:
                        break
                    for wire in translate_event(ev):
                        if wire.get("type") == "permission":
                            wire = self._handle_permission_ask(ev, wire)
                        yield wire
            except Exception as e:  # noqa: BLE001
                import traceback
                print(f"[sidecar] resume_stream exception: {e!r}\n{traceback.format_exc()}", file=sys.stderr)
                errored = True
                yield {"type": "error", "content": f"恢复执行出错：{e}"}
            finally:
                bus.remove_listener(_listener)
                # Client disconnect (GeneratorExit) unwinds here: wait for the
                # resume to finish before releasing the foreground lock.
                thread.join()

            if not errored and "error" in outcome:
                err = outcome["error"]
                print(f"[sidecar] resume failed: {err!r}", file=sys.stderr)
                yield {"type": "error", "content": f"恢复执行出错：{err}"}

            if not errored:
                for ev in self._artifact_events_from_agent(agent):
                    yield ev
                for ev in self._diff_outputs(before):
                    yield ev
            yield {"type": "done"}
        finally:
            if stream_lock is not None and acquired:
                stream_lock.release()

    def stream(self, messages: list[Message], attachments: list | None = None, mode="craft") -> Iterator[dict]:
        # Serialize foreground chats: only one /api/chat run at a time. The
        # shared self._agent + the process-global session context mean two
        # concurrent streams could otherwise cross-bind workspaces. Acquire the
        # stream lock non-blocking so a second request fails fast instead of
        # queueing behind a (possibly long) run. getattr guard keeps bare
        # __new__ test instances working (no _stream_lock attribute set).
        stream_lock = getattr(self, "_stream_lock", None)
        acquired = stream_lock.acquire(blocking=False) if stream_lock is not None else True
        abort = getattr(self, "_abort", None)
        # True once the detached run thread starts; that thread owns the lock
        # release, so the outer finally only releases for early error paths.
        run_thread_started = False
        try:
            if not acquired:
                # After a pause the previous run is still unwinding: the SDK can
                # only abort at an LLM/tool boundary, so if the current LLM call
                # is slow the lock is held for a while. When a pause was requested
                # (abort set), wait briefly for the lock instead of failing the
                # post-pause resume immediately.
                paused = abort is not None and abort.is_set()
                if paused:
                    waited_ms = 0
                    while waited_ms < _LOCK_WAIT_AFTER_PAUSE_MS:
                        time.sleep(0.2)
                        waited_ms += 200
                        if stream_lock is not None:
                            acquired = stream_lock.acquire(blocking=False)
                            if acquired:
                                break
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
            agent = None
            try:
                # Bind workspace + capture the agent reference under the
                # foreground lock so a concurrent rebind/reload can't swap
                # self._agent mid-bind. The (long) iteration then runs without
                # the lock, against the locally-captured agent — an in-flight
                # rebuild leaves this stream iterating the old agent, exactly
                # as the rebind docstring promises.
                with self._fg():
                    # Rebuild when the requested work mode differs from the
                    # current agent's mode (session history reloads from disk).
                    self._ensure_agent_mode(mode)
                    # Publish the mode to the permission hook (read at tool-call
                    # time in the SDK thread) so Ask/Plan block every tool.
                    _CURRENT_MODE["mode"] = mode
                    self._set_workspace()
                    agent = self._agent
                    before = self._snapshot_outputs()
            except Exception as e:
                # A workspace/bind failure before the run starts must surface as
                # an error event instead of a broken stream. No run thread was
                # started, so the outer finally releases the lock.
                import traceback
                print(f"[sidecar] stream bind exception: {e!r}\n{traceback.format_exc()}", file=sys.stderr)
                yield {"type": "error", "content": f"准备执行出错：{e}"}
                yield {"type": "done"}
                return

            # Pass abort_check only when armed (production always sets _abort
            # in __init__). Test stubs mimic the SDK stream() signature
            # optionally, so we avoid forcing the kwarg on them.
            stream_kwargs = {"abort_check": abort_check} if abort_check is not None else {}
            if sdk_attachments:
                stream_kwargs["attachments"] = sdk_attachments

            # 重连对账：run 在后台线程执行，事件按序缓冲到 _run_buffer；
            # 本 generator 轮询缓冲下发。客户端断连不 abort——run 继续跑完、
            # 锁由 run 线程完成时释放；前端可经 /api/chat/events?since=N 补拉。
            import threading

            run_buffer = self._reset_run_buffer()

            def _run():
                try:
                    for raw in agent.stream(user_text, **stream_kwargs):
                        for ev in translate_event(raw):
                            if ev.get("type") == "permission":
                                ev = self._handle_permission_ask(raw, ev)
                            self._append_run_event(ev)
                    print(f"[sidecar] stream: SDK loop ended {time.time():.3f}", file=sys.stderr)
                    # Prefer the public Agent.artifacts cache; fall back to
                    # output-dir diff for older/partial artifact paths.
                    artifact_keys = set()
                    for ev in self._artifact_events_from_agent(agent):
                        self._append_run_event(ev)
                        artifact_keys.add((ev.get("kind"), ev.get("path") or ev.get("name")))
                    for ev in self._diff_outputs(before):
                        key = (ev.get("kind"), ev.get("path") or ev.get("name"))
                        if key in artifact_keys:
                            continue
                        self._append_run_event(ev)
                except Exception as e:
                    # A mid-stream SDK failure (network drop, 401, internal
                    # error) must still surface to the UI: fetch won't reject
                    # on a half-closed body, so without this the user gets a
                    # silent partial answer.
                    import traceback
                    print(f"[sidecar] stream exception: {e!r}\n{traceback.format_exc()}", file=sys.stderr)
                    self._append_run_event({"type": "error", "content": f"代理执行出错：{e}"})
                finally:
                    self._append_run_event({"type": "done"})
                    self._finish_run_buffer()
                    # The run thread owns the lock lifecycle: the request thread
                    # never releases it, so a detached (disconnected) run still
                    # serializes correctly until it completes.
                    if stream_lock is not None and acquired:
                        print(f"[sidecar] stream: releasing lock {time.time():.3f}", file=sys.stderr)
                        stream_lock.release()

            run_thread_started = True
            threading.Thread(target=_run, daemon=True).start()

            # Poll the buffer and yield new events, then done.
            seen = 0
            while True:
                events, done = self.run_events_since(seen)
                for ev in events:
                    seen += 1
                    yield ev
                if done:
                    break
                time.sleep(0.1)
        finally:
            # Client disconnect (GeneratorExit) unwinds here. The run thread keeps
            # running in the background (buffering events for replay) and releases
            # the stream lock when the run completes — no abort needed. Early
            # error paths (before the run thread starts) release the lock here.
            if stream_lock is not None and acquired and not run_thread_started:
                stream_lock.release()
