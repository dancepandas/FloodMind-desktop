#!/usr/bin/env bash
# Build the Python sidecar into a native exe with Nuitka (standalone folder).
# Output: build-nuitka/floodmind-sidecar.dist/floodmind-sidecar.exe
#
# First run downloads Nuitka's MinGW64 toolchain (~200MB) and compiles every
# imported module to C, so it is slow; subsequent runs reuse the cache.
set -euo pipefail
cd "$(dirname "$0")"

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
  --output-dir=build-nuitka \
  --output-filename=floodmind-sidecar.exe \
  entry.py

# Nuitka names the dist folder after the entry script (entry.dist). Rename it so
# the Tauri resource path (floodmind-sidecar.dist/floodmind-sidecar.exe) is stable.
rm -rf build-nuitka/floodmind-sidecar.dist
mv build-nuitka/entry.dist build-nuitka/floodmind-sidecar.dist

echo "Built: build-nuitka/floodmind-sidecar.dist/floodmind-sidecar.exe"
