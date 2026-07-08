# FloodMind Desktop — Plan 1: Foundation & Sidecar Integration

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Tauri 2 + React 19 desktop window that launches a Python sidecar on startup and completes one streaming chat round-trip end-to-end (type a message → see a streamed reply).

**Architecture:** Tauri Rust shell spawns a Python sidecar subprocess on app startup. The sidecar picks a free port on `127.0.0.1`, prints `READY <port>` to stdout, and serves a Flask HTTP API. Rust reads the READY line, stores the base URL in Tauri managed state, and exposes it to the frontend via a `#[tauri::command]`. The React frontend calls the command to learn the base URL, then consumes an NDJSON streaming `POST /api/chat` via `fetch` + `ReadableStream`. A stub agent (clear seam) produces a canned streamed reply; real FloodMind SDK wiring is deferred to Plan 2.

**Tech Stack:** Tauri 2.x, Rust 1.96, React 19, TypeScript, Vite 7, Zustand, Python 3.13, Flask, pytest, vitest.

## Global Constraints

- Work in repo root: `D:\chengs\9.project\Agent_desktop` (Windows, bash shell, conda env `Agent_desktop` is active; `python` resolves to Python 3.13).
- Use **npm** (no pnpm available).
- Sidecar listens on **`127.0.0.1` only** — never bind to a public interface.
- Sidecar chooses its own port (`bind 127.0.0.1:0`) and reports it via the first stdout line `READY <port>` — no port passed from Rust (avoids TOCTOU race).
- The Python interpreter used to spawn the sidecar is read from env `FLOODMIND_PYTHON`, defaulting to `python`.
- **Deviation from spec, noted:** In dev we spawn the sidecar via Rust `std::process::Command` (stable, no capability configuration). The `tauri-plugin-shell` + `externalBin` target-triple sidecar binary bundling is adopted in the **Packaging** plan (Plan 5). This keeps Plan 1 runnable immediately without PyInstaller.
- This plan wires a **stub agent** with an explicit `Agent` protocol seam. Replacing it with real `floodmind.agent.create_flood_agent` is Plan 2.
- Follow TDD: write the failing test first, run it, implement minimal code, run it green, then commit. Commit after every task.

---

## File Structure

```
Agent_desktop/
├── package.json                     # npm scripts + frontend deps
├── vite.config.ts                   # Vite (React, port 1420 for Tauri dev)
├── tsconfig.json
├── tsconfig.node.json
├── index.html
├── src/                             # React frontend
│   ├── main.tsx                     # React entry
│   ├── App.tsx                      # root: health + chat
│   ├── app.css
│   ├── lib/
│   │   ├── sidecar-client.ts        # base URL discovery + health check
│   │   ├── chat-stream.ts           # NDJSON stream consumer (async generator)
│   │   └── chat-stream.test.ts      # vitest for stream parsing
│   ├── state/
│   │   └── chat-store.ts            # Zustand store
│   └── components/
│       ├── HealthBadge.tsx
│       ├── ChatView.tsx
│       └── Composer.tsx
├── src-tauri/                       # Tauri Rust shell
│   ├── Cargo.toml
│   ├── build.rs
│   ├── tauri.conf.json
│   └── src/
│       ├── main.rs                  # entry → lib::run()
│       ├── lib.rs                   # Tauri builder + command registration
│       └── sidecar.rs               # spawn, READY parsing, lifecycle
├── sidecar/                         # Python sidecar package
│   ├── pyproject.toml
│   ├── floodmind_desktop_sidecar/
│   │   ├── __init__.py
│   │   ├── __main__.py              # entry: pick port, print READY, serve
│   │   ├── app.py                   # Flask app factory + routes
│   │   └── agent.py                 # Agent protocol + StubAgent
│   └── tests/
│       ├── conftest.py
│       ├── test_health.py
│       └── test_chat.py
└── docs/superpowers/
    ├── specs/2026-07-08-floodmind-desktop-design.md   # (exists)
    └── plans/2026-07-08-foundation-sidecar.md         # (this file)
```

**Responsibilities:**
- `sidecar/floodmind_desktop_sidecar/agent.py` — the `Agent` protocol and a deterministic stub. This is the ONLY seam Plan 2 touches to add real FloodMind.
- `sidecar/floodmind_desktop_sidecar/app.py` — Flask routes; depends only on the `Agent` protocol.
- `src-tauri/src/sidecar.rs` — pure `parse_ready_line` (unit-tested) + process lifecycle.
- `src/lib/chat-stream.ts` — pure NDJSON line parser over `fetch` streaming (vitest-tested with a mock stream).

