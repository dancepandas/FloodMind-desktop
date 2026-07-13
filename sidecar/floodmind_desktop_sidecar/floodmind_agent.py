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

import os
import sys
import threading
from typing import Iterator

from .agent import Message

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
        # Imported lazily so translate_event stays unit-testable without the SDK.
        from floodmind.agent.native.model_client import ModelClient

        self._llm = ModelClient.from_settings()
        # Auto-approve by default; ASK-policy tools are handled in stream().
        self._permission_handler = permission_handler or (lambda tool_name, tool_input: True)
        self._workspace_manager = workspace_manager
        # Output dir captured during _set_workspace; used by the artifact diff.
        self._output_dir = None
        # Pause signal: set by pause(), polled by the SDK's abort_check during a
        # run. The executor aborts at the next LLM/tool boundary, discards the
        # partial round (not written to memory), and the next stream() resumes
        # from memory. Cleared at the start of each stream().
        self._abort = threading.Event()
        # The SDK's executor captures `memory` BY REFERENCE at construction
        # (NativeAgentExecutor(memory=self.memory)), so swapping self.memory later
        # is invisible to it. Per-workspace isolation therefore requires building
        # a whole new agent (→ new executor → new memory), not an attribute swap.
        # Seed the initial memory session from a workspace persisted across a
        # restart, so it matches the session _set_workspace will use on first run.
        from .workspace import session_id_for

        persisted = workspace_manager.current_path() if workspace_manager else None
        initial_sid = session_id_for(persisted) if persisted else "desktop-default"
        self._agent = self._build_agent(*self._memory_target(initial_sid))

        # Apply user-disabled skills persisted in settings.json.
        try:
            from .catalog_api import apply_skills_disabled
            apply_skills_disabled()
        except Exception as e:
            print(f"[sidecar] apply disabled skills failed: {e}", file=sys.stderr)

    def _build_agent(self, session_id: str, persist_dir: str):
        """Construct a fresh SDK agent bound to a per-session DualMemory."""
        from floodmind.agent import create_flood_agent
        from floodmind.config.settings import get_config
        from floodmind.memory.dual_memory import DualMemory

        m = (get_config() or {}).get("model", {}) or {}
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

        return create_flood_agent(
            llm_service=self._llm,
            memory=memory,
            session_id=session_id,
            permission_handler=self._permission_handler,
            max_iterations=50,
            enable_reasoning=bool(m.get("enableReasoning", False)),
            enable_search=bool(m.get("enableSearch", False)),
            system_prompt=system_prompt,
        )

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

    # ── permission: unblock ASK-policy tools without a UI round-trip ──
    def _auto_approve(self, raw: dict) -> None:
        """Respond approve to a permission_ask so the agent doesn't busy-wait.

        exit_plan_mode / UpdateProjectInstructions carry an ASK policy that the
        synchronous permission_handler cannot satisfy (returning True does not
        short-circuit ASK). Inject the approval directly via AskService.respond.
        """
        ask_id = raw.get("ask_id")
        session_id = raw.get("session_id")
        if not ask_id or not session_id:
            return
        try:
            from floodmind.agent.runtime.contracts.permissions import PermissionAskResponse
            from floodmind.agent.runtime.services.ask_service import get_ask_service

            get_ask_service().respond(
                PermissionAskResponse(session_id=session_id, ask_id=ask_id, approved=True)
            )
        except Exception as e:
            print(f"[sidecar] auto-approve failed for ask {ask_id}: {e}", file=sys.stderr)

    # ── memory: per-workspace isolation + New Session ──────────
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
            self._agent = self._build_agent(session_id, persist_dir)
        except Exception as e:
            print(f"[sidecar] workspace memory rebind failed for {path}: {e}", file=sys.stderr)

    def clear_memory(self) -> None:
        # In-place clear is sufficient: NativeFloodAgent.clear_memory() clears
        # self.memory, which is the very same object the executor holds.
        try:
            if hasattr(self._agent, "clear_memory"):
                self._agent.clear_memory()
        except Exception as e:
            print(f"[sidecar] clear_memory failed: {e}", file=sys.stderr)

    def reload_model(self) -> bool:
        """Re-read model settings and rebuild the agent so config changes apply.

        Reuses the current session id + its persist_dir, so conversation memory
        is reloaded from disk (no history loss).

        NOTE: ModelClient.from_settings() reads a module-level `settings` singleton
        that is frozen at import — save_config() only clears the *dict* cache, not
        the singleton. So we derive the new values from the freshly-saved config
        (get_config() IS refreshed) and pass them explicitly to from_settings,
        which accepts overrides. Without this the headline "switch model" feature
        would silently keep the old model.
        """
        try:
            from floodmind.agent.native.model_client import ModelClient
            from floodmind.config.settings import get_config

            sid = self._agent.session_id
            _, persist_dir = self._memory_target(sid)

            cfg = get_config() or {}
            m = cfg.get("model", {}) or {}
            provider = m.get("provider", "")
            opts = ((cfg.get("provider", {}) or {}).get(provider, {}) or {}).get("options", {}) or {}
            self._llm = ModelClient.from_settings(
                api_key=opts.get("apiKey") or None,
                base_url=opts.get("baseURL") or None,
                model_name=m.get("model") or None,
                temperature=m.get("temperature"),
                max_tokens=m.get("maxTokens"),
                enable_thinking=bool(m.get("enableReasoning", False)),
            )
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
            sid = self._agent.session_id
            _, persist_dir = self._memory_target(sid)
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
        """LLM-generate a short Chinese title (mirrors the SDK server-layer prompt).

        Uses a dedicated low-temperature ModelClient; '' on any failure so callers
        can keep a fallback title.
        """
        import re
        try:
            from floodmind.agent.native.model_client import ModelClient

            llm = ModelClient.from_settings(temperature=0.2, max_tokens=60, enable_thinking=False)
            prompt = (
                "请根据用户问题拟一个简短的中文会话标题，用于左侧历史会话列表展示。"
                "要求：10到18个字，突出任务目标，不要带引号，不要解释，不要句号。\n\n"
                f"用户问题：{message}"
            )
            result = llm.invoke(prompt)
            if result is None or not hasattr(result, "content"):
                return ""
            raw = (getattr(result, "content", "") or "").strip()
            title = raw.splitlines()[0].strip().strip('"""')
            title = re.sub(r"^[#\-*\d.\s]+", "", title).strip()
            return title[:24] if title else ""
        except Exception as e:
            print(f"[sidecar] generate_title failed: {e}", file=sys.stderr)
            return ""

    # ── main entry ─────────────────────────────────────────────
    def stream(self, messages: list[Message]) -> Iterator[dict]:
        user_text = messages[-1]["content"] if messages else ""
        # Fresh run: clear any stale pause signal, then let the SDK poll
        # self._abort.is_set as its abort_check. (_abort is created in __init__;
        # the getattr guard keeps the unit tests' bare __new__ instances working.)
        abort = getattr(self, "_abort", None)
        if abort is not None:
            abort.clear()
        abort_check = abort.is_set if abort is not None else None
        before: dict[str, float] = {}
        errored = False
        try:
            self._set_workspace()
            before = self._snapshot_outputs()
            # Pass abort_check only when armed (production always sets _abort in
            # __init__). Test stubs mimic the SDK stream() signature optionally,
            # so we avoid forcing the kwarg on them.
            stream_kwargs = {"abort_check": abort_check} if abort_check is not None else {}
            for raw in self._agent.stream(user_text, **stream_kwargs):
                for ev in translate_event(raw):
                    if ev.get("type") == "permission":
                        # Unblock ASK-policy tools before yielding the ask to the UI.
                        self._auto_approve(raw)
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
