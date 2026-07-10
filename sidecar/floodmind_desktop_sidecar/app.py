from __future__ import annotations

import json
import sys
import threading
from pathlib import Path

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


def _apply_title(store, title_fn, conv_id: str, user_text: str) -> None:
    """Call title_fn(user_text); on a non-empty result, persist it. Swallows errors."""
    try:
        title = title_fn(user_text)
        if title:
            store.update_title(conv_id, title)
    except Exception as e:  # pragma: no cover - defensive
        print(f"[sidecar] title apply failed: {e}", file=sys.stderr)


def create_app(agent: Agent, workspace_manager=None, conversation_store=None, title_spawner=None) -> Flask:
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
    if title_spawner is None:
        def title_spawner(fn):
            threading.Thread(target=fn, daemon=True, name="conv-title").start()

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
        # First-turn background title generation: nothing was persisted before this append.
        if len(rec.get("turns", [])) <= len(turns):
            user_text = _first_user_text(turns)
            if user_text:
                title_spawner(lambda: _apply_title(conversation_store, agent.generate_title, conv_id, user_text))
        return jsonify({"ok": True})

    @app.delete("/api/conversations/<conv_id>")
    def conversations_delete(conv_id):
        session_id = conversation_store.delete(conv_id)
        if session_id is None:
            return jsonify({"error": "not found"}), 404
        return jsonify({"ok": True})

    # ── Skills & MCP catalog (read-only browse) ────────────────
    # SDK imports are lazy + inside try/except so the endpoints degrade to an
    # empty list instead of 500 when the registry isn't populated.
    @app.get("/api/skills")
    def skills_list():
        try:
            from floodmind.skills.registry import get_skill_registry
            return jsonify({"skills": get_skill_registry().list_skills()})
        except Exception as e:
            return jsonify({"skills": [], "error": str(e)})

    @app.get("/api/skills/<name>")
    def skill_detail(name):
        try:
            from floodmind.skills.registry import get_skill_registry
            s = get_skill_registry().get_skill(name)
        except Exception:
            # Registry unavailable (e.g. SDK not fully initialized) -> not found,
            # consistent with the list endpoint degrading to empty.
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
        })

    @app.get("/api/mcp")
    def mcp_list():
        try:
            from floodmind.agent.mcp_client import get_mcp_client_pool
            return jsonify({"servers": get_mcp_client_pool().list_servers()})
        except Exception as e:
            return jsonify({"servers": [], "error": str(e)})

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

    return app
