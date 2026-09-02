#!/usr/bin/env bash
# Build a fresh Windows x64 FloodMind Desktop NSIS installer.
#
#   bash pack.sh
#
# Output: src-tauri/target/release/bundle/nsis/FloodMind Desktop_<version>_x64-setup.exe
set -euo pipefail
cd "$(dirname "$0")"

export CI=true
VERSION="$(node -p 'require("./package.json").version')"
TAURI_VERSION="$(node -p 'require("./src-tauri/tauri.conf.json").version')"
CARGO_VERSION="$(python -c 'import pathlib,re; print(re.search(r"^version\s*=\s*\"([^\"]+)\"", pathlib.Path("src-tauri/Cargo.toml").read_text(), re.M).group(1))')"
COMMIT="$(git rev-parse HEAD)"
NSIS_DIR="src-tauri/target/release/bundle/nsis"
INSTALLER="$NSIS_DIR/FloodMind Desktop_${VERSION}_x64-setup.exe"

fail() { echo "error: $*" >&2; exit 1; }
for cmd in git node npm python rustc cargo powershell.exe; do
  command -v "$cmd" >/dev/null 2>&1 || fail "required command not found: $cmd"
done
[ "$VERSION" = "$TAURI_VERSION" ] && [ "$VERSION" = "$CARGO_VERSION" ] || \
  fail "version mismatch: package=$VERSION tauri=$TAURI_VERSION cargo=$CARGO_VERSION"
[ "$(python -c 'import sys; print(sys.platform)')" = "win32" ] || fail "native Windows Python is required"
[ "$(python -c 'import struct; print(struct.calcsize("P") * 8)')" = "64" ] || fail "64-bit Python is required"
rustc -vV | grep -q 'host: x86_64-pc-windows-msvc' || fail "Rust MSVC x64 host is required"
if ! git diff --quiet || ! git diff --cached --quiet; then
  fail "tracked files have uncommitted changes; commit release changes before packaging"
fi

# Build dependencies are project-owned and version-pinned. This intentionally
# modifies the active packaging environment, never the end user's machine.
python -m pip install -r sidecar/requirements-build.txt
python -c 'import nuitka' >/dev/null 2>&1 || fail "Nuitka installation failed"

# Lock-respecting dependency and test gates.
echo ">> installing frontend dependencies from package-lock.json …"
npm ci
echo ">> frontend tests and production build …"
npm test -- --run
npm run build
echo ">> sidecar tests …"
python -m pytest sidecar/tests/ -q
echo ">> Rust tests …"
cargo test --locked --manifest-path src-tauri/Cargo.toml

# Always compile from current sources; build_sidecar.sh removes old release trees.
echo ">> building fresh sidecar with Nuitka …"
FLOODMIND_DESKTOP_VERSION="$VERSION" FLOODMIND_GIT_COMMIT="$COMMIT" bash sidecar/build_sidecar.sh
SIDE_EXE="sidecar/build-nuitka/floodmind-sidecar.dist/floodmind-sidecar.exe"
[ -s "$SIDE_EXE" ] || fail "fresh sidecar executable is missing"

echo ">> smoke-testing frozen sidecar …"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$(pwd -W)/sidecar/scripts/smoke_sidecar.ps1" \
  -SidecarExe "$(pwd -W)/${SIDE_EXE//\//\\}"

echo ">> staging fresh sidecar resources …"
rm -rf src-tauri/resources/floodmind-sidecar.dist
mkdir -p src-tauri/resources
cp -r sidecar/build-nuitka/floodmind-sidecar.dist src-tauri/resources/floodmind-sidecar.dist
[ -s src-tauri/resources/floodmind-sidecar.dist/floodmind-sidecar.exe ] || fail "staged sidecar is missing"

rm -f "$INSTALLER" "$INSTALLER.sha256" "$NSIS_DIR/release-manifest.json"
echo ">> building unsigned Tauri NSIS installer …"
npm run tauri build -- --bundles nsis --ci --no-sign
[ -s "$INSTALLER" ] || fail "expected NSIS installer was not produced: $INSTALLER"

HASH="$(powershell.exe -NoProfile -Command "(Get-FileHash -Algorithm SHA256 -LiteralPath '$(cygpath -w "$INSTALLER")').Hash.ToLower()" | tr -d '\r')"
SIZE="$(python -c 'import os; print(os.path.getsize(r"'"$INSTALLER"'"))')"
SIGNATURE="$(powershell.exe -NoProfile -Command "(Get-AuthenticodeSignature -LiteralPath '$(cygpath -w "$INSTALLER")').Status" | tr -d '\r')"
printf '%s  %s\n' "$HASH" "$(basename "$INSTALLER")" > "$INSTALLER.sha256"

python - "$NSIS_DIR/release-manifest.json" <<PY
import json, pathlib
path = pathlib.Path(r"$NSIS_DIR/release-manifest.json")
data = {
    "product": "FloodMind Desktop",
    "version": "$VERSION",
    "platform": "windows-x64",
    "bundle": "nsis",
    "installer": "$(basename "$INSTALLER")",
    "size_bytes": int("$SIZE"),
    "sha256": "$HASH",
    "authenticode_status": "$SIGNATURE",
    "git_commit": "$COMMIT",
}
path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
PY

echo "Done: $INSTALLER"
echo "SHA-256: $HASH"
echo "Authenticode: $SIGNATURE (this release is intentionally unsigned)"
