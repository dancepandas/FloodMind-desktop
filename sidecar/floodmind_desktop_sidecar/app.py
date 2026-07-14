from __future__ import annotations

import base64
import json
import os
import sys
import uuid
from pathlib import Path
from typing import Any

from flask import Flask, Response, jsonify, request
from flask_cors import CORS

from .agent import Agent, Message
from . import __version__


def _first_user_text(turns: list) -> str:
    """First user-message content in a turn pair (for title generation)."""
    for t in turns or []:
        if isinstance(t, dict) and t.get("role") == "user":
            return str(t.get("content", ""))
    return ""


def create_app(agent: Agent, workspace_manager=None, conversation_store=None,
               task_runtime=None, task_index=None,
               task_run_store=None, task_runner=None, start_runner=True) -> Flask:
    app = Flask(__name__)

    # The Tauri WebView (origin http://127.0.0.1:1420 in dev, tauri://localhost in
    # prod) and the sidecar (127.0.0.1:<port>) are different origins, so a POST
    # with Content-Type: application/json triggers a CORS preflight. flask-cors
    # answers OPTIONS and adds the allow-origin header. Sidecar is 127.0.0.1-only,
    # so a wildcard is acceptable here; Plan 5 should restrict to the Tauri origin
    # or switch to tauri-plugin-http (requests via Rust, no CORS at all).
    CORS(app, resources={r"/api/*": {"origins": "*"}})

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
        if not messages:
            return jsonify({"error": "messages must be a non-empty list"}), 400

        def generate():
            for event in agent.stream(messages):
                yield json.dumps(event, ensure_ascii=False) + "\n"

        return Response(generate(), mimetype="application/x-ndjson")

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
            return jsonify({"error": "not found"}), 404
        return jsonify(rec)

    @app.post("/api/conversations/<conv_id>/activate")
    def conversations_activate(conv_id):
        rec = conversation_store.get(conv_id)
        if rec is None:
            return jsonify({"error": "not found"}), 404
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
            return jsonify({"error": "not found"}), 404
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
            return jsonify({"error": "not found"}), 404
        return jsonify({"ok": True})

    # ── Scheduled tasks ───────────────────────────────────────
    @app.get("/api/scheduled-tasks")
    def scheduled_tasks_list():
        ws = request.args.get("workspace", "")
        tasks = task_runtime.list_tasks("")
        if ws:
            index = task_index.all()
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
            return jsonify({"error": "not found"}), 404
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

    @app.delete("/api/scheduled-tasks/<task_id>")
    def scheduled_tasks_delete(task_id):
        try:
            task_runtime.delete_task(task_id)
        except Exception as e:
            return jsonify({"error": str(e)}), 400
        task_index.remove(task_id)
        return jsonify({"ok": True})

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
            return jsonify({"error": "not found"}), 404
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

    @app.get("/api/mcp")
    def mcp_list():
        try:
            from floodmind.agent.mcp_client import get_mcp_client_pool
            from .catalog_api import read_mcp_config
            servers = get_mcp_client_pool().list_servers()
        except Exception as e:
            return jsonify({"servers": [], "error": str(e)})
        configured = {s.get("name"): s for s in read_mcp_config()}
        return jsonify({"servers": servers, "configured": configured})

    @app.get("/api/mcp/<name>")
    def mcp_detail(name):
        try:
            from floodmind.agent.mcp_client import get_mcp_client_pool
            info = get_mcp_client_pool().get_server_info(name)
        except Exception:
            return jsonify({"error": "mcp pool unavailable"}), 404
        if not info:
            return jsonify({"error": "server not found"}), 404
        return jsonify(info)

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

    @app.get("/api/workspace/file")
    def read_workspace_file():
        workspace = _require_workspace()
        if not workspace:
            return jsonify({"error": "no workspace open"}), 400
        rel = request.args.get("path", "").lstrip("/\\")
        if not rel:
            return jsonify({"error": "path required"}), 400
        target = Path(workspace) / rel
        target = target.resolve()
        root = Path(workspace).resolve()
        # Prevent escape outside the workspace.
        if root not in target.parents and target != root:
            return jsonify({"error": "forbidden"}), 403
        if not target.exists():
            return jsonify({"error": "not found"}), 404
        mime = "text/plain"
        if target.suffix.lower() in {".png", ".jpg", ".jpeg", ".gif", ".webp"}:
            mime = f"image/{target.suffix.lstrip('.').lower()}"
            content = base64.b64encode(target.read_bytes()).decode()
        else:
            content = target.read_text(encoding="utf-8", errors="replace")
        return jsonify({"content": content, "mime": mime})

    if workspace_manager is not None:
        @app.get("/api/workspace")
        def workspace_summary():
            return jsonify(workspace_manager.summary())

        @app.post("/api/workspace/open")
        def workspace_open():
            body = request.get_json(silent=True) or {}
            path = body.get("path")
            if not path:
                return jsonify({"error": "path required"}), 400
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
                    if p.name.startswith(".") and p.name != ".floodmind":
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
                return jsonify({"error": "no workspace open"}), 400
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

    return app