---

## Task 1: Scaffold Tauri 2 + React 19 + Vite frontend

**Files:**
- Create: `package.json`, `vite.config.ts`, `tsconfig.json`, `tsconfig.node.json`, `index.html`
- Create: `src/main.tsx`, `src/App.tsx`, `src/app.css`

**Interfaces:**
- Produces: `npm run dev` (Vite on port 1420) and `npm run tauri dev` (window opens) for later tasks.

- [ ] **Step 1: Initialize git repo**

```bash
cd "D:/chengs/9.project/Agent_desktop"
git init
git add -A
git commit -m "chore: initialize repo (design spec, implementation plan, idea files)"
```

- [ ] **Step 2: Create `package.json`**

```json
{
  "name": "floodmind-desktop",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "preview": "vite preview",
    "tauri": "tauri",
    "test": "vitest run"
  },
  "dependencies": {
    "@tauri-apps/api": "^2",
    "react": "^19.0.0",
    "react-dom": "^19.0.0",
    "zustand": "^5.0.0"
  },
  "devDependencies": {
    "@tauri-apps/cli": "^2",
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "@vitejs/plugin-react": "^4.3.0",
    "typescript": "^5.6.0",
    "vite": "^7.0.0",
    "vitest": "^3.0.0"
  }
}
```

- [ ] **Step 3: Create `vite.config.ts`**

```ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Tauri expects the dev server on port 1420.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: "127.0.0.1",
  },
  envPrefix: ["VITE_", "TAURI_"],
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
```

- [ ] **Step 4: Create `tsconfig.json` and `tsconfig.node.json`**

`tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "useDefineForClassFields": true,
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "skipLibCheck": true,
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true,
    "jsx": "react-jsx",
    "strict": true,
    "types": ["vitest/globals"]
  },
  "include": ["src"],
  "references": [{ "path": "./tsconfig.node.json" }]
}
```

`tsconfig.node.json`:
```json
{
  "compilerOptions": {
    "composite": true,
    "skipLibCheck": true,
    "module": "ESNext",
    "moduleResolution": "bundler",
    "allowSyntheticDefaultImports": true
  },
  "include": ["vite.config.ts"]
}
```

- [ ] **Step 5: Create `index.html`**

```html
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>FloodMind Desktop</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 6: Create `src/main.tsx`, `src/App.tsx`, `src/app.css`**

`src/main.tsx`:
```tsx
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./app.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
```

`src/App.tsx`:
```tsx
export default function App() {
  return (
    <main className="app">
      <h1>FloodMind Desktop</h1>
      <p>脚手架就绪。</p>
    </main>
  );
}
```

`src/app.css`:
```css
:root { font-family: system-ui, sans-serif; color-scheme: light dark; }
body { margin: 0; }
.app { padding: 1.5rem; }
```

- [ ] **Step 7: Install dependencies and verify Vite dev server**

```bash
npm install
npm run dev
```
Expected: Vite starts on `http://127.0.0.1:1420/` (Ctrl+C to stop; the page shows "FloodMind Desktop / 脚手架就绪。").

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat: scaffold React 19 + Vite frontend"
```

---

## Task 2: Scaffold the Tauri Rust shell

**Files:**
- Create: `src-tauri/Cargo.toml`, `src-tauri/build.rs`, `src-tauri/tauri.conf.json`
- Create: `src-tauri/src/main.rs`, `src-tauri/src/lib.rs`

**Interfaces:**
- Produces: `npm run tauri dev` opens a desktop window rendering the Vite app.

- [ ] **Step 1: Create `src-tauri/Cargo.toml`**

```toml
[package]
name = "floodmind-desktop"
version = "0.1.0"
edition = "2021"

[lib]
name = "floodmind_desktop_lib"
crate-type = ["staticlib", "cdylib", "rlib"]

[build-dependencies]
tauri-build = { version = "2", features = [] }

