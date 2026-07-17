"""PyInstaller entry point for the sidecar.

`__main__.py` uses package-relative imports that only work under `python -m`,
so this thin wrapper (absolute import) is what we freeze. The frozen exe still
prints `READY <port>` on stdout (see __main__.main) for the Rust handshake.
"""
from floodmind_desktop_sidecar.__main__ import main

if __name__ == "__main__":
    main()
