from __future__ import annotations

import base64
import json
import os
import re
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from flask import Flask, Response, jsonify, request
from flask_cors import CORS

from .agent import Agent, Message
from . import __version__


def _first_user_text(turns: list) -> str:
    """First user-message content in a turn pair (for title generation).

    Strips a leading ``[已附图片：…]`` marker the client prefixes onto stored
    user turns that carried images, so it doesn't pollute the LLM title."""
    for t in turns or []:
        if isinstance(t, dict) and t.get("role") == "user":
            text = str(t.get("content", ""))
            return re.sub(r"^\[已附图片：[^\]]*\]\s*\n?", "", text)
    return ""


# ── feedback hardening (I3) ────────────────────────────────────
# Bound the on-disk footprint of user-submitted feedback and scrub obvious
# secrets out of any attached logs before persisting, so a feedback file can be
# shared/diagnosed without leaking API keys or bearer tokens.
FEEDBACK_MAX_DESCRIPTION = 8000
FEEDBACK_MAX_CONTACT = 320
FEEDBACK_MAX_LOG_ENTRIES = 200
FEEDBACK_MAX_LOG_BYTES = 256 * 1024

# Each pattern either has a leading capture group (the label, kept) followed by
# the secret, or matches the bare secret. The replacer keeps the label and
# substitutes "[REDACTED]" for the credential itself.
_SECRET_PATTERNS = [
    re.compile(r"sk-[A-Za-z0-9_\-]{16,}"),
    re.compile(r"(?i)(authorization\s*[:=]\s*bearer\s+)[A-Za-z0-9._\-]+"),
    re.compile(r"(?i)(api[_\-]?key\s*[:=]\s*[\"']?)[A-Za-z0-9_\-]{12,}"),
    re.compile(r"(?i)(token\s*[:=]\s*[\"']?)[A-Za-z0-9_\-]{20,}"),
    re.compile(r"(?i)(secret\s*[:=]\s*[\"']?)[A-Za-z0-9_\-]{12,}"),
]


def _scrub_secrets(text: str) -> str:
    for pat in _SECRET_PATTERNS:
        text = pat.sub(
            lambda m: (m.group(1) + "[REDACTED]") if m.groups() else "[REDACTED]",
            text,
        )
    return text


def _sanitize_logs(logs: Any) -> list[dict] | None:
    """Cap log volume and scrub secrets from each message. Returns None if not a list."""
    if not isinstance(logs, list):
        return None
    out: list[dict] = []
    total = 0
    for entry in logs[-FEEDBACK_MAX_LOG_ENTRIES:]:
        if isinstance(entry, dict):
            clean = dict(entry)
            clean["message"] = _scrub_secrets(str(clean.get("message", "")))
        else:
            clean = {"message": _scrub_secrets(str(entry))}
        total += len(clean.get("message", ""))
        if total > FEEDBACK_MAX_LOG_BYTES:
            break
        out.append(clean)
    return out