[dependencies]
tauri = { version = "2", features = [] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
```

- [ ] **Step 2: Create `src-tauri/build.rs`**

```rust
fn main() {
    tauri_build::build()
}
```

- [ ] **Step 3: Create `src-tauri/tauri.conf.json`**

```json
{
  "$schema": "https://schema.tauri.app/config/2",
  "productName": "FloodMind Desktop",
  "version": "0.1.0",
  "identifier": "com.floodmind.desktop",
  "build": {
    "frontendDist": "../dist",
    "devUrl": "http://127.0.0.1:1420",
    "beforeDevCommand": "npm run dev",
    "beforeBuildCommand": "npm run build"
  },
  "app": {
    "windows": [
      {
        "title": "FloodMind Desktop",
        "width": 1100,
        "height": 720,
        "minWidth": 800,
        "minHeight": 500
      }
    ],
    "security": {
      "csp": null
    }
  },
  "bundle": {
    "active": true,
    "targets": "all",
    "icon": []
  }
}
```

- [ ] **Step 4: Create `src-tauri/src/main.rs`**

```rust
// Prevents an extra console window on Windows in release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    floodmind_desktop_lib::run();
}
```

- [ ] **Step 5: Create `src-tauri/src/lib.rs` (minimal, no sidecar yet)**

```rust
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![ping])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[tauri::command]
fn ping() -> String {
    "pong".to_string()
}
```

- [ ] **Step 6: Verify Tauri builds and a window opens**

```bash
npm run tauri dev
```
Expected: A native desktop window titled "FloodMind Desktop" opens showing "FloodMind Desktop / 脚手架就绪。". (First run downloads Rust crates; this takes a few minutes. Ctrl+C to stop after verifying.)

> If the build fails with a missing WebView2 installer message on Windows, install the "Evergreen Bootstrapper" from microsoft.com, then retry.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: scaffold Tauri 2 shell with ping command"
```

---

## Task 3: Python sidecar package + `/api/health` (TDD)

**Files:**
- Create: `sidecar/pyproject.toml`
- Create: `sidecar/floodmind_desktop_sidecar/__init__.py`, `agent.py`, `app.py`, `__main__.py`
- Create: `sidecar/tests/conftest.py`, `sidecar/tests/test_health.py`

**Interfaces:**
- Produces: `GET /api/health` → `200 {"status":"ok","version":"0.1.0"}` (Flask).
- Produces: `python -m floodmind_desktop_sidecar` picks a free port, prints `READY <port>`, serves on `127.0.0.1`.
- Produces: `Agent` protocol (`stream(messages) -> Iterator[dict]`) — the seam Plan 2 replaces.

- [ ] **Step 1: Create `sidecar/pyproject.toml`**

```toml
[project]
name = "floodmind-desktop-sidecar"
version = "0.1.0"
requires-python = ">=3.10"
dependencies = ["flask>=3.0"]

[project.scripts]
floodmind-sidecar = "floodmind_desktop_sidecar.__main__:main"

[build-system]
requires = ["setuptools>=68"]
build-backend = "setuptools.build_meta"

[tool.setuptools.packages.find]
where = ["."]
include = ["floodmind_desktop_sidecar*"]

[tool.pytest.ini_options]
testpaths = ["tests"]
```

- [ ] **Step 2: Create the package `__init__.py` and the `Agent` seam**

`sidecar/floodmind_desktop_sidecar/__init__.py`:
```python
__version__ = "0.1.0"
```

`sidecar/floodmind_desktop_sidecar/agent.py`:
```python
"""Agent seam. Plan 2 replaces StubAgent with the real FloodMind SDK."""
from __future__ import annotations

from typing import Iterator, Protocol, TypedDict


class Message(TypedDict):
    role: str
    content: str


class Agent(Protocol):
    def stream(self, messages: list[Message]) -> Iterator[dict]:
        """Yield event dicts, e.g. {"type": "text", "content": "..."} and {"type": "done"}."""
        ...


class StubAgent:
    """Deterministic stub used until the real FloodMind agent is wired in."""

    def stream(self, messages: list[Message]) -> Iterator[dict]:
        user_text = messages[-1]["content"] if messages else ""
        reply = f"[sidecar stub] 收到：{user_text}"
        # Stream in three chunks so the UI visibly streams.
        mid = len(reply) // 2
        chunks = [reply[:mid], reply[mid:], ""]
        for c in chunks:
            yield {"type": "text", "content": c}
        yield {"type": "done"}
```

- [ ] **Step 3: Write the failing health test**

`sidecar/tests/conftest.py`:
```python
import pytest

from floodmind_desktop_sidecar.agent import StubAgent
from floodmind_desktop_sidecar.app import create_app


@pytest.fixture
def app():
    return create_app(StubAgent())


@pytest.fixture
def client(app):
    return app.test_client()
```

