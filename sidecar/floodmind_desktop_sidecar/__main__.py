from __future__ import annotations

import argparse
import os
import socket
import sys

# The Tauri-spawned sidecar inherits no shell env, so if the SDK ever fetches
# from Hugging Face (embeddings/models) it would hang on the default endpoint.
# Default to the China mirror only when the user hasn't set their own.
os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")

from .floodmind_agent import FloodMindAgent
from .app import create_app


def find_free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def main() -> None:
    parser = argparse.ArgumentParser(prog="floodmind-sidecar")
    parser.add_argument("--port", type=int, default=None)
    args = parser.parse_args()

    port = args.port if args.port is not None else find_free_port()
    app = create_app(FloodMindAgent())

    # First stdout line announces readiness + the chosen port. Rust reads this.
    sys.stdout.write(f"READY {port}\n")
    sys.stdout.flush()

    # debug=False + use_reloader=False so Flask doesn't spawn a reloader child
    # that would break Rust's process control / READY handshake.
    app.run(host="127.0.0.1", port=port, threaded=True, debug=False, use_reloader=False)


if __name__ == "__main__":
    main()
