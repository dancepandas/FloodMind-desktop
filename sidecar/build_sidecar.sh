#!/usr/bin/env bash
# Build the Python sidecar into a clean Nuitka standalone folder.
# Output: build-nuitka/floodmind-sidecar.dist/floodmind-sidecar.exe
set -euo pipefail
cd "$(dirname "$0")"

DESKTOP_VERSION="${FLOODMIND_DESKTOP_VERSION:-0.0.0}"
GIT_COMMIT="${FLOODMIND_GIT_COMMIT:-unknown}"
BUILD_DIR="build-nuitka"
RAW_DIST="$BUILD_DIR/entry.dist"
STABLE_DIST="$BUILD_DIR/floodmind-sidecar.dist"

if [ "$(python -c 'import sys; print(sys.platform)')" != "win32" ]; then
  echo "error: the Windows sidecar must be compiled with native Windows Python" >&2
  exit 1
fi
if [ "$(python -c 'import struct; print(struct.calcsize("P") * 8)')" != "64" ]; then
  echo "error: a 64-bit Python interpreter is required" >&2
  exit 1
fi
python -c 'import nuitka' >/dev/null 2>&1 || {
  echo "error: Nuitka is missing; install sidecar/requirements-build.txt first" >&2
  exit 1
}

# A release must never inherit an old standalone tree. Nuitka's own compiler
# cache remains available outside these output directories.
rm -rf "$RAW_DIST" "$STABLE_DIST" "$BUILD_DIR/entry.build" "$BUILD_DIR/entry.onefile-build"

python -m nuitka \
  --standalone \
  --follow-imports \
  --include-package=floodmind \
  --include-package-data=floodmind \
  --include-package=floodmind_desktop_sidecar \
  --include-package-data=floodmind_desktop_sidecar \
  --enable-plugin=anti-bloat \
  --assume-yes-for-downloads \
  --windows-console-mode=disable \
  --output-dir="$BUILD_DIR" \
  --output-filename=floodmind-sidecar.exe \
  entry.py

EXE="$RAW_DIST/floodmind-sidecar.exe"
if [ ! -s "$EXE" ]; then
  echo "error: Nuitka did not produce $EXE" >&2
  rm -rf "$RAW_DIST"
  exit 1
fi

PYTHON_VERSION="$(python -c 'import platform; print(platform.python_version())')"
NUITKA_VERSION="$(python -m nuitka --version | head -n 1 | tr -d '\r')"
SIDECAR_VERSION="$(python -c 'from importlib.metadata import version; print(version("floodmind-desktop-sidecar"))' 2>/dev/null || printf unknown)"
FLOODMIND_VERSION="$(python -c 'from importlib.metadata import version; print(version("floodmind"))' 2>/dev/null || printf unknown)"
BUILT_AT="$(python -c 'from datetime import datetime, timezone; print(datetime.now(timezone.utc).isoformat())')"

python - "$RAW_DIST/build-info.json" <<PY
import json, pathlib
path = pathlib.Path(r"$RAW_DIST/build-info.json")
data = {
    "desktop_version": "$DESKTOP_VERSION",
    "sidecar_version": "$SIDECAR_VERSION",
    "floodmind_version": "$FLOODMIND_VERSION",
    "git_commit": "$GIT_COMMIT",
    "python_version": "$PYTHON_VERSION",
    "nuitka_version": "$NUITKA_VERSION",
    "target": "windows-x86_64",
    "built_at_utc": "$BUILT_AT",
}
path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
PY

mv "$RAW_DIST" "$STABLE_DIST"
echo "Built fresh sidecar: $STABLE_DIST/floodmind-sidecar.exe"