`sidecar/tests/test_health.py`:
```python
def test_health_returns_ok(client):
    response = client.get("/api/health")
    assert response.status_code == 200
    assert response.get_json() == {"status": "ok", "version": "0.1.0"}
```

- [ ] **Step 4: Run the test to verify it fails**

```bash
cd sidecar
pip install -e . pytest
python -m pytest tests/test_health.py -v
```
Expected: FAIL — `ModuleNotFoundError: No module named 'floodmind_desktop_sidecar.app'` (app.py not created yet).

- [ ] **Step 5: Implement `app.py` (health route only for now)**

`sidecar/floodmind_desktop_sidecar/app.py`:
```python
from __future__ import annotations

from flask import Flask, Response, jsonify, request

from .agent import Agent, Message
from . import __version__


def create_app(agent: Agent) -> Flask:
    app = Flask(__name__)

    @app.get("/api/health")
    def health():
        return jsonify({"status": "ok", "version": __version__})

    return app
```

- [ ] **Step 6: Run the test to verify it passes**

```bash
python -m pytest tests/test_health.py -v
```
Expected: PASS (1 passed).

- [ ] **Step 7: Create `__main__.py` and verify the standalone server prints READY**

`sidecar/floodmind_desktop_sidecar/__main__.py`:
```python
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

    port = args.port if args.port else find_free_port()
    app = create_app(StubAgent())

    # First stdout line announces readiness + the chosen port. Rust reads this.
    sys.stdout.write(f"READY {port}\n")
    sys.stdout.flush()

    # debug=False so Flask doesn't spawn a reloader child that breaks process control.
    app.run(host="127.0.0.1", port=port, threaded=True, debug=False, use_reloader=False)


if __name__ == "__main__":
    main()
```

- [ ] **Step 8: Verify the server announces READY and serves health**

```bash
cd "D:/chengs/9.project/Agent_desktop"
python -m floodmind_desktop_sidecar > /tmp/sidecar.log 2>&1 &
SIDECAR_PID=$!
sleep 2
PORT=$(head -n1 /tmp/sidecar.log | awk '{print $2}')
echo "sidecar port: $PORT"
curl -s "http://127.0.0.1:$PORT/api/health"
echo ""
kill $SIDECAR_PID 2>/dev/null
```
Expected: prints `sidecar port: <number>` then `{"status":"ok","version":"0.1.0"}`.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat(sidecar): package scaffold + /api/health with READY handshake"
```

---

## Task 4: Sidecar `/api/chat` NDJSON streaming (TDD)

**Files:**
- Modify: `sidecar/floodmind_desktop_sidecar/app.py`
- Create: `sidecar/tests/test_chat.py`

**Interfaces:**
- Produces: `POST /api/chat` with JSON `{"messages":[{"role":"user","content":"..."}]}` → `200` `Content-Type: application/x-ndjson`, body = one JSON object per line: `{"type":"text","content":"..."}` ... `{"type":"done"}`.

- [ ] **Step 1: Write the failing chat test**

`sidecar/tests/test_chat.py`:
```python
import json


def test_chat_streams_ndjson(client):
    response = client.post(
        "/api/chat",
        json={"messages": [{"role": "user", "content": "hi"}]},
    )
    assert response.status_code == 200
    assert response.mimetype == "application/x-ndjson"

    lines = [ln for ln in response.data.decode().splitlines() if ln.strip()]
    events = [json.loads(ln) for ln in lines]

    assert events[-1] == {"type": "done"}
    text = "".join(e["content"] for e in events if e.get("type") == "text")
    assert "hi" in text


def test_chat_rejects_empty_messages(client):
    response = client.post("/api/chat", json={"messages": []})
    assert response.status_code == 400
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd sidecar
python -m pytest tests/test_chat.py -v
```
Expected: FAIL — 404 (route not defined) for the streaming test.

- [ ] **Step 3: Implement the chat route**

Replace the body of `sidecar/floodmind_desktop_sidecar/app.py` with:

```python
from __future__ import annotations

import json

from flask import Flask, Response, jsonify, request

from .agent import Agent, Message
from . import __version__


def create_app(agent: Agent) -> Flask:
    app = Flask(__name__)

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
```

- [ ] **Step 4: Run all sidecar tests to verify they pass**

```bash
python -m pytest -v
```
Expected: PASS (health + chat tests, 3 passed).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(sidecar): /api/chat NDJSON streaming via Agent seam"
```

---

## Task 5: Rust sidecar spawn + READY port discovery (TDD the parser)

