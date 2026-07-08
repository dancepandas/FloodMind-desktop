from __future__ import annotations

from flask import Flask, jsonify

from .agent import Agent
from . import __version__


def create_app(agent: Agent) -> Flask:
    app = Flask(__name__)

    @app.get("/api/health")
    def health():
        return jsonify({"status": "ok", "version": __version__})

    return app
