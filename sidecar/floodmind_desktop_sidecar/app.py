from __future__ import annotations

import json

from flask import Flask, Response, jsonify, request
from flask_cors import CORS

from .agent import Agent, Message
from . import __version__


def create_app(agent: Agent) -> Flask:
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

    return app