**Files:**
- Create: `src-tauri/src/sidecar.rs`
- Modify: `src-tauri/src/lib.rs`

**Interfaces:**
- Produces: `pub fn parse_ready_line(line: &str) -> Option<u16>` (pure, unit-tested).
- Produces: Tauri command `get_sidecar_base_url(state) -> Result<String, String>` returning `http://127.0.0.1:<port>`.
- Consumes: `python -m floodmind_desktop_sidecar` must be importable in the active environment (Task 3).

- [ ] **Step 1: Write the failing unit test for the READY parser**

Create `src-tauri/src/sidecar.rs`:

```rust
use std::process::{Child, Command, Stdio};
use std::sync::{mpsc, Mutex};
use tauri::State;

/// Parse a line like `READY 52317` into a port number.
pub fn parse_ready_line(line: &str) -> Option<u16> {
    line.trim().strip_prefix("READY ").and_then(|p| p.trim().parse::<u16>().ok())
}

pub struct SidecarHandle {
    pub base_url: String,
    child: Mutex<Option<Child>>,
}

impl SidecarHandle {
    pub fn kill(&self) {
        if let Ok(mut guard) = self.child.lock() {
            if let Some(child) = guard.as_mut() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }
}

/// Spawn the Python sidecar, read its READY line, and return the handle.
pub fn spawn_sidecar() -> Result<SidecarHandle, String> {
    let python = std::env::var("FLOODMIND_PYTHON").unwrap_or_else(|_| "python".to_string());

    let mut child = Command::new(python)
        .args(["-m", "floodmind_desktop_sidecar"])
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .map_err(|e| format!("failed to spawn sidecar ({python}): {e}"))?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "could not capture sidecar stdout".to_string())?;

    // Read the first line on a thread; signal via channel with a timeout.
    let (tx, rx) = mpsc::channel::<Option<u16>>();
    std::thread::spawn(move || {
        use std::io::{BufRead, BufReader};
        let reader = BufReader::new(stdout);
        let mut first = true;
        for line in reader.lines().flatten() {
            if first {
                first = false;
                let port = parse_ready_line(&line);
                let _ = tx.send(port);
                if port.is_none() {
                    break;
                }
            } else {
                eprintln!("[sidecar] {line}");
            }
        }
    });

    let port = rx
        .recv_timeout(std::time::Duration::from_secs(15))
        .map_err(|e| format!("sidecar did not report READY in time: {e}"))?
        .ok_or_else(|| "sidecar's first line was not a READY line".to_string())?;

    Ok(SidecarHandle {
        base_url: format!("http://127.0.0.1:{port}"),
        child: Mutex::new(Some(child)),
    })
}

#[tauri::command]
pub fn get_sidecar_base_url(state: State<'_, SidecarHandle>) -> Result<String, String> {
    Ok(state.base_url.clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_ready_line() {
        assert_eq!(parse_ready_line("READY 52317\n"), Some(52317));
        assert_eq!(parse_ready_line("READY 80"), Some(80));
    }

    #[test]
    fn rejects_non_ready_line() {
        assert_eq!(parse_ready_line("some log line"), None);
        assert_eq!(parse_ready_line(""), None);
        assert_eq!(parse_ready_line("READY notanumber"), None);
    }
}
```

- [ ] **Step 2: Run the test to verify it fails (module not wired into the build yet)**

