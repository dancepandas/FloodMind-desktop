from __future__ import annotations

import argparse
import logging
import os
import socket
import sys

# The Tauri-spawned sidecar inherits no shell env, so if the SDK ever fetches
# from Hugging Face (embeddings/models) it would hang on the default endpoint.
# Default to the China mirror only when the user hasn't set their own.
os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")

# Surface SDK internals on stderr — most importantly exec_bash's "执行命令: ..."
# log line and workspace/path resolution — so CWD / wrong-drive issues are
# visible in the sidecar log (stderr is inherited up to the tauri-dev console).
_sdk_log = logging.getLogger("floodmind")
if _sdk_log.level == logging.NOTSET or _sdk_log.level > logging.INFO:
    _sdk_log.setLevel(logging.INFO)
if not _sdk_log.handlers:
    _h = logging.StreamHandler()  # default stream = stderr
    _h.setFormatter(logging.Formatter("[floodmind] %(message)s"))
    _sdk_log.addHandler(_h)
    _sdk_log.propagate = False

from .floodmind_agent import FloodMindAgent
from .workspace import WorkspaceManager
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

    # Ensure subprocesses spawned by the SDK (exec_bash / skill scripts) use the
    # same Python interpreter as this sidecar. The Tauri launch sets
    # FLOODMIND_PYTHON, but the inherited PATH may still resolve 'python' to a
    # different interpreter (e.g. C:\Python314); prepending the sidecar's own
    # Python directory fixes that.
    sidecar_python_dir = os.path.dirname(os.path.abspath(sys.executable))
    os.environ["PATH"] = sidecar_python_dir + os.pathsep + os.environ.get("PATH", "")

    workspace_manager = WorkspaceManager()
    agent = FloodMindAgent(workspace_manager=workspace_manager)
    try:
        from .config_api import read_permissions_config
        agent.set_permission_mode(read_permissions_config().get("mode", "trust-once"))
    except Exception as e:
        print(f"[sidecar] load permission mode failed: {e}", file=sys.stderr)

    app = create_app(agent, workspace_manager=workspace_manager)

    # First stdout line announces readiness + the chosen port. Rust reads this.
    # Use os.write (unbuffered) so the pipe actually delivers the line on Windows
    # where Python's stdout buffer + flush can sporadically fail with EINVAL.
    ready_line = f"READY {port}\n"
    try:
        os.write(1, ready_line.encode())
    except OSError:
        # Fall back to regular stdout; if this also fails the Rust side will
        # time out, which is the correct failure mode.
        sys.stdout.write(ready_line)
        sys.stdout.flush()

    # debug=False + use_reloader=False so Flask doesn't spawn a reloader child
    # that would break Rust's process control / READY handshake.
    app.run(host="127.0.0.1", port=port, threaded=True, debug=False, use_reloader=False)


if __name__ == "__main__":
    main()
