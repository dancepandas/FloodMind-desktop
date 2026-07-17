#!/usr/bin/env bash
# Full desktop packaging: build the Python sidecar (Nuitka), stage it for
# bundling, then build the Tauri MSI/NSIS installer.
#
#   bash pack.sh
#
# Output: src-tauri/target/release/bundle/{msi,nsis}/
set -euo pipefail
cd "$(dirname "$0")"

# 1. Sidecar exe (skip the slow Nuitka compile if it is already built).
if [ ! -f sidecar/build-nuitka/floodmind-sidecar.dist/floodmind-sidecar.exe ]; then
  echo ">> building sidecar with Nuitka …"
  bash sidecar/build_sidecar.sh
fi

# 2. Stage the dist folder into src-tauri/resources/ (Tauri bundles from here).
echo ">> staging sidecar dist for bundling …"
rm -rf src-tauri/resources/floodmind-sidecar.dist
mkdir -p src-tauri/resources
cp -r sidecar/build-nuitka/floodmind-sidecar.dist src-tauri/resources/floodmind-sidecar.dist

# 3. Tauri build: frontend + Rust (release) + MSI/NSIS.
echo ">> building Tauri installer …"
npm run tauri build

echo "Done. Installers under src-tauri/target/release/bundle/{msi,nsis}/"