```bash
cd src-tauri
cargo test --lib parse_ready_line -- --nocapture
```
Expected: compile error — `sidecar` module not declared in `lib.rs` yet. (We'll wire it next, then this passes.)

- [ ] **Step 3: Wire the sidecar into `lib.rs`**

Replace `src-tauri/src/lib.rs` with:

```rust
mod sidecar;

use sidecar::SidecarHandle;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let sidecar = sidecar::spawn_sidecar().expect("failed to start Python sidecar");

    tauri::Builder::default()
        .manage(sidecar)
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                if let Some(handle) = window.app_handle().try_state::<SidecarHandle>() {
                    handle.kill();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            ping,
            sidecar::get_sidecar_base_url
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[tauri::command]
fn ping() -> String {
    "pong".to_string()
}
```

- [ ] **Step 4: Run the parser tests to verify they pass**

```bash
cd src-tauri
cargo test --lib
```
Expected: PASS — 2 tests (parses_ready_line, rejects_non_ready_line).

- [ ] **Step 5: Verify end-to-end: window opens and the command returns a base URL**

Add a temporary check by launching and calling the command from the frontend is Task 6; for now verify the build + spawn works:

```bash
cd "D:/chengs/9.project/Agent_desktop"
npm run tauri dev
```
Expected: A window opens (frontend still shows the placeholder). In the terminal you should NOT see a "failed to start Python sidecar" panic — meaning the sidecar spawned and printed READY. Check: the dev terminal logs `[sidecar]` lines if the Flask server logs anything. Ctrl+C to stop.

> If you see a sidecar spawn panic, confirm `python -m floodmind_desktop_sidecar` works on its own (Task 3 Step 8) and that the conda env `Agent_desktop` is active so `python` resolves.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(shell): spawn Python sidecar, parse READY line, expose base URL command"
```

---

## Task 6: Frontend sidecar client + health badge

**Files:**
- Create: `src/lib/sidecar-client.ts`
- Create: `src/components/HealthBadge.tsx`
- Modify: `src/App.tsx`

**Interfaces:**
- Produces: `getBaseUrl(): Promise<string>` (calls Tauri `get_sidecar_base_url`), `checkHealth(baseUrl): Promise<boolean>`.
- Consumes: Tauri command `get_sidecar_base_url` from Task 5.

- [ ] **Step 1: Create the sidecar client**

`src/lib/sidecar-client.ts`:
```ts
import { invoke } from "@tauri-apps/api/core";

export async function getBaseUrl(): Promise<string> {
  return invoke<string>("get_sidecar_base_url");
}

export async function checkHealth(baseUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/api/health`);
    if (!res.ok) return false;
    const body = await res.json();
    return body?.status === "ok";
  } catch {
    return false;
  }
}
```

- [ ] **Step 2: Create the HealthBadge component**

`src/components/HealthBadge.tsx`:
```tsx
import { useEffect, useState } from "react";
import { checkHealth, getBaseUrl } from "../lib/sidecar-client";

type Status = "checking" | "up" | "down";

export default function HealthBadge() {
  const [status, setStatus] = useState<Status>("checking");

  useEffect(() => {
    let cancelled = false;
    async function poll() {
      try {
        const baseUrl = await getBaseUrl();
        const ok = await checkHealth(baseUrl);
        if (!cancelled) setStatus(ok ? "up" : "down");
      } catch {
        if (!cancelled) setStatus("down");
      }
    }
    poll();
    const id = setInterval(poll, 5000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  const label = { checking: "连接中…", up: "sidecar 在线", down: "sidecar 离线" }[status];
  return <span className={`badge badge-${status}`}>{label}</span>;
}
```

- [ ] **Step 3: Wire HealthBadge into App**

Replace `src/App.tsx`:
```tsx
import HealthBadge from "./components/HealthBadge";

export default function App() {
  return (
    <main className="app">
      <header className="app-header">
        <h1>FloodMind Desktop</h1>
        <HealthBadge />
      </header>
    </main>
  );
}
```

Append to `src/app.css`:
```css
.app-header { display: flex; align-items: center; gap: 0.75rem; }
.badge { font-size: 0.8rem; padding: 0.15rem 0.5rem; border-radius: 999px; border: 1px solid currentColor; }
.badge-checking { color: #888; }
.badge-up { color: #2e7d32; }
.badge-down { color: #c62828; }
```

- [ ] **Step 4: Verify the badge shows "sidecar 在线"**

```bash
npm run tauri dev
```
Expected: Window opens; within a couple seconds the badge reads "sidecar 在线" (green). Ctrl+C to stop.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(ui): sidecar client + health badge"
```

---

## Task 7: NDJSON chat-stream consumer (TDD)

**Files:**
- Create: `src/lib/chat-stream.ts`
- Create: `src/lib/chat-stream.test.ts`

**Interfaces:**
- Produces: `streamChat(baseUrl, messages): AsyncGenerator<ChatEvent>` where `ChatEvent = { type: "text"; content: string } | { type: "done" }`.

- [ ] **Step 1: Write the failing test**

`src/lib/chat-stream.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { streamChat } from "./chat-stream";

function ndjsonResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "Content-Type": "application/x-ndjson" } });
}