def create_app(agent: Agent, workspace_manager=None, conversation_store=None,
               task_runtime=None, task_index=None,
               task_run_store=None, task_runner=None, start_runner=True) -> Flask:
    app = Flask(__name__)

    # Clear clipboard-image staging orphans left by a previous session.
    try:
        from .attachments import cleanup_staging
        from .workspace import _app_data_dir
        cleanup_staging(_app_data_dir() / "image-staging")
    except Exception as e:  # pragma: no cover - never block startup over cleanup
        print(f"[sidecar] image-staging cleanup failed: {e}", file=sys.stderr)

    # The Tauri WebView and the sidecar are different origins, so a POST with
    # Content-Type: application/json triggers a CORS preflight and the GETs need
    # an Access-Control-Allow-Origin echo. Restrict to the Tauri webview origins
    # only — never a wildcard ("*"), which would let any website the user visits
    # POST to every endpoint. NB: Tauri 2 on Windows uses http://tauri.localhost
    # (Tauri 1 used https://), macOS/Linux use tauri://localhost, and dev runs
    # on the Vite port — match all of them via one regex.
    CORS(app, resources={r"/api/*": {"origins": r"^(https?://tauri\.localhost|tauri://localhost|https?://(localhost|127\.0\.0\.1)(:\d+)?)$"}})

    if conversation_store is None:
        from .workspace import _app_data_dir
        from .conversation_store import ConversationStore
        conversation_store = ConversationStore(_app_data_dir())

    if task_runtime is None:
        from floodmind.agent.scheduled_task_runtime import get_scheduled_task_runtime
        task_runtime = get_scheduled_task_runtime()
    if task_index is None:
        from .task_index import TaskIndex
        from .workspace import _app_data_dir
        task_index = TaskIndex(_app_data_dir())
    if task_run_store is None:
        from .task_run_store import TaskRunStore
        from .workspace import _app_data_dir
        task_run_store = TaskRunStore(_app_data_dir())
    if task_runner is None and start_runner:
        from .scheduled_runner import ScheduledRunner
        task_runner = ScheduledRunner(task_runtime, task_index, task_run_store, agent)
        task_runner.start()

    @app.get("/api/health")
    def health():
        return jsonify({"status": "ok", "version": __version__})

    @app.post("/api/chat")
    def chat():
        body = request.get_json(silent=True) or {}
        messages: list[Message] = body.get("messages", [])
        # Images are single-turn only — only /api/chat reads attachments; the
        # /api/chat/append steering path stays text-only. None when absent so
        # stream()'s `if attachments:` guard skips the normalize path entirely.
        attachments = body.get("attachments") or None
        # Per-request work mode (craft/ask/plan). The sidecar rebuilds the agent
        # when the requested mode differs from the current one.
        mode = body.get("mode", "craft")
        if not messages:
            return jsonify({"error": "messages must be a non-empty list"}), 400

        def generate():
            gen = agent.stream(messages, attachments=attachments, mode=mode)
            try:
                for event in gen:
                    yield json.dumps(event, ensure_ascii=False) + "\n"
            finally:
                # On client disconnect Werkzeug throws GeneratorExit into this
                # generator; close the underlying agent stream so its abort
                # signal fires promptly instead of leaking a running SDK agent.
                gen.close()

        return Response(generate(), mimetype="application/x-ndjson")

    @app.get("/api/chat/events")
    def chat_events():
        """重连对账：按游标返回当前 run 缓冲的 wire 事件（from index ``since``）。"""
        try:
            since = int(request.args.get("since", 0))
        except ValueError:
            return jsonify({"error": "since must be an int"}), 400
        events, done = agent.run_events_since(since)
        return jsonify({"events": events, "done": done})

    @app.post("/api/chat/append")
    def chat_append():
        """Append an instruction to the running agent (mid-run steering / queue).

        The frontend calls this when a stream is already active. The SDK executor
        picks the new message up at the next iteration (steering) or revives at
        terminal state (queued follow-up). Returns 202 regardless — the effects
        arrive over the still-open /api/chat stream, not this response.
        """
        body = request.get_json(silent=True) or {}
        messages: list[Message] = body.get("messages", [])
        text = messages[-1].get("content", "") if messages else body.get("text", "")
        if not text or not str(text).strip():
            return jsonify({"error": "text must be non-empty"}), 400
        agent.append_instruction(str(text))
        return jsonify({"status": "queued"}), 202

    @app.post("/api/chat/pause")
    def chat_pause():
        """Pause the running agent: abort at the next LLM/tool boundary.

        The partial round is discarded (not written to memory). The frontend
        stops reading the stream; the next /api/chat send resumes from memory.
        """
        agent.pause()
        return jsonify({"status": "paused"})

    @app.post("/api/chat/resume")
    def chat_resume():
        """Resume an interrupted run from a checkpoint (断点续跑).

        Streams the resumed run as NDJSON (same wire dialect as /api/chat):
        thinking/text/tool deltas, live permission asks, then artifacts + done.
        """
        body = request.get_json(silent=True) or {}
        checkpoint_id = body.get("checkpoint_id", "")
        if not checkpoint_id:
            return jsonify({"error": "checkpoint_id required"}), 400
        user_message = body.get("user_message", "") or ""

        def generate():
            gen = agent.resume_stream(checkpoint_id, user_message)
            try:
                for event in gen:
                    yield json.dumps(event, ensure_ascii=False) + "\n"
            finally:
                gen.close()

        return Response(generate(), mimetype="application/x-ndjson")

    @app.get("/api/permissions")
    def permissions_get():
        from .config_api import read_permissions_config
        try:
            return jsonify(read_permissions_config())
        except Exception as e:  # pragma: no cover - defensive
            return jsonify({"error": str(e)}), 500

    @app.post("/api/permissions")
    def permissions_set():
        from .config_api import write_permissions_config
        body = request.get_json(silent=True) or {}
        try:
            snapshot = write_permissions_config(body)
        except Exception as e:  # pragma: no cover - defensive
            return jsonify({"error": str(e)}), 500
        try:
            agent.set_permission_mode(snapshot.get("mode", "trust-once"))
        except Exception as e:  # pragma: no cover - defensive
            app.logger.warning("agent.set_permission_mode failed: %s", e)
        return jsonify({"ok": True, "permissions": snapshot})

    @app.get("/api/work-mode")
    def work_mode_get():
        from .config_api import read_work_mode_config
        try:
            return jsonify(read_work_mode_config())
        except Exception as e:  # pragma: no cover - defensive
            return jsonify({"error": str(e)}), 500

    @app.post("/api/work-mode")
    def work_mode_set():
        from .config_api import write_work_mode_config
        body = request.get_json(silent=True) or {}
        try:
            snapshot = write_work_mode_config(body)
        except Exception as e:  # pragma: no cover - defensive
            return jsonify({"error": str(e)}), 500
        return jsonify({"ok": True, "work_mode": snapshot})

    @app.post("/api/permission/respond")
    def permission_respond():
        body = request.get_json(silent=True) or {}
        ask_id = body.get("ask_id", "")
        approved = bool(body.get("approved", False))
        if not ask_id:
            return jsonify({"error": "需要提供 ask_id"}), 400
        result = agent.respond_to_permission_ask(ask_id, approved)
        if "error" in result:
            return jsonify(result), 400
        return jsonify(result)



    @app.post("/api/session/reset")
    def session_reset():
        """New Session: forget conversation history so the next turn starts clean."""
        try:
            agent.clear_memory()
        except Exception as e:  # pragma: no cover - defensive
            return jsonify({"ok": False, "error": str(e)}), 500
        return jsonify({"ok": True})

    # ── Conversations (per-workspace history) ─────────────────
    @app.get("/api/conversations")
    def conversations_list():
        ws = request.args.get("workspace", "")
        return jsonify({"conversations": conversation_store.list(ws)})

    @app.post("/api/conversations")
    def conversations_create():
        body = request.get_json(silent=True) or {}
        ws = body.get("workspace", "")
        if not ws:
            return jsonify({"error": "workspace required"}), 400
        rec = conversation_store.create(ws)
        try:
            agent.activate_conversation(rec["session_id"])
        except Exception as e:  # pragma: no cover - defensive
            app.logger.warning("activate_conversation failed: %s", e)
        return jsonify(rec)

    @app.get("/api/conversations/<conv_id>")
    def conversations_get(conv_id):
        rec = conversation_store.get(conv_id)
        if rec is None:
            return jsonify({"error": "未找到"}), 404
        return jsonify(rec)

    @app.get("/api/conversations/<conv_id>/checkpoints")
    def conversation_checkpoints(conv_id):
        """List the conversation's checkpoints (for 断点续跑), newest first."""
        rec = conversation_store.get(conv_id)
        if rec is None:
            return jsonify({"error": "未找到"}), 404
        session_id = rec.get("session_id", "")
        workspace = rec.get("workspace", "")
        if not session_id or not workspace:
            return jsonify({"checkpoints": []})
        return jsonify({"checkpoints": agent.list_checkpoints(session_id, workspace)})

    @app.post("/api/conversations/<conv_id>/activate")
    def conversations_activate(conv_id):
        rec = conversation_store.get(conv_id)
        if rec is None:
            return jsonify({"error": "未找到"}), 404
        try:
            agent.activate_conversation(rec["session_id"])
            conversation_store.set_active(rec["workspace"], conv_id)
        except Exception as e:  # pragma: no cover - defensive
            app.logger.warning("activate failed: %s", e)
        return jsonify({"ok": True})

    @app.post("/api/conversations/<conv_id>/turns")
    def conversations_append_turns(conv_id):
        body = request.get_json(silent=True) or {}
        turns = body.get("turns") or []
        rec = conversation_store.append_turns(conv_id, turns)
        if rec is None:
            return jsonify({"error": "未找到"}), 404
        # First-turn title generation: run synchronously so the UI can show the
        # generated title immediately. Swallow failures so persistence never breaks.
        if len(rec.get("turns", [])) <= len(turns):
            user_text = _first_user_text(turns)
            if user_text:
                try:
                    title = agent.generate_title(user_text)
                    if title:
                        conversation_store.update_title(conv_id, title)
                        rec["title"] = title
                except Exception as e:  # pragma: no cover - defensive
                    print(f"[sidecar] title apply failed: {e}", file=sys.stderr)
        return jsonify({"ok": True, "title": rec.get("title", "")})

    @app.delete("/api/conversations/<conv_id>")
    def conversations_delete(conv_id):
        session_id = conversation_store.delete(conv_id)
        if session_id is None:
            return jsonify({"error": "未找到"}), 404
        return jsonify({"ok": True})

    @app.get("/api/conversations/<conv_id>/model")
    def conversation_model_get(conv_id):
        from .conversation_meta import read_conversation_model
        try:
            return jsonify({"model": read_conversation_model(conv_id)})
        except Exception as e:  # pragma: no cover - defensive
            return jsonify({"error": str(e)}), 500

    @app.put("/api/conversations/<conv_id>/model")
    def conversation_model_set(conv_id):
        from .conversation_meta import write_conversation_model
        body = request.get_json(silent=True) or {}
        provider = str(body.get("provider", "")).strip()
        model = str(body.get("model", "")).strip()
        if not provider or not model:
            return jsonify({"error": "provider and model required"}), 400
        try:
            bound = write_conversation_model(conv_id, provider, model)
        except ValueError as e:
            return jsonify({"error": str(e)}), 400
        except Exception as e:  # pragma: no cover - defensive
            return jsonify({"error": str(e)}), 500
        return jsonify({"ok": True, "model": bound})

    # ── Scheduled tasks ───────────────────────────────────────
    @app.get("/api/scheduled-tasks")
    def scheduled_tasks_list():
        ws = request.args.get("workspace", "")
        tasks = task_runtime.list_tasks("")
        if ws:
            index = task_index.all()
            # Agent-created tasks (via the ScheduleTask tool inside an agent
            # conversation) live in the SDK runtime but were never written to the
            # desktop's per-workspace index — they'd be invisible in the UI. The
            # frontend only queries for the active workspace, so auto-index any
            # orphaned task under it. Once indexed they survive workspace switches.
            for t in tasks:
                tid = t["id"]
                if tid not in index:
                    task_index.set(tid, ws)
                    index[tid] = ws
            tasks = [t for t in tasks if index.get(t["id"]) == ws]
        return jsonify({"tasks": tasks})

    @app.post("/api/scheduled-tasks")
    def scheduled_tasks_create():
        body = request.get_json(silent=True) or {}
        ws = body.get("workspace", "")
        command = str(body.get("command", "")).strip()
        repeat = str(body.get("repeat", "none")).strip().lower()
        run_time = body.get("run_time", "")
        scheduled_at = body.get("scheduled_at", "")
        if not ws or not command:
            return jsonify({"error": "workspace and command required"}), 400
        if repeat == "daily" and not run_time:
            return jsonify({"error": "daily tasks require run_time"}), 400
        if repeat == "none" and not scheduled_at:
            return jsonify({"error": "one-shot tasks require scheduled_at"}), 400
        try:
            task = task_runtime.create_task(
                session_id=uuid.uuid4().hex,
                command=command,
                repeat=repeat,
                run_time=run_time,
                scheduled_at=scheduled_at,
                timezone=body.get("timezone", "Asia/Shanghai"),
                enabled=bool(body.get("enabled", True)),
            )
        except Exception as e:
            return jsonify({"error": str(e)}), 400
        task_index.set(task["id"], ws)
        return jsonify(task)

    @app.get("/api/scheduled-tasks/<task_id>")
    def scheduled_tasks_get(task_id):
        task = task_runtime.get_task(task_id)
        if not task:
            return jsonify({"error": "未找到"}), 404
        return jsonify(task)

    @app.patch("/api/scheduled-tasks/<task_id>")
    def scheduled_tasks_update(task_id):
        body = request.get_json(silent=True) or {}
        updates = {k: body[k] for k in
                   ("command", "enabled", "run_time", "scheduled_at", "repeat")
                   if k in body}
        try:
            task = task_runtime.update_task(task_id, **updates)
        except Exception as e:
            return jsonify({"error": str(e)}), 400
        return jsonify({"task": task})

    @app.post("/api/scheduled-tasks/<task_id>/run")
    def scheduled_tasks_run_now(task_id):
        if task_runner is None:
            return jsonify({"error": "runner not available"}), 503
        run_id = task_runner.run_now(task_id)
        if run_id is None:
            return jsonify({"error": "task not runnable (missing, already running, or no workspace)"}), 409
        return jsonify({"run_id": run_id})

    @app.get("/api/scheduled-tasks/<task_id>/runs")
    def scheduled_tasks_runs(task_id):
        return jsonify({"runs": task_run_store.list(task_id)})

    @app.get("/api/scheduled-tasks/<task_id>/runs/<run_id>")
    def scheduled_tasks_run_detail(task_id, run_id):
        run = task_run_store.get(task_id, run_id)
        if run is None:
            return jsonify({"error": "未找到"}), 404
        return jsonify(run)

    # ── Skills & MCP catalog (browse + CRUD) ───────────────────
    # SDK imports are lazy + inside try/except so the endpoints degrade to an
    # empty list instead of 500 when the registry isn't populated.

    def _normalize_mcp_server(body: dict[str, Any], default_name: str | None = None) -> dict[str, Any] | str:
        transport = str(body.get("transport", ""))
        if transport not in ("stdio", "sse"):
            return "transport must be stdio or sse"
        name = default_name or str(body.get("name", ""))
        if not name:
            return "name is required"
        out: dict[str, Any] = {"name": name, "transport": transport}
        if transport == "stdio":
            command = str(body.get("command", ""))
            if not command:
                return "command is required for stdio transport"
            out["command"] = command
            args = body.get("args", [])
            out["args"] = [str(a) for a in args] if isinstance(args, list) else []
            env = body.get("env", {})
            out["env"] = {str(k): str(v) for k, v in env.items()} if isinstance(env, dict) else {}
        else:
            url = str(body.get("url", ""))
            if not url:
                return "url is required for sse transport"
            out["url"] = url
        return out

    @app.get("/api/skills")
    def skills_list():
        from .catalog_api import read_skills_disabled, list_custom_skills, list_builtin_skills
        try:
            from floodmind.skills.registry import get_skill_registry
            registry_skills = get_skill_registry().list_skills()
        except Exception as e:
            return jsonify({"skills": [], "error": str(e)})
        disabled_set = set(read_skills_disabled())
        builtin_names = set(list_builtin_skills())
        for s in registry_skills:
            s["disabled"] = s.get("name") in disabled_set
            s["builtin"] = s.get("name") in builtin_names
        registry_names = {s.get("name") for s in registry_skills}
        custom_skills = [s for s in list_custom_skills() if s.get("name") not in registry_names]
        return jsonify({"skills": registry_skills + custom_skills})

    @app.get("/api/skills/<name>")
    def skill_detail(name):
        try:
            from floodmind.skills.registry import get_skill_registry
            from .catalog_api import read_skills_disabled, list_builtin_skills
            s = get_skill_registry().get_skill(name)
        except Exception:
            return jsonify({"error": "skill registry unavailable"}), 404
        if s is None:
            return jsonify({"error": "skill not found"}), 404
        return jsonify({
            "name": s.name,
            "description": s.description,
            "prompt": s.prompt,
            "category": s.category,
            "provides_tools": s.provides_tools,
            "version": s.version,
            "disabled": s.name in set(read_skills_disabled()),
            "builtin": s.name in set(list_builtin_skills()),
        })

    @app.post("/api/skills/<name>/disabled")
    def skill_set_disabled(name):
        from .catalog_api import read_skills_disabled, write_skills_disabled, apply_skills_disabled, list_custom_skills
        body = request.get_json(silent=True) or {}
        disabled = bool(body.get("disabled"))
        exists = False
        try:
            from floodmind.skills.registry import get_skill_registry
            exists = get_skill_registry().get_skill(name) is not None
        except Exception:
            pass
        if not exists:
            exists = any(s.get("name") == name for s in list_custom_skills())
        if not exists:
            return jsonify({"error": "skill not found"}), 404
        current = set(read_skills_disabled())
        if disabled:
            current.add(name)
        else:
            current.discard(name)
        write_skills_disabled(sorted(current))
        apply_skills_disabled()
        return jsonify({"ok": True, "disabled": disabled})

    @app.post("/api/skills")
    def skill_create():
        from .catalog_api import create_skill
        body = request.get_json(silent=True) or {}
        try:
            meta = create_skill(
                name=str(body.get("name", "")),
                description=str(body.get("description", "")),
                category=str(body.get("category", "execution")),
                version=str(body.get("version", "1.0")),
                prompt=str(body.get("prompt", "")),
            )
            return jsonify(meta), 201
        except ValueError as e:
            return jsonify({"error": str(e)}), 400

    @app.put("/api/skills/<name>")
    def skill_update(name):
        from .catalog_api import update_skill
        body = request.get_json(silent=True) or {}
        try:
            meta = update_skill(
                name=name,
                description=str(body.get("description", "")),
                category=str(body.get("category", "execution")),
                version=str(body.get("version", "1.0")),
                prompt=str(body.get("prompt", "")),
            )
            return jsonify(meta)
        except ValueError as e:
            return jsonify({"error": str(e)}), 400
        except PermissionError as e:
            return jsonify({"error": str(e)}), 403

    @app.delete("/api/skills/<name>")
    def skill_delete(name):
        from .catalog_api import delete_skill
        try:
            delete_skill(name)
            return jsonify({"ok": True})
        except ValueError as e:
            return jsonify({"error": str(e)}), 404
        except PermissionError as e:
            return jsonify({"error": str(e)}), 403

    # ── 经验库 (记忆与经验) ──────────────────────────────────
    @app.get("/api/experience")
    def experience_list():
        return jsonify(agent.list_experiences())

    @app.get("/api/experience/search")
    def experience_search():
        q = request.args.get("q", "")
        try:
            top_k = int(request.args.get("top_k", 10))
        except ValueError:
            top_k = 10
        return jsonify({"results": agent.search_experiences(q, top_k)})

    @app.post("/api/experience/feedback")
    def experience_feedback():
        body = request.get_json(silent=True) or {}
        node_id = str(body.get("node_id", ""))
        helpful = bool(body.get("helpful"))
        if not node_id:
            return jsonify({"error": "node_id required"}), 400
        ok = agent.experience_feedback(node_id, helpful)
        return jsonify({"ok": ok})

    @app.post("/api/experience/maintain")
    def experience_maintain():
        return jsonify(agent.maintain_experiences())

    # ── 建议技能 (记忆与经验) ────────────────────────────────
    @app.get("/api/skills/drafts")
    def skill_drafts():
        return jsonify({"drafts": agent.list_draft_skills()})

    @app.post("/api/skills/drafts/<name>/approve")
    def skill_draft_approve(name):
        ok = agent.approve_draft_skill(name)
        return jsonify({"ok": ok}) if ok else (jsonify({"error": "未找到或已生效"}), 404)

    @app.post("/api/skills/drafts/<name>/reject")
    def skill_draft_reject(name):
        ok = agent.reject_draft_skill(name)
        return jsonify({"ok": ok}) if ok else (jsonify({"error": "未找到"}), 404)

    @app.get("/api/mcp")
    def mcp_list():
        """Every MCP server the UI should show: configured servers (connected or
        not) + any runtime-loaded ones (LoadMcpServer) not in config. Each carries
        a truthful ``connected`` flag + tool count, so a configured-but-failed
        server is still visible instead of silently hidden."""
        from .catalog_api import read_mcp_config
        configured = read_mcp_config()
        try:
            from floodmind.agent.mcp_client import get_mcp_client_pool
            connected = {s["name"]: s for s in get_mcp_client_pool().list_servers()}
        except Exception:
            connected = {}
        # Most-recent tool-call outcome per server (stronger than "connected"):
        # a connected MCP wrapper can still fail when the backend it proxies is
        # down. None = no call yet.
        health = getattr(agent, "mcp_call_health", lambda: {})()

        servers: list[dict] = []
        seen: set[str] = set()
        for s in configured:
            name = s.get("name")
            if not name or name in seen:
                continue
            seen.add(name)
            c = connected.get(name, {})
            h = health.get(name, {})
            servers.append({
                "name": name,
                "transport": s.get("transport") or c.get("transport"),
                "tools": c.get("tools", 0),
                "connected": bool(c.get("connected", False)),
                "health_ok": h.get("ok"),
                "health_error": h.get("error"),
            })
        # Runtime-loaded servers not present in config (e.g. agent LoadMcpServer).
        for name, c in connected.items():
            if name in seen:
                continue
            seen.add(name)
            h = health.get(name, {})
            servers.append({
                "name": name,
                "transport": c.get("transport"),
                "tools": c.get("tools", 0),
                "connected": bool(c.get("connected", False)),
                "health_ok": h.get("ok"),
                "health_error": h.get("error"),
            })
        return jsonify({"servers": servers})

    @app.get("/api/mcp/<name>")
    def mcp_detail(name):
        try:
            from floodmind.agent.mcp_client import get_mcp_client_pool
            info = get_mcp_client_pool().get_server_info(name)
        except Exception:
            info = None
        if info:
            return jsonify(info)
        # Not connected — fall back to the configured entry so the UI can still
        # show it (with a "未连接" status + the test button) instead of 404.
        from .catalog_api import read_mcp_config
        cfg = next((s for s in read_mcp_config() if s.get("name") == name), None)
        if cfg:
            return jsonify({
                "name": name,
                "transport": cfg.get("transport"),
                "tools": [],
                "connected": False,
                **{k: v for k, v in cfg.items() if k in ("command", "args", "env", "url", "headers")},
            })
        return jsonify({"error": "server not found"}), 404

    @app.post("/api/mcp")
    def mcp_create():
        from .catalog_api import read_mcp_config, write_mcp_config
        body = request.get_json(silent=True) or {}
        server = _normalize_mcp_server(body)
        if isinstance(server, str):
            return jsonify({"error": server}), 400
        servers = read_mcp_config()
        if any(s.get("name") == server["name"] for s in servers):
            return jsonify({"error": "server already exists"}), 400
        servers.append(server)
        write_mcp_config(servers)
        return jsonify(server), 201

    @app.put("/api/mcp/<name>")
    def mcp_update(name):
        from .catalog_api import read_mcp_config, write_mcp_config
        body = request.get_json(silent=True) or {}
        server = _normalize_mcp_server(body, name)
        if isinstance(server, str):
            return jsonify({"error": server}), 400
        servers = read_mcp_config()
        for i, s in enumerate(servers):
            if s.get("name") == name:
                servers[i] = server
                write_mcp_config(servers)
                return jsonify(server)
        return jsonify({"error": "server not found"}), 404

    @app.delete("/api/mcp/<name>")
    def mcp_delete(name):
        from .catalog_api import read_mcp_config, write_mcp_config
        servers = read_mcp_config()
        filtered = [s for s in servers if s.get("name") != name]
        if len(filtered) == len(servers):
            return jsonify({"error": "server not found"}), 404
        write_mcp_config(filtered)
        return jsonify({"ok": True})

    @app.post("/api/mcp/<name>/test")
    def mcp_test(name):
        from .catalog_api import read_mcp_config, test_mcp_server
        servers = read_mcp_config()
        server = next((s for s in servers if s.get("name") == name), None)
        if server is None:
            return jsonify({"error": "server not found"}), 404
        return jsonify(test_mcp_server(server))

    # ── Model configuration GUI ────────────────────────────────
    @app.get("/api/config/model")
    def config_model_get():
        from .config_api import read_model_config
        try:
            return jsonify(read_model_config())
        except Exception as e:  # pragma: no cover - defensive
            return jsonify({"error": str(e)}), 500

    @app.post("/api/config/model")
    def config_model_set():
        from .config_api import write_model_config
        body = request.get_json(silent=True) or {}
        try:
            snapshot = write_model_config(body)
        except Exception as e:  # pragma: no cover - defensive
            return jsonify({"error": str(e)}), 500
        # Apply to the running agent so the new model takes effect immediately.
        reloaded = False
        try:
            reloaded = bool(agent.reload_model())
        except Exception as e:  # pragma: no cover - defensive
            app.logger.warning("agent.reload_model failed: %s", e)
        return jsonify({"ok": True, "reloaded": reloaded, "model": snapshot})

    @app.post("/api/config/active-model")
    def config_active_model_set():
        """Lightweight switch: set active model + reload, without rewriting providers."""
        from .config_api import write_active_model
        body = request.get_json(silent=True) or {}
        try:
            snapshot = write_active_model(body)
        except ValueError as e:
            return jsonify({"error": str(e)}), 400
        except Exception as e:  # pragma: no cover - defensive
            return jsonify({"error": str(e)}), 500
        reloaded = False
        try:
            reloaded = bool(agent.reload_model())
        except Exception as e:  # pragma: no cover - defensive
            app.logger.warning("agent.reload_model failed: %s", e)
        return jsonify({"ok": True, "reloaded": reloaded, "model": snapshot})

    @app.post("/api/config/model/test")
    def config_model_test():
        """Verify a provider's baseURL+apiKey by probing its /models endpoint.

        Body: {provider, baseURL?, apiKey?}. Blanks fall back to saved values so
        the GUI can test a freshly typed key before saving.
        """
        from .config_api import test_model_connection
        body = request.get_json(silent=True) or {}
        return jsonify(test_model_connection(body))

    @app.post("/api/config/model/list")
    def config_model_list():
        """Fetch the available model id list from a provider's /models endpoint.

        Same body shape as /test; returns {ok, models, error}.
        """
        from .config_api import list_remote_models
        body = request.get_json(silent=True) or {}
        return jsonify(list_remote_models(body))

    @app.get("/api/config/soul")
    def config_soul_get():
        from .config_api import read_soul
        try:
            return jsonify(read_soul())
        except Exception as e:  # pragma: no cover - defensive
            return jsonify({"error": str(e)}), 500

    @app.post("/api/config/soul")
    def config_soul_set():
        from .config_api import write_soul
        body = request.get_json(silent=True) or {}
        try:
            snapshot = write_soul(body.get("content", ""))
        except ValueError as e:
            return jsonify({"error": str(e)}), 400
        except Exception as e:  # pragma: no cover - defensive
            return jsonify({"error": str(e)}), 500
        reloaded = False
        try:
            reloaded = bool(agent.reload_persona())
        except Exception as e:  # pragma: no cover - defensive
            app.logger.warning("agent.reload_persona failed: %s", e)
        return jsonify({"ok": True, "reloaded": reloaded, **snapshot})

    @app.get("/api/config/agents")
    def config_agents_get():
        from .config_api import read_agents_md
        try:
            return jsonify(read_agents_md())
        except Exception as e:  # pragma: no cover - defensive
            return jsonify({"error": str(e)}), 500

    @app.post("/api/config/agents")
    def config_agents_set():
        from .config_api import write_agents_md
        body = request.get_json(silent=True) or {}
        try:
            snapshot = write_agents_md(body.get("content", ""))
        except Exception as e:  # pragma: no cover - defensive
            return jsonify({"error": str(e)}), 500
        reloaded = False
        try:
            reloaded = bool(agent.reload_persona())
        except Exception as e:  # pragma: no cover - defensive
            app.logger.warning("agent.reload_persona failed: %s", e)
        return jsonify({"ok": True, "reloaded": reloaded, **snapshot})

    def _require_workspace():
        if workspace_manager is not None:
            current = workspace_manager.current_path()
            if current:
                return current
        return os.environ.get("FLOODMIND_DESKTOP_WORKSPACE", "")

    def _external_paths_root():
        """Workspace root the external-path registry keys to (default-workspace when none open).

        Prefers the real agent's current_workspace_root() so a no-workspace-open
        registration lands in the same default-workspace dir the agent binds;
        falls back for StubAgent tests.
        """
        from .workspace import _app_data_dir

        fn = getattr(agent, "current_workspace_root", None)
        if callable(fn):
            try:
                return fn()
            except Exception:  # pragma: no cover - defensive
                pass
        ws = _require_workspace()
        if ws:
            return ws
        return str(_app_data_dir() / "default-workspace")

    @app.get("/api/external-paths")
    def external_paths_get():
        from . import external_paths

        return jsonify({"paths": external_paths.read_external_paths(_external_paths_root())})

    @app.post("/api/external-paths")
    def external_paths_add():
        from . import external_paths

        body = request.get_json(silent=True) or {}
        paths = body.get("paths")
        if not isinstance(paths, list) or not paths:
            return jsonify({"error": "paths 列表不能为空"}), 400
        try:
            out = external_paths.add_external_paths(_external_paths_root(), [str(p) for p in paths])
        except Exception as e:  # pragma: no cover - defensive
            return jsonify({"error": str(e)}), 500
        return jsonify({"paths": out})

    @app.delete("/api/external-paths")
    def external_paths_remove():
        from . import external_paths

        body = request.get_json(silent=True) or {}
        path = str(body.get("path", "")).strip()
        if not path:
            return jsonify({"error": "path 不能为空"}), 400
        return jsonify({"paths": external_paths.remove_external_path(_external_paths_root(), path)})

    @app.get("/api/background-tasks")
    def background_tasks_list():
        """Running/completed background Bash tasks (exec_bash run_in_background)."""
        fn = getattr(agent, "list_background_tasks", None)
        tasks = fn() if callable(fn) else []
        return jsonify({"tasks": tasks})

    @app.post("/api/background-tasks/<task_id>/kill")
    def background_tasks_kill(task_id):
        fn = getattr(agent, "kill_background_task", None)
        ok = fn(task_id) if callable(fn) else False
        return jsonify({"ok": ok}) if ok else (jsonify({"error": "任务不存在或已结束"}), 404)

    @app.get("/api/workspace/file")
    def read_workspace_file():
        from . import external_paths

        raw_path = request.args.get("path", "").strip()
        if not raw_path:
            return jsonify({"error": "需要提供路径"}), 400
        workspace = _require_workspace()
        root = Path(workspace).resolve() if workspace else None
        if os.path.isabs(raw_path):
            # 拖入/粘贴的工作区外文件：绝对路径，按外部授权列表校验。
            target = Path(raw_path).resolve()
        else:
            if not workspace:
                return jsonify({"error": "未打开工作区"}), 400
            target = (Path(workspace) / raw_path).resolve()

        # Authorized: 工作区内，或显式注册的外部可读路径（该文件本身、或其所在
        # 目录被拖入授权过）。未授权的外部路径仍禁止预览。
        def _preview_allowed(p: Path) -> bool:
            if root is not None and (p == root or root in p.parents):
                return True
            for auth in external_paths.read_external_paths(_external_paths_root()):
                ap = Path(auth).resolve()
                if p == ap or ap in p.parents:
                    return True
            return False

        if not _preview_allowed(target):
            return jsonify({"error": "禁止访问"}), 403
        if not target.exists():
            return jsonify({"error": "未找到"}), 404
        # 目录 → 返回可浏览的文件列表（拖入的文件夹 chip 可点进其内容）。
        if target.is_dir():
            entries = []
            try:
                for p in sorted(target.iterdir()):
                    if p.name.startswith("."):
                        continue
                    entries.append({
                        "name": p.name,
                        "type": "dir" if p.is_dir() else "file",
                        "path": str(p.resolve()),
                    })
            except OSError:
                pass
            return jsonify({"kind": "dir", "entries": entries, "path": str(target)})
        mime = "text/plain"
        ext = target.suffix.lower()
        image_exts = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg"}
        base64_exts = {".pdf"}
        binary_doc_exts = {".docx", ".doc", ".xlsx", ".xls", ".pptx", ".ppt"}
        if ext in image_exts:
            mime = f"image/{ext.lstrip('.').lower()}"
            content = base64.b64encode(target.read_bytes()).decode()
            previewable = True
        elif ext in base64_exts:
            mime = {
                ".pdf": "application/pdf",
            }.get(ext, "application/octet-stream")
            content = base64.b64encode(target.read_bytes()).decode()
            previewable = True
        elif ext in binary_doc_exts:
            # Serve the raw file (base64) + its office mime; the client renders
            # it with format-specific components (docx-preview / SheetJS / pptx).
            # Legacy .doc/.xls/.ppt are served too — the client renderer fails
            # gracefully and offers "open in system".
            mime = {
                ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                ".doc": "application/msword",
                ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                ".xls": "application/vnd.ms-excel",
                ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
                ".ppt": "application/vnd.ms-powerpoint",
            }.get(ext, "application/octet-stream")
            content = base64.b64encode(target.read_bytes()).decode()
            previewable = True
        else:
            content = target.read_text(encoding="utf-8", errors="replace")
            previewable = True
        return jsonify({
            "kind": "file",
            "content": content,
            "mime": mime,
            "previewable": previewable,
            "path": str(target),
        })

    @app.get("/api/attachment/thumb")
    def attachment_thumb():
        """Return base64 + mime of an image for thumbnail display.

        ``path`` may be workspace-relative (resolved against the current
        workspace) or absolute (a drag-drop target the user explicitly attached).
        Image extensions only, 10MB cap. CORS is already restricted to the Tauri
        webview origins, and only images are returned — reading a file the user
        is actively attaching for display is intended.
        """
        from .attachments import IMAGE_EXTS, MAX_IMAGE_BYTES
        raw_path = request.args.get("path", "").strip()
        if not raw_path:
            return jsonify({"error": "需要提供路径"}), 400
        if os.path.isabs(raw_path):
            target = Path(raw_path)
        else:
            workspace = _require_workspace()
            if not workspace:
                return jsonify({"error": "未打开工作区"}), 400
            target = (Path(workspace) / raw_path).resolve()
            root = Path(workspace).resolve()
            if root not in target.parents and target != root:
                return jsonify({"error": "禁止访问"}), 403
        target = target.resolve()
        ext = target.suffix.lower()
        if ext not in IMAGE_EXTS:
            return jsonify({"error": "仅支持图片"}), 400
        if not target.exists() or not target.is_file():
            return jsonify({"error": "未找到"}), 404
        try:
            size = target.stat().st_size
        except OSError:
            return jsonify({"error": "无法读取"}), 500
        if size > MAX_IMAGE_BYTES:
            return jsonify({"error": "图片过大（>10MB）"}), 413
        if ext == ".jpg":
            mime = "image/jpeg"
        else:
            mime = f"image/{ext.lstrip('.').lower()}"
        content = base64.b64encode(target.read_bytes()).decode()
        return jsonify({"content": content, "mime": mime, "size": size})

    if workspace_manager is not None:
        @app.get("/api/workspace")
        def workspace_summary():
            return jsonify(workspace_manager.summary())

        @app.post("/api/workspace/open")
        def workspace_open():
            body = request.get_json(silent=True) or {}
            path = body.get("path")
            if not path:
                return jsonify({"error": "需要提供路径"}), 400
            try:
                summary = workspace_manager.open(path)
            except ValueError as e:
                return jsonify({"error": str(e)}), 400
            # Rebind the agent's memory/session to the new workspace so each
            # folder gets isolated history + outputs.
            try:
                agent.rebind_workspace(summary["path"])
            except Exception as e:  # pragma: no cover - defensive
                app.logger.warning("agent.rebind_workspace failed: %s", e)
            return jsonify(summary)

        @app.post("/api/workspace/forget")
        def workspace_forget():
            """Remove a path from the recent list (unpin from the sidebar).

            Does not delete anything on disk. If the forgotten path was the
            current workspace, current switches to the next recent entry and the
            agent is rebound; with none left, current becomes None and the agent
            keeps its last binding (the UI forces an open before sending).
            """
            body = request.get_json(silent=True) or {}
            path = str(body.get("path", "")).strip()
            if not path:
                return jsonify({"error": "path required"}), 400
            summary, current_changed = workspace_manager.forget(path)
            new_current = (summary.get("current") or {}).get("path")
            if current_changed and new_current:
                try:
                    agent.rebind_workspace(new_current)
                except Exception as e:  # pragma: no cover - defensive
                    app.logger.warning("agent.rebind_workspace after forget failed: %s", e)
            return jsonify(summary)

        @app.get("/api/workspace/files")
        def workspace_files():
            current = workspace_manager.current_path()
            if not current:
                return jsonify({"entries": [], "root": ""})
            root = Path(current).resolve()
            rel = request.args.get("path", ".")
            try:
                target = (root / rel).resolve()
            except (ValueError, OSError):
                return jsonify({"entries": [], "error": "invalid path"}), 400
            # Prevent escape outside the workspace.
            if root not in target.parents and target != root:
                return jsonify({"entries": [], "error": "outside workspace"}), 403
            entries = []
            try:
                for p in sorted(target.iterdir()):
                    # Hide hidden / SDK-managed dirs (`.floodmind` holds sessions,
                    # checkpoints, memory, artifacts archives) — never expose them
                    # as referenceable files in the @ picker.
                    if p.name.startswith("."):
                        continue
                    entries.append({
                        "name": p.name,
                        "type": "dir" if p.is_dir() else "file",
                        "path": str(p.relative_to(root)).replace("\\", "/"),
                    })
            except OSError:
                pass
            return jsonify({"entries": entries, "root": str(root)})

        @app.post("/api/workspace/files")
        def workspace_files_upload():
            """Upload one or more files into the current workspace.

            Body: {"files": [{"path": "rel/path", "content": "base64"}, ...]}
            Paths must be relative and stay inside the workspace.
            """
            current = workspace_manager.current_path()
            if not current:
                return jsonify({"error": "未打开工作区"}), 400
            root = Path(current).resolve()
            body = request.get_json(silent=True) or {}
            files = body.get("files") or []
            if not isinstance(files, list) or not files:
                return jsonify({"error": "files list required"}), 400

            written: list[str] = []
            for f in files:
                rel = str(f.get("path", "")).strip().replace("\\", "/")
                if not rel or rel.startswith("/") or ".." in rel.split("/"):
                    return jsonify({"error": f"invalid path: {rel}"}), 400
                try:
                    target = (root / rel).resolve()
                except (ValueError, OSError):
                    return jsonify({"error": f"invalid path: {rel}"}), 400
                if root not in target.parents and target != root:
                    return jsonify({"error": f"outside workspace: {rel}"}), 403
                try:
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_bytes(base64.b64decode(f.get("content", "")))
                    written.append(rel)
                except Exception as e:
                    return jsonify({"error": f"write failed for {rel}: {e}"}), 500
            return jsonify({"ok": True, "files": written})

    # ── Feedback ──────────────────────────────────────────────
    @app.post("/api/feedback")
    def feedback_create():
        body = request.get_json(silent=True) or {}
        description = str(body.get("description", "")).strip()
        if not description:
            return jsonify({"error": "description required"}), 400
        if len(description) > FEEDBACK_MAX_DESCRIPTION:
            return jsonify({"error": f"description too long (max {FEEDBACK_MAX_DESCRIPTION})"}), 400
        contact = str(body.get("contact", "")).strip()
        if len(contact) > FEEDBACK_MAX_CONTACT:
            return jsonify({"error": f"contact too long (max {FEEDBACK_MAX_CONTACT})"}), 400
        include_logs = bool(body.get("include_logs", False))
        logs = _sanitize_logs(body.get("logs")) if include_logs else None

        workspace = _require_workspace()
        if workspace:
            feedback_dir = Path(workspace) / ".floodmind" / "feedback"
        else:
            feedback_dir = _app_data_dir() / "feedback"
        feedback_dir.mkdir(parents=True, exist_ok=True)

        timestamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S-%f")[:-3]
        filename = f"feedback-{timestamp}.json"
        path = feedback_dir / filename

        payload = {
            "version": __version__,
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "workspace": workspace,
            "description": description,
            "include_logs": include_logs,
            "contact": contact or None,
            "logs": logs,
        }
        try:
            path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        except Exception as e:
            return jsonify({"error": f"failed to write feedback: {e}"}), 500
        # Return only the filename, never the absolute path — avoids leaking the
        # user's directory layout to anything that can read the HTTP response.
        return jsonify({"ok": True, "file": filename})

    return app
