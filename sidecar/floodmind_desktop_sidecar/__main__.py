from __future__ import annotations

import argparse
import socket
import sys

from .agent import StubAgent
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
    app = create_app(StubAgent())

    # First stdout line announces readiness + the chosen port. Rust reads this.
    sys.stdout.write(f"READY {port}\n")
    sys.stdout.flush()

    # debug=False + use_reloader=False so Flask doesn't spawn a reloader child
    # that would break Rust's process control / READY handshake.
    app.run(host="127.0.0.1", port=port, threaded=True, debug=False, use_reloader=False)


if __name__ == "__main__":
    main()