describe("streamChat", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  it("parses NDJSON lines into events", async () => {
    (globalThis.fetch as any).mockResolvedValue(
      ndjsonResponse(['{"type":"text","content":"Hel"}\n', '{"type":"text","content":"lo"}\n', '{"type":"done"}\n'])
    );
    const events = [];
    for await (const e of streamChat("http://x", [{ role: "user", content: "hi" }])) {
      events.push(e);
    }
    const text = events.filter((e) => e.type === "text").map((e: any) => e.content).join("");
    expect(text).toBe("Hello");
    expect(events[events.length - 1]).toEqual({ type: "done" });
  });

  it("handles a chunk split across read boundaries", async () => {
    (globalThis.fetch as any).mockResolvedValue(
      ndjsonResponse(['{"type":"text","content":"a"', 'b"}\n{"type":"done"}\n'])
    );
    const events = [];
    for await (const e of streamChat("http://x", [{ role: "user", content: "hi" }])) {
      events.push(e);
    }
    const text = events.filter((e) => e.type === "text").map((e: any) => e.content).join("");
    expect(text).toBe("ab");
  });

  it("throws on non-ok response", async () => {
    (globalThis.fetch as any).mockResolvedValue(new Response("nope", { status: 500 }));
    await expect(
      (async () => {
        for await (const _ of streamChat("http://x", [{ role: "user", content: "hi" }])) {
        }
      })()
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npm test
```
Expected: FAIL — `Cannot find module './chat-stream'`.

- [ ] **Step 3: Implement the stream consumer**

`src/lib/chat-stream.ts`:
```ts
export type ChatMessage = { role: string; content: string };
export type ChatEvent = { type: "text"; content: string } | { type: "done" };

export async function* streamChat(
  baseUrl: string,
  messages: ChatMessage[]
): AsyncGenerator<ChatEvent> {
  const res = await fetch(`${baseUrl}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages }),
  });
  if (!res.ok || !res.body) {
    throw new Error(`chat request failed: ${res.status}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      yield JSON.parse(trimmed) as ChatEvent;
    }
  }
  const tail = buffer.trim();
  if (tail) yield JSON.parse(tail) as ChatEvent;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npm test
```
Expected: PASS — 3 tests.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(ui): NDJSON chat-stream consumer + tests"
```

---

## Task 8: Chat UI wiring (Zustand store + ChatView + Composer)

**Files:**
- Create: `src/state/chat-store.ts`
- Create: `src/components/ChatView.tsx`, `src/components/Composer.tsx`
- Modify: `src/App.tsx`, `src/app.css`

**Interfaces:**
- Consumes: `streamChat` (Task 7), `getBaseUrl` (Task 6).
- Produces: an end-to-end streaming chat loop.

- [ ] **Step 1: Create the Zustand store**

`src/state/chat-store.ts`:
```ts
import { create } from "zustand";
import { getBaseUrl } from "../lib/sidecar-client";
import { streamChat, type ChatMessage } from "../lib/chat-stream";

type Role = "user" | "assistant";

interface ChatState {
  messages: { role: Role; content: string }[];
  streaming: boolean;
  send: (text: string) => Promise<void>;
}

export const useChatStore = create<ChatState>((set, get) => ({
  messages: [],
  streaming: false,
  async send(text: string) {
    if (!text.trim() || get().streaming) return;

    const userMsg: ChatMessage = { role: "user", content: text };
    set((s) => ({
      messages: [...s.messages, { role: "user", content: text }],
      streaming: true,
    }));

    // Append an empty assistant message and grow it as chunks arrive.
    set((s) => ({ messages: [...s.messages, { role: "assistant", content: "" }] }));

    try {
      const baseUrl = await getBaseUrl();
      let acc = "";
      for await (const event of streamChat(baseUrl, [userMsg])) {
        if (event.type === "text") {
          acc += event.content;
          set((s) => {
            const msgs = [...s.messages];
            msgs[msgs.length - 1] = { role: "assistant", content: acc };
            return { messages: msgs };
          });
        }
      }
    } catch (e) {
      set((s) => {
        const msgs = [...s.messages];
        msgs[msgs.length - 1] = {
          role: "assistant",
          content: `⚠️ 出错：${(e as Error).message}`,
        };
        return { messages: msgs };
      });
    } finally {
      set({ streaming: false });
    }
  },
}));
```

- [ ] **Step 2: Create the Composer**

`src/components/Composer.tsx`:
```tsx
import { useState } from "react";
import { useChatStore } from "../state/chat-store";

export default function Composer() {
  const [text, setText] = useState("");
  const streaming = useChatStore((s) => s.streaming);
  const send = useChatStore((s) => s.send);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    send(text);
    setText("");
  }

  return (
    <form className="composer" onSubmit={submit}>
      <input
        value={text}
        placeholder="输入消息…"
        onChange={(e) => setText(e.target.value)}
        disabled={streaming}
      />
      <button type="submit" disabled={streaming || !text.trim()}>
        发送
      </button>
    </form>
  );
}
```

- [ ] **Step 3: Create the ChatView**

`src/components/ChatView.tsx`:
```tsx
import { useEffect, useRef } from "react";
import { useChatStore } from "../state/chat-store";

export default function ChatView() {
  const messages = useChatStore((s) => s.messages);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  return (
    <div className="chat">
      {messages.map((m, i) => (
        <div key={i} className={`msg msg-${m.role}`}>
          <span className="msg-role">{m.role === "user" ? "你" : "FloodMind"}</span>
          <div className="msg-content">{m.content || "…"}</div>
        </div>
      ))}
      <div ref={endRef} />
    </div>
  );
}
```

- [ ] **Step 4: Wire ChatView + Composer into App**

Replace `src/App.tsx`:
```tsx
import ChatView from "./components/ChatView";
import Composer from "./components/Composer";
import HealthBadge from "./components/HealthBadge";

export default function App() {
  return (
    <main className="app">
      <header className="app-header">
        <h1>FloodMind Desktop</h1>
        <HealthBadge />
      </header>
      <ChatView />
      <Composer />
    </main>
  );
}
```

Append to `src/app.css`:
```css
.app { display: flex; flex-direction: column; height: 100vh; }
.chat { flex: 1; overflow-y: auto; padding: 0 1.5rem; }
.msg { margin: 0.5rem 0; }
.msg-role { font-size: 0.75rem; color: #888; display: block; }
.msg-content { white-space: pre-wrap; }
.msg-user .msg-content { color: var(--text, #111); }
.msg-assistant .msg-content { color: #1a73e8; }
.composer { display: flex; gap: 0.5rem; padding: 1rem 1.5rem; border-top: 1px solid #3333; }
.composer input { flex: 1; padding: 0.5rem; font-size: 1rem; }
.composer button { padding: 0.5rem 1rem; }
```

- [ ] **Step 5: Verify end-to-end streaming chat**

```bash
npm run tauri dev
```
Expected: Window opens, badge turns green. Type "你好" and press Enter. The assistant message appears and visibly streams in three chunks, ending with `[sidecar stub] 收到：你好`. Sending a second message works. Ctrl+C to stop.

- [ ] **Step 6: Run the full test suite**

```bash
npm test
cd sidecar && python -m pytest -v && cd ..
cd src-tauri && cargo test --lib && cd ..
```
Expected: all green (3 vitest + 3 pytest + 2 cargo).

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(ui): end-to-end streaming chat with stub agent"
```

---

## Plan 1 Done — Definition of Done

- [ ] `npm run tauri dev` opens a desktop window.
- [ ] The window launches the Python sidecar automatically (badge shows "在线").
- [ ] Typing a message produces a visibly streamed reply.
- [ ] All automated tests pass (vitest + pytest + cargo test).
- [ ] Closing the window kills the sidecar process (verify no orphan `python -m floodmind_desktop_sidecar` remains: `tasklist | grep -i python` on Windows).

---

## Roadmap — Subsequent Plans (out of scope here)

- **Plan 2 — Real FloodMind integration:** Replace `StubAgent` with `floodmind.agent.create_flood_agent`; map FloodMind's event types (text / tool_call / todo / artifact / permission_request / error) onto the frontend. Add `floodmind` as a sidecar dependency (CPU-only, no torch).
- **Plan 3 — Workspace management:** Create/open/switch workspaces; `.floodmind/` scaffolding; session history isolation; project-level `AGENTS.md`.
- **Plan 4 — Rich chat surface:** tool-call cards, Todo progress panel, artifact panel, file operations (drag/select/path → direct fs read/write), permission approval bar, memory search.
- **Plan 5 — System integration & packaging:** system tray, global shortcut, native notifications, scheduled tasks; PyInstaller `--onedir` sidecar bundled via Tauri `externalBin` + `tauri-plugin-shell`; Windows/macOS installers; code signing; auto-update. **Carry-over from Plan 1 Task 5 review:** (a) close the orphan-on-hard-kill gap by wrapping the sidecar child in a Windows Job Object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` (kernel kills the child when the parent dies for any reason) — the current `on_window_event` hook only fires on a clean window close; (b) replace `spawn_sidecar().expect(...)` in `run()` with a graceful error dialog when python/the sidecar is missing.
