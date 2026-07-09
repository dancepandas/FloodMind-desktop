from __future__ import annotations

import json

from flask import Flask, Response, jsonify, request
from flask_cors import CORS

from .agent import Agent, Message
from . import __version__


def create_app(agent: Agent, workspace_manager=None) -> Flask:
    app = Flask(__name__)

    # The Tauri WebView (origin http://127.0.0.1:1420 in dev, tauri://localhost in
    # prod) and the sidecar (127.0.0.1:<port>) are different origins, so a POST
    # with Content-Type: application/json triggers a CORS preflight. flask-cors
    # answers OPTIONS and adds the allow-origin header. Sidecar is 127.0.0.1-only,
    # so a wildcard is acceptable here; Plan 5 should restrict to the Tauri origin
    # or switch to tauri-plugin-http (requests via Rust, no CORS at all).
    CORS(app, resources={r"/api/*": {"origins": "*"}})

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

    return app
