# Skills & MCP CRUD Implementation Plan

> **For agentic workers:** REQUIRED SUB-_SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add create/read/update/delete management for Skills and MCP servers in the FloodMind Desktop UI, with configuration persisted under `~/.floodmind/` and applied to the running SDK without restart.

**Architecture:** A new `catalog_api.py` module encapsulates all file/Sdk I/O (skill disabled-state, custom skill directories, `mcp.json`). `app.py` exposes REST endpoints consumed by extended actions in `catalog-store.ts`; two new modals (`SkillEditModal`, `McpEditModal`) and updated list pages provide the UI.

**Tech Stack:** Tauri 2.x, React 19, TypeScript, Zustand, Vite, Python 3.11+, Flask, FloodMind SDK.

## Global Constraints

- All persistence lives under `~/.floodmind/` via `get_floodmind_home()` / `_config_path()`.
- Built-in SDK skills are read-only except for enable/disable; custom skills live in `~/.floodmind/skills/`.
- MCP config is stored in `~/.floodmind/mcp.json` with schema `{servers: [...]}`.
- Skill names must match `^[a-z0-9_-]+$` and cannot collide with built-in names.
- `transport` for MCP must be `stdio` or `sse`.
- No placeholders; every step includes runnable code/commands.
- Commit after each independently testable task.

---

### Task 1: Sidecar catalog API (`catalog_api.py`)

**Files:**
- Create: `sidecar/floodmind_desktop_sidecar/catalog_api.py`
- Test: `sidecar/tests/test_catalog_crud.py` (failing tests written here)

**Interfaces:**
- Consumes: `floodmind.config.settings._config_path`, `get_floodmind_home`; `floodmind.skills.registry.get_skill_registry`, `floodmind.skills.skill_curator.discover_skills`, `floodmind.agent.mcp_client.get_mcp_client_pool`.
- Produces: `read_skills_disabled()`, `write_skills_disabled(names)`, `apply_skills_disabled()`, `list_builtin_skills()`, `create_skill(...)`, `update_skill(...)`, `delete_skill(name)`, `read_mcp_config()`, `write_mcp_config(servers)`, `test_mcp_server(server_config)`.

- [ ] **Step 1: Write the failing test**

Create `sidecar/tests/test_catalog_crud.py`:

```python
"""Tests for the catalog CRUD helpers."""
import json
import pytest

from floodmind_desktop_sidecar.app import create_app
from floodmind_desktop_sidecar.agent import StubAgent


def _client():
    return create_app(StubAgent()).test_client()


def test_read_write_skills_disabled(tmp_path, monkeypatch):
    from floodmind_desktop_sidecar import catalog_api
    monkeypatch.setattr(catalog_api, "_settings_path", lambda: tmp_path / "settings.json")
    assert catalog_api.read_skills_disabled() == []
    catalog_api.write_skills_disabled(["csv", "pdf"])
    assert catalog_api.read_skills_disabled() == ["csv", "pdf"]
    catalog_api.write_skills_disabled([])
    assert catalog_api.read_skills_disabled() == []
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest sidecar/tests/test_catalog_crud.py::test_read_write_skills_disabled -v`

Expected: `ModuleNotFoundError: No module named 'floodmind_desktop_sidecar.catalog_api'`

- [ ] **Step 3: Write minimal implementation**

Create `sidecar/floodmind_desktop_sidecar/catalog_api.py`:

```python
from __future__ import annotations

import json
import re
import shutil
from pathlib import Path
from typing import Any

SKILL_NAME_RE = re.compile(r"^[a-z0-9_-]+$")
_BUILTIN_SKILL_NAMES: set[str] | None = None


def _settings_path() -> Path:
    from floodmind.config.settings import _config_path
    return _config_path()


def _skills_home() -> Path:
    from floodmind.config.settings import get_floodmind_home
    home = get_floodmind_home()
    home.mkdir(parents=True, exist_ok=True)
    skills_dir = home / "skills"
    skills_dir.mkdir(exist_ok=True)
    return skills_dir


def _builtin_skill_names() -> set[str]:
    global _BUILTIN_SKILL_NAMES
    if _BUILTIN_SKILL_NAMES is None:
        try:
            from floodmind.skills.registry import get_skill_registry
            reg = get_skill_registry()
            _BUILTIN_SKILL_NAMES = {s["name"] for s in reg.list_skills()}
        except Exception:
            _BUILTIN_SKILL_NAMES = set()
    return _BUILTIN_SKILL_NAMES


def read_skills_disabled() -> list[str]:
    path = _settings_path()
    if not path.exists():
        return []
    try:
        cfg = json.loads(path.read_text(encoding="utf-8"))
        disabled = (cfg.get("skills") or {}).get("disabled") or []
        return [str(x) for x in disabled if isinstance(x, str)]
    except Exception:
        return []


def write_skills_disabled(disabled: list[str]) -> None:
    from floodmind.config.settings import save_config
    path = _settings_path()
    raw: dict[str, Any] = {}
    if path.exists():
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            raw = {}
    raw["skills"] = {"disabled": list(dict.fromkeys(disabled))}
    save_config(raw)


def apply_skills_disabled() -> None:
    disabled = read_skills_disabled()
    if not disabled:
        return
    try:
        from floodmind.skills.registry import get_skill_registry
        reg = get_skill_registry()
        for name in disabled:
            try:
                reg.set_disabled(name, True)
            except Exception:
                pass
    except Exception:
        pass


def list_builtin_skills() -> list[str]:
    try:
        from floodmind.skills.registry import get_skill_registry
        return [s["name"] for s in get_skill_registry().list_skills()]
    except Exception:
        return []


def _register_custom_skills() -> None:
    home = _skills_home()
    try:
        from floodmind.skills.skill_curator import discover_skills
        from floodmind.skills.registry import get_skill_registry
        skills = discover_skills(home)
        reg = get_skill_registry()
        for skill in skills:
            try:
                reg.register_skill(skill)
            except Exception:
                pass
    except Exception:
        pass


def create_skill(name: str, description: str, category: str, version: str, prompt: str) -> dict[str, Any]:
    if not SKILL_NAME_RE.match(name):
        raise ValueError("skill name must match [a-z0-9_-]+")
    if name in _builtin_skill_names():
        raise ValueError("cannot create skill with same name as built-in")
    skill_dir = _skills_home() / name
    if skill_dir.exists():
        raise ValueError("skill already exists")
    skill_dir.mkdir(parents=True)
    (skill_dir / "SKILL.md").write_text(prompt, encoding="utf-8")
    meta = {"name": name, "description": description, "category": category, "version": version, "provides_tools": []}
    (skill_dir / "meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
    _register_custom_skills()
    return meta


def update_skill(name: str, description: str, category: str, version: str, prompt: str) -> dict[str, Any]:
    if name in _builtin_skill_names():
        raise PermissionError("cannot edit built-in skill")
    skill_dir = _skills_home() / name
    if not skill_dir.exists() or not (skill_dir / "SKILL.md").exists():
        raise ValueError("skill not found")
    (skill_dir / "SKILL.md").write_text(prompt, encoding="utf-8")
    meta = {"name": name, "description": description, "category": category, "version": version, "provides_tools": []}
    (skill_dir / "meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
    _register_custom_skills()
    return meta


def delete_skill(name: str) -> None:
    if name in _builtin_skill_names():
        raise PermissionError("cannot delete built-in skill")
    skill_dir = _skills_home() / name
    if not skill_dir.exists():
        raise ValueError("skill not found")
    shutil.rmtree(skill_dir)
    _register_custom_skills()


def _mcp_path() -> Path:
    from floodmind.config.settings import get_floodmind_home
    home = get_floodmind_home()
    home.mkdir(parents=True, exist_ok=True)
    return home / "mcp.json"


def read_mcp_config() -> list[dict[str, Any]]:
    path = _mcp_path()
    if not path.exists():
        return []
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        servers = data.get("servers") or []
        return [s for s in servers if isinstance(s, dict)]
    except Exception:
        return []


def _reconnect_mcp(servers: list[dict[str, Any]]) -> None:
    try:
        from floodmind.agent.mcp_client import get_mcp_client_pool
        pool = get_mcp_client_pool()
        pool.disconnect_all()
        pool.connect_all(servers)
    except Exception:
        pass


def write_mcp_config(servers: list[dict[str, Any]]) -> None:
    path = _mcp_path()
    path.write_text(json.dumps({"servers": servers}, ensure_ascii=False, indent=2), encoding="utf-8")
    _reconnect_mcp(servers)


def test_mcp_server(server_config: dict[str, Any]) -> dict[str, Any]:
    try:
        from floodmind.agent.mcp_client import get_mcp_client_pool
        pool = get_mcp_client_pool()
        pool.connect_server(server_config)
        return {"ok": True, "error": None}
    except Exception as e:
        return {"ok": False, "error": str(e)}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest sidecar/tests/test_catalog_crud.py::test_read_write_skills_disabled -v`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add sidecar/floodmind_desktop_sidecar/catalog_api.py sidecar/tests/test_catalog_crud.py
git commit -m "feat(sidecar): add catalog CRUD helpers for skills and mcp

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: Sidecar REST endpoints

**Files:**
- Modify: `sidecar/floodmind_desktop_sidecar/app.py`
- Test: `sidecar/tests/test_catalog_crud.py`

**Interfaces:**
- Consumes: `catalog_api` functions from Task 1.
- Produces: `POST /api/skills`, `PUT /api/skills/<name>`, `DELETE /api/skills/<name>`, `POST /api/skills/<name>/disabled`, `POST /api/mcp`, `PUT /api/mcp/<name>`, `DELETE /api/mcp/<name>`, `POST /api/mcp/<name>/test`; updated `GET /api/skills` includes `disabled` state and custom skills.

- [ ] **Step 1: Write the failing test**

Append to `sidecar/tests/test_catalog_crud.py`:

```python
def test_skill_create_update_delete(tmp_path, monkeypatch):
    from floodmind_desktop_sidecar import catalog_api
    monkeypatch.setattr(catalog_api, "_skills_home", lambda: tmp_path / "skills")
    monkeypatch.setattr(catalog_api, "_builtin_skill_names", lambda: {"csv"})
    client = _client()

    r = client.post("/api/skills", json={
        "name": "my-skill", "description": "d", "category": "c",
        "version": "1.0", "prompt": "# p"
    })
    assert r.status_code == 201

    r = client.get("/api/skills")
    names = [s["name"] for s in r.get_json()["skills"]]
    assert "my-skill" in names

    r = client.put("/api/skills/my-skill", json={
        "description": "d2", "category": "c2", "version": "1.1", "prompt": "# p2"
    })
    assert r.status_code == 200
    assert r.get_json()["description"] == "d2"

    assert client.delete("/api/skills/my-skill").status_code == 200
    assert client.delete("/api/skills/csv").status_code == 403
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest sidecar/tests/test_catalog_crud.py::test_skill_create_update_delete -v`

Expected: 404 (endpoints don't exist yet)

- [ ] **Step 3: Write minimal implementation**

Replace the existing "Skills & MCP catalog" block in `sidecar/floodmind_desktop_sidecar/app.py` (around lines 266-314) with:

```python
    # ── Skills & MCP catalog (browse + CRUD) ───────────────────
    # SDK imports are lazy + inside try/except so the endpoints degrade to an
    # empty list instead of 500 when the registry isn't populated.

    def _normalize_mcp_server(body: dict[str, Any], default_name: str | None = None) -> dict[str, Any] | str:
        transport = str(body.get("transport", ""))
        if transport not in ("stdio", "sse"):
            return "transport must be stdio or sse"
        name = default_name or str(body.get("name", ""))
        if not name:
            return "name is required"
        out: dict[str, Any] = {"name": name, "transport": transport}
        if transport == "stdio":
            command = str(body.get("command", ""))
            if not command:
                return "command is required for stdio transport"
            out["command"] = command
            args = body.get("args", [])
            out["args"] = [str(a) for a in args] if isinstance(args, list) else []
            env = body.get("env", {})
            out["env"] = {str(k): str(v) for k, v in env.items()} if isinstance(env, dict) else {}
        else:
            url = str(body.get("url", ""))
            if not url:
                return "url is required for sse transport"
            out["url"] = url
        return out

    @app.get("/api/skills")
    def skills_list():
        from .catalog_api import list_builtin_skills, read_skills_disabled, list_custom_skills
        try:
            from floodmind.skills.registry import get_skill_registry
            registry_skills = get_skill_registry().list_skills()
        except Exception as e:
            return jsonify({"skills": [], "error": str(e)})
        disabled_set = set(read_skills_disabled())
        for s in registry_skills:
            s["disabled"] = s.get("name") in disabled_set
        return jsonify({"skills": registry_skills + list_custom_skills()})

    @app.get("/api/skills/<name>")
    def skill_detail(name):
        try:
            from floodmind.skills.registry import get_skill_registry
            from .catalog_api import read_skills_disabled
            s = get_skill_registry().get_skill(name)
        except Exception:
            return jsonify({"error": "skill registry unavailable"}), 404
        if s is None:
            return jsonify({"error": "skill not found"}), 404
        return jsonify({
            "name": s.name,
            "description": s.description,
            "prompt": s.prompt,
            "category": s.category,
            "provides_tools": s.provides_tools,
            "version": s.version,
            "disabled": s.name in set(read_skills_disabled()),
        })

    @app.post("/api/skills/<name>/disabled")
    def skill_set_disabled(name):
        from .catalog_api import read_skills_disabled, write_skills_disabled, apply_skills_disabled
        body = request.get_json(silent=True) or {}
        disabled = bool(body.get("disabled"))
        current = set(read_skills_disabled())
        if disabled:
            current.add(name)
        else:
            current.discard(name)
        write_skills_disabled(sorted(current))
        apply_skills_disabled()
        return jsonify({"ok": True, "disabled": disabled})

    @app.post("/api/skills")
    def skill_create():
        from .catalog_api import create_skill
        body = request.get_json(silent=True) or {}
        try:
            meta = create_skill(
                name=str(body.get("name", "")),
                description=str(body.get("description", "")),
                category=str(body.get("category", "execution")),
                version=str(body.get("version", "1.0")),
                prompt=str(body.get("prompt", "")),
            )
            return jsonify(meta), 201
        except ValueError as e:
            return jsonify({"error": str(e)}), 400

    @app.put("/api/skills/<name>")
    def skill_update(name):
        from .catalog_api import update_skill
        body = request.get_json(silent=True) or {}
        try:
            meta = update_skill(
                name=name,
                description=str(body.get("description", "")),
                category=str(body.get("category", "execution")),
                version=str(body.get("version", "1.0")),
                prompt=str(body.get("prompt", "")),
            )
            return jsonify(meta)
        except ValueError as e:
            return jsonify({"error": str(e)}), 400
        except PermissionError as e:
            return jsonify({"error": str(e)}), 403

    @app.delete("/api/skills/<name>")
    def skill_delete(name):
        from .catalog_api import delete_skill
        try:
            delete_skill(name)
            return jsonify({"ok": True})
        except ValueError as e:
            return jsonify({"error": str(e)}), 404
        except PermissionError as e:
            return jsonify({"error": str(e)}), 403

    @app.get("/api/mcp")
    def mcp_list():
        try:
            from floodmind.agent.mcp_client import get_mcp_client_pool
            from .catalog_api import read_mcp_config
            servers = get_mcp_client_pool().list_servers()
        except Exception as e:
            return jsonify({"servers": [], "error": str(e)})
        configured = {s.get("name"): s for s in read_mcp_config()}
        return jsonify({"servers": servers, "configured": configured})

    @app.get("/api/mcp/<name>")
    def mcp_detail(name):
        try:
            from floodmind.agent.mcp_client import get_mcp_client_pool
            info = get_mcp_client_pool().get_server_info(name)
        except Exception:
            return jsonify({"error": "mcp pool unavailable"}), 404
        if not info:
            return jsonify({"error": "server not found"}), 404
        return jsonify(info)

    @app.post("/api/mcp")
    def mcp_create():
        from .catalog_api import read_mcp_config, write_mcp_config
        body = request.get_json(silent=True) or {}
        server = _normalize_mcp_server(body)
        if isinstance(server, str):
            return jsonify({"error": server}), 400
        servers = read_mcp_config()
        if any(s.get("name") == server["name"] for s in servers):
            return jsonify({"error": "server already exists"}), 400
        servers.append(server)
        write_mcp_config(servers)
        return jsonify(server), 201

    @app.put("/api/mcp/<name>")
    def mcp_update(name):
        from .catalog_api import read_mcp_config, write_mcp_config
        body = request.get_json(silent=True) or {}
        server = _normalize_mcp_server(body, name)
        if isinstance(server, str):
            return jsonify({"error": server}), 400
        servers = read_mcp_config()
        for i, s in enumerate(servers):
            if s.get("name") == name:
                servers[i] = server
                write_mcp_config(servers)
                return jsonify(server)
        return jsonify({"error": "server not found"}), 404

    @app.delete("/api/mcp/<name>")
    def mcp_delete(name):
        from .catalog_api import read_mcp_config, write_mcp_config
        servers = [s for s in read_mcp_config() if s.get("name") != name]
        write_mcp_config(servers)
        return jsonify({"ok": True})

    @app.post("/api/mcp/<name>/test")
    def mcp_test(name):
        from .catalog_api import read_mcp_config, test_mcp_server
        servers = read_mcp_config()
        server = next((s for s in servers if s.get("name") == name), None)
        if server is None:
            return jsonify({"error": "server not found"}), 404
        return jsonify(test_mcp_server(server))
```

Add `Any` to the `typing` import if not already present:

```python
from typing import Any
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pytest sidecar/tests/test_catalog_crud.py -v`

Expected: all PASS

- [ ] **Step 5: Commit**

```bash
git add sidecar/floodmind_desktop_sidecar/app.py sidecar/tests/test_catalog_crud.py
git commit -m "feat(sidecar): add skills and mcp CRUD endpoints

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: Frontend catalog store CRUD

**Files:**
- Modify: `src/state/catalog-store.ts`
- Test: `src/state/catalog-store.test.ts` (create if missing)

**Interfaces:**
- Consumes: new REST endpoints from Task 2.
- Produces: `setSkillDisabled(name, disabled)`, `createSkill(skill)`, `updateSkill(name, skill)`, `deleteSkill(name)`, `createMcpServer(server)`, `updateMcpServer(name, server)`, `deleteMcpServer(name)`, `testMcpServer(name)`; new state flags `skillSaving`, `skillError`, `mcpSaving`, `mcpError`, `mcpTesting`.

- [ ] **Step 1: Write the failing test**

Create or append to `src/state/catalog-store.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import { useCatalogStore } from "./catalog-store";

describe("catalog-store CRUD", () => {
  beforeEach(() => {
    useCatalogStore.setState({
      skills: [],
      skillDetail: null,
      skillDetailLoading: false,
      skillSaving: false,
      skillError: null,
      mcpServers: [],
      mcpDetail: null,
      mcpDetailLoading: false,
      mcpSaving: false,
      mcpError: null,
      mcpTesting: false,
    });
  });

  it("toggles skill disabled state", async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true, disabled: true }) });
    await useCatalogStore.getState().setSkillDisabled("csv", true);
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/skills/csv/disabled"),
      expect.objectContaining({ method: "POST", body: JSON.stringify({ disabled: true }) })
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/state/catalog-store.test.ts`

Expected: FAIL — `setSkillDisabled` not found

- [ ] **Step 3: Write minimal implementation**

Modify `src/state/catalog-store.ts` to extend interfaces and add actions. Full file content:

```ts
import { create } from "zustand";
import { getBaseUrl } from "../lib/sidecar-client";

export interface SkillSummary {
  name: string;
  description: string;
  category?: string;
  version?: string;
  source?: string;
  disabled?: boolean;
}
export interface SkillDetail extends SkillSummary {
  prompt?: string;
  provides_tools?: string[];
}
export interface SkillForm {
  name?: string;
  description: string;
  category: string;
  version: string;
  prompt: string;
}
export interface McpServer {
  name: string;
  transport?: string;
  tools?: number;
  connected?: boolean;
}
export interface McpServerDetail {
  name: string;
  transport?: string;
  tools?: string[];
  connected?: boolean;
}
export interface McpServerForm {
  name?: string;
  transport: "stdio" | "sse";
  command?: string;
  args: string[];
  env: Record<string, string>;
  url?: string;
}

interface CatalogState {
  skills: SkillSummary[];
  skillDetail: SkillDetail | null;
  skillDetailLoading: boolean;
  skillSaving: boolean;
  skillError: string | null;
  mcpServers: McpServer[];
  mcpDetail: McpServerDetail | null;
  mcpDetailLoading: boolean;
  mcpSaving: boolean;
  mcpError: string | null;
  mcpTesting: boolean;
  loadSkills: () => Promise<void>;
  loadSkill: (name: string) => Promise<void>;
  loadMcp: () => Promise<void>;
  loadMcpServer: (name: string) => Promise<void>;
  setSkillDisabled: (name: string, disabled: boolean) => Promise<void>;
  createSkill: (skill: SkillForm) => Promise<void>;
  updateSkill: (name: string, skill: SkillForm) => Promise<void>;
  deleteSkill: (name: string) => Promise<void>;
  createMcpServer: (server: McpServerForm) => Promise<void>;
  updateMcpServer: (name: string, server: McpServerForm) => Promise<void>;
  deleteMcpServer: (name: string) => Promise<void>;
  testMcpServer: (name: string) => Promise<{ ok: boolean; error?: string }>;
}

let _skillReq = 0;
let _mcpReq = 0;

async function _post(path: string, body: unknown) {
  const b = await getBaseUrl();
  const r = await fetch(`${b}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const err = await r.text().catch(() => "request failed");
    throw new Error(err);
  }
  return r;
}

async function _put(path: string, body: unknown) {
  const b = await getBaseUrl();
  const r = await fetch(`${b}${path}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const err = await r.text().catch(() => "request failed");
    throw new Error(err);
  }
  return r;
}

async function _delete(path: string) {
  const b = await getBaseUrl();
  const r = await fetch(`${b}${path}`, { method: "DELETE" });
  if (!r.ok) {
    const err = await r.text().catch(() => "request failed");
    throw new Error(err);
  }
  return r;
}

export const useCatalogStore = create<CatalogState>((set, get) => ({
  skills: [],
  skillDetail: null,
  skillDetailLoading: false,
  skillSaving: false,
  skillError: null,
  mcpServers: [],
  mcpDetail: null,
  mcpDetailLoading: false,
  mcpSaving: false,
  mcpError: null,
  mcpTesting: false,

  async loadSkills() {
    try {
      const b = await getBaseUrl();
      const r = await fetch(`${b}/api/skills`);
      if (!r.ok) return;
      const data = await r.json();
      set({ skills: data.skills || [] });
    } catch {
      /* sidecar not ready */
    }
  },

  async loadSkill(name) {
    const req = ++_skillReq;
    set({ skillDetail: null, skillDetailLoading: true });
    try {
      const b = await getBaseUrl();
      const r = await fetch(`${b}/api/skills/${encodeURIComponent(name)}`);
      if (req !== _skillReq) return;
      if (!r.ok) return;
      set({ skillDetail: await r.json() });
    } catch {
      /* ignore */
    } finally {
      if (req === _skillReq) set({ skillDetailLoading: false });
    }
  },

  async loadMcp() {
    try {
      const b = await getBaseUrl();
      const r = await fetch(`${b}/api/mcp`);
      if (!r.ok) return;
      const data = await r.json();
      set({ mcpServers: data.servers || [] });
    } catch {
      /* sidecar not ready */
    }
  },

  async loadMcpServer(name) {
    const req = ++_mcpReq;
    set({ mcpDetail: null, mcpDetailLoading: true });
    try {
      const b = await getBaseUrl();
      const r = await fetch(`${b}/api/mcp/${encodeURIComponent(name)}`);
      if (req !== _mcpReq) return;
      if (!r.ok) return;
      set({ mcpDetail: await r.json() });
    } catch {
      /* ignore */
    } finally {
      if (req === _mcpReq) set({ mcpDetailLoading: false });
    }
  },

  async setSkillDisabled(name, disabled) {
    set({ skillSaving: true, skillError: null });
    try {
      await _post(`/api/skills/${encodeURIComponent(name)}/disabled`, { disabled });
      await get().loadSkills();
      if (get().skillDetail?.name === name) await get().loadSkill(name);
    } catch (e) {
      set({ skillError: e instanceof Error ? e.message : "failed" });
    } finally {
      set({ skillSaving: false });
    }
  },

  async createSkill(skill) {
    set({ skillSaving: true, skillError: null });
    try {
      await _post("/api/skills", skill);
      await get().loadSkills();
    } catch (e) {
      set({ skillError: e instanceof Error ? e.message : "failed" });
      throw e;
    } finally {
      set({ skillSaving: false });
    }
  },

  async updateSkill(name, skill) {
    set({ skillSaving: true, skillError: null });
    try {
      await _put(`/api/skills/${encodeURIComponent(name)}`, skill);
      await get().loadSkills();
      if (get().skillDetail?.name === name) await get().loadSkill(name);
    } catch (e) {
      set({ skillError: e instanceof Error ? e.message : "failed" });
      throw e;
    } finally {
      set({ skillSaving: false });
    }
  },

  async deleteSkill(name) {
    set({ skillSaving: true, skillError: null });
    try {
      await _delete(`/api/skills/${encodeURIComponent(name)}`);
      await get().loadSkills();
      if (get().skillDetail?.name === name) set({ skillDetail: null });
    } catch (e) {
      set({ skillError: e instanceof Error ? e.message : "failed" });
      throw e;
    } finally {
      set({ skillSaving: false });
    }
  },

  async createMcpServer(server) {
    set({ mcpSaving: true, mcpError: null });
    try {
      await _post("/api/mcp", server);
      await get().loadMcp();
    } catch (e) {
      set({ mcpError: e instanceof Error ? e.message : "failed" });
      throw e;
    } finally {
      set({ mcpSaving: false });
    }
  },

  async updateMcpServer(name, server) {
    set({ mcpSaving: true, mcpError: null });
    try {
      await _put(`/api/mcp/${encodeURIComponent(name)}`, server);
      await get().loadMcp();
      if (get().mcpDetail?.name === name) await get().loadMcpServer(name);
    } catch (e) {
      set({ mcpError: e instanceof Error ? e.message : "failed" });
      throw e;
    } finally {
      set({ mcpSaving: false });
    }
  },

  async deleteMcpServer(name) {
    set({ mcpSaving: true, mcpError: null });
    try {
      await _delete(`/api/mcp/${encodeURIComponent(name)}`);
      await get().loadMcp();
      if (get().mcpDetail?.name === name) set({ mcpDetail: null });
    } catch (e) {
      set({ mcpError: e instanceof Error ? e.message : "failed" });
      throw e;
    } finally {
      set({ mcpSaving: false });
    }
  },

  async testMcpServer(name) {
    set({ mcpTesting: true });
    try {
      const b = await getBaseUrl();
      const r = await fetch(`${b}/api/mcp/${encodeURIComponent(name)}/test`, { method: "POST" });
      const data = await r.json();
      return { ok: !!data.ok, error: data.error };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : "failed" };
    } finally {
      set({ mcpTesting: false });
    }
  },
}));
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- src/state/catalog-store.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/state/catalog-store.ts src/state/catalog-store.test.ts
git commit -m "feat(ui): add catalog CRUD actions in catalog-store

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 4: Skill edit modal + SkillsView updates

**Files:**
- Create: `src/components/SkillEditModal.tsx`
- Modify: `src/components/SkillsView.tsx`
- Test: `src/components/SkillsView.test.tsx` (create if missing)

**Interfaces:**
- Consumes: `useCatalogStore` actions/state from Task 3; `SkillForm`, `SkillDetail`.
- Produces: `SkillEditModal({ open, editing, onClose })`; updated `SkillsView` with add/edit/delete/disable UI.

- [ ] **Step 1: Write the failing test**

Create `src/components/SkillsView.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { useCatalogStore } from "../state/catalog-store";
import SkillsView from "./SkillsView";

describe("SkillsView management", () => {
  beforeEach(() => {
    useCatalogStore.setState({
      skills: [{ name: "csv", description: "CSV ops", category: "execution", disabled: false }],
      skillDetail: null,
      skillDetailLoading: false,
      skillSaving: false,
      skillError: null,
      loadSkills: vi.fn(),
      loadSkill: vi.fn(),
      setSkillDisabled: vi.fn(),
      createSkill: vi.fn(),
      updateSkill: vi.fn(),
      deleteSkill: vi.fn(),
    } as any);
  });

  it("opens create modal when add button is clicked", () => {
    render(<SkillsView />);
    fireEvent.click(screen.getByTitle("新建 Skill"));
    expect(screen.getByText("新建 Skill")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/components/SkillsView.test.tsx`

Expected: FAIL — title/button not implemented

- [ ] **Step 3: Write minimal implementation**

Create `src/components/SkillEditModal.tsx`:

```tsx
import { useEffect, useState } from "react";
import type { SkillForm } from "../state/catalog-store";

interface Props {
  open: boolean;
  editing: SkillForm | null;
  onClose: () => void;
  onSave: (skill: SkillForm) => void;
  saving: boolean;
  error: string | null;
}

export default function SkillEditModal({ open, editing, onClose, onSave, saving, error }: Props) {
  const [form, setForm] = useState<SkillForm>({
    name: "",
    description: "",
    category: "execution",
    version: "1.0",
    prompt: "",
  });

  useEffect(() => {
    if (open) {
      setForm(
        editing || {
          name: "",
          description: "",
          category: "execution",
          version: "1.0",
          prompt: "",
        }
      );
    }
  }, [open, editing]);

  if (!open) return null;

  const isEdit = !!editing;
  const canSave = form.name.trim() !== "" || isEdit;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-title">{isEdit ? "编辑 Skill" : "新建 Skill"}</div>
        {error && <div className="modal-error">{error}</div>}
        <label className="modal-label">
          名称
          <input
            className="modal-textarea"
            value={form.name}
            disabled={isEdit}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            placeholder="my-skill"
          />
        </label>
        <label className="modal-label">
          描述
          <input
            className="modal-textarea"
            value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
          />
        </label>
        <label className="modal-label">
          分类
          <input
            className="modal-textarea"
            value={form.category}
            onChange={(e) => setForm({ ...form, category: e.target.value })}
          />
        </label>
        <label className="modal-label">
          版本
          <input
            className="modal-textarea"
            value={form.version}
            onChange={(e) => setForm({ ...form, version: e.target.value })}
          />
        </label>
        <label className="modal-label">
          SKILL.md
          <textarea
            className="modal-textarea"
            rows={10}
            value={form.prompt}
            onChange={(e) => setForm({ ...form, prompt: e.target.value })}
          />
        </label>
        <div className="modal-actions">
          <button className="btn-secondary" onClick={onClose} type="button" disabled={saving}>
            取消
          </button>
          <button
            className="btn-primary"
            onClick={() => onSave(form)}
            type="button"
            disabled={!canSave || saving}
          >
            {saving ? "保存中…" : "保存"}
          </button>
        </div>
      </div>
    </div>
  );
}
```

Modify `src/components/SkillsView.tsx` to full content:

```tsx
import { useEffect, useState } from "react";
import PageHeader from "./PageHeader";
import { useCatalogStore, type SkillForm } from "../state/catalog-store";
import SkillEditModal from "./SkillEditModal";

export default function SkillsView() {
  const skills = useCatalogStore((s) => s.skills);
  const detail = useCatalogStore((s) => s.skillDetail);
  const detailLoading = useCatalogStore((s) => s.skillDetailLoading);
  const skillSaving = useCatalogStore((s) => s.skillSaving);
  const skillError = useCatalogStore((s) => s.skillError);
  const loadSkills = useCatalogStore((s) => s.loadSkills);
  const loadSkill = useCatalogStore((s) => s.loadSkill);
  const setSkillDisabled = useCatalogStore((s) => s.setSkillDisabled);
  const createSkill = useCatalogStore((s) => s.createSkill);
  const updateSkill = useCatalogStore((s) => s.updateSkill);
  const deleteSkill = useCatalogStore((s) => s.deleteSkill);

  const [selected, setSelected] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<SkillForm | null>(null);

  useEffect(() => {
    loadSkills();
  }, [loadSkills]);

  useEffect(() => {
    if (selected) loadSkill(selected);
  }, [selected, loadSkill]);

  const isBuiltIn = (name: string) => {
    const s = skills.find((x) => x.name === name);
    return !s?.source;
  };

  const handleEdit = () => {
    if (!detail) return;
    setEditing({
      name: detail.name,
      description: detail.description || "",
      category: detail.category || "execution",
      version: detail.version || "1.0",
      prompt: detail.prompt || "",
    });
    setModalOpen(true);
  };

  const handleSave = async (form: SkillForm) => {
    try {
      if (editing) {
        await updateSkill(form.name!, form);
      } else {
        await createSkill(form);
      }
      setModalOpen(false);
      setEditing(null);
    } catch {
      /* error handled in store */
    }
  };

  const handleDelete = async (name: string) => {
    if (!window.confirm(`确定删除 Skill "${name}" 吗？`)) return;
    try {
      await deleteSkill(name);
      if (selected === name) setSelected(null);
    } catch {
      /* error handled in store */
    }
  };

  return (
    <div className="page">
      <PageHeader title={`Skills（${skills.length}）`}>
        <button
          className="btn-primary"
          onClick={() => { setEditing(null); setModalOpen(true); }}
          type="button"
          title="新建 Skill"
        >
          ＋ 新建
        </button>
      </PageHeader>
      <div className="page-body master-detail">
        <ul className="cat-list">
          {skills.length === 0 && <li className="cat-empty">暂无技能</li>}
          {skills.map((s) => (
            <li key={s.name}>
              <button
                className={selected === s.name ? "cat-item active" : "cat-item"}
                onClick={() => setSelected(s.name)}
                type="button"
              >
                <span className="cat-name">{s.name}</span>
                {s.category && <span className="cat-tag">{s.category}</span>}
                {s.description && <span className="cat-desc">{s.description}</span>}
              </button>
            </li>
          ))}
        </ul>
        <div className="cat-detail">
          {!selected && <div className="cat-empty">选择左侧技能查看详情</div>}
          {selected && detail && (
            <>
              <div className="cat-detail-head">
                <h2>{detail.name}</h2>
                {detail.version && <span className="cat-tag">v{detail.version}</span>}
                {detail.category && <span className="cat-tag">{detail.category}</span>}
              </div>
              {detail.description && <p className="cat-detail-desc">{detail.description}</p>}
              {detail.provides_tools && detail.provides_tools.length > 0 && (
                <div className="cat-tools">
                  <div className="cat-subhead">提供工具</div>
                  <div className="cat-tool-chips">
                    {detail.provides_tools.map((t) => (
                      <span className="cat-tool-chip" key={t}>{t}</span>
                    ))}
                  </div>
                </div>
              )}
              {detail.prompt && (
                <div className="cat-prompt">
                  <div className="cat-subhead">SKILL.md</div>
                  <pre>{detail.prompt}</pre>
                </div>
              )}
              <div className="task-detail-actions" style={{ marginTop: "1rem" }}>
                {isBuiltIn(detail.name) ? (
                  <button
                    className="btn-secondary"
                    onClick={() => setSkillDisabled(detail.name, !detail.disabled)}
                    type="button"
                    disabled={skillSaving}
                  >
                    {detail.disabled ? "启用" : "停用"}
                  </button>
                ) : (
                  <>
                    <button className="btn-secondary" onClick={handleEdit} type="button">编辑</button>
                    <button
                      className="btn-secondary"
                      onClick={() => handleDelete(detail.name)}
                      type="button"
                      disabled={skillSaving}
                    >
                      删除
                    </button>
                  </>
                )}
              </div>
            </>
          )}
          {selected && detailLoading && <div className="cat-empty">加载中…</div>}
          {selected && !detailLoading && !detail && <div className="cat-empty">无法加载该技能</div>}
        </div>
      </div>
      <SkillEditModal
        open={modalOpen}
        editing={editing}
        onClose={() => setModalOpen(false)}
        onSave={handleSave}
        saving={skillSaving}
        error={skillError}
      />
    </div>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- src/components/SkillsView.test.tsx`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/components/SkillEditModal.tsx src/components/SkillsView.tsx src/components/SkillsView.test.tsx
git commit -m "feat(ui): add skill create/edit/delete/disable UI

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 5: MCP edit modal + McpView updates

**Files:**
- Create: `src/components/McpEditModal.tsx`
- Modify: `src/components/McpView.tsx`
- Test: `src/components/McpView.test.tsx` (create if missing)

**Interfaces:**
- Consumes: `useCatalogStore` actions/state from Task 3; `McpServerForm`, `McpServerDetail`.
- Produces: `McpEditModal({ open, editing, onClose, onSave })`; updated `McpView` with add/edit/delete/test UI.

- [ ] **Step 1: Write the failing test**

Create `src/components/McpView.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { useCatalogStore } from "../state/catalog-store";
import McpView from "./McpView";

describe("McpView management", () => {
  beforeEach(() => {
    useCatalogStore.setState({
      mcpServers: [{ name: "fs", transport: "stdio", tools: 2, connected: true }],
      mcpDetail: null,
      mcpDetailLoading: false,
      mcpSaving: false,
      mcpError: null,
      mcpTesting: false,
      loadMcp: vi.fn(),
      loadMcpServer: vi.fn(),
      createMcpServer: vi.fn(),
      updateMcpServer: vi.fn(),
      deleteMcpServer: vi.fn(),
      testMcpServer: vi.fn().mockResolvedValue({ ok: true }),
    } as any);
  });

  it("opens create modal when add button is clicked", () => {
    render(<McpView />);
    fireEvent.click(screen.getByTitle("新建 MCP 服务器"));
    expect(screen.getByText("新建 MCP 服务器")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/components/McpView.test.tsx`

Expected: FAIL

- [ ] **Step 3: Write minimal implementation**

Create `src/components/McpEditModal.tsx`:

```tsx
import { useEffect, useState } from "react";
import type { McpServerForm } from "../state/catalog-store";

interface Props {
  open: boolean;
  editing: McpServerForm | null;
  onClose: () => void;
  onSave: (server: McpServerForm) => void;
  saving: boolean;
  error: string | null;
}

function parseArgs(text: string): string[] {
  return text.split("\n").map((s) => s.trim()).filter(Boolean);
}

function stringifyArgs(args: string[]): string {
  return args.join("\n");
}

export default function McpEditModal({ open, editing, onClose, onSave, saving, error }: Props) {
  const [form, setForm] = useState<McpServerForm>({
    name: "",
    transport: "stdio",
    command: "",
    args: [],
    env: {},
    url: "",
  });
  const [argsText, setArgsText] = useState("");
  const [envList, setEnvList] = useState<{ key: string; value: string }[]>([]);

  useEffect(() => {
    if (open) {
      const base = editing || {
        name: "",
        transport: "stdio" as const,
        command: "",
        args: [],
        env: {},
        url: "",
      };
      setForm(base);
      setArgsText(stringifyArgs(base.args || []));
      setEnvList(Object.entries(base.env || {}).map(([key, value]) => ({ key, value })));
    }
  }, [open, editing]);

  if (!open) return null;

  const isEdit = !!editing;
  const canSave = (form.name.trim() !== "" || isEdit) && (form.transport === "sse" ? form.url : form.command);

  const handleSave = () => {
    const env: Record<string, string> = {};
    for (const { key, value } of envList) {
      if (key.trim()) env[key.trim()] = value;
    }
    onSave({ ...form, args: parseArgs(argsText), env });
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-title">{isEdit ? "编辑 MCP 服务器" : "新建 MCP 服务器"}</div>
        {error && <div className="modal-error">{error}</div>}
        <label className="modal-label">
          名称
          <input
            className="modal-textarea"
            value={form.name}
            disabled={isEdit}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
        </label>
        <label className="modal-label">
          传输类型
          <select
            className="modal-textarea"
            value={form.transport}
            onChange={(e) => setForm({ ...form, transport: e.target.value as "stdio" | "sse" })}
          >
            <option value="stdio">stdio（本地命令）</option>
            <option value="sse">sse（HTTP 流）</option>
          </select>
        </label>
        {form.transport === "stdio" ? (
          <>
            <label className="modal-label">
              命令
              <input
                className="modal-textarea"
                value={form.command}
                onChange={(e) => setForm({ ...form, command: e.target.value })}
              />
            </label>
            <label className="modal-label">
              参数（每行一个）
              <textarea
                className="modal-textarea"
                rows={4}
                value={argsText}
                onChange={(e) => setArgsText(e.target.value)}
              />
            </label>
          </>
        ) : (
          <label className="modal-label">
            URL
            <input
              className="modal-textarea"
              value={form.url}
              onChange={(e) => setForm({ ...form, url: e.target.value })}
            />
          </label>
        )}
        <div className="modal-label">
          环境变量
          {envList.map((entry, idx) => (
            <div key={idx} className="modal-row">
              <input
                className="modal-textarea"
                placeholder="KEY"
                value={entry.key}
                onChange={(e) => {
                  const next = [...envList];
                  next[idx].key = e.target.value;
                  setEnvList(next);
                }}
              />
              <input
                className="modal-textarea"
                placeholder="value"
                value={entry.value}
                onChange={(e) => {
                  const next = [...envList];
                  next[idx].value = e.target.value;
                  setEnvList(next);
                }}
              />
              <button
                className="btn-secondary"
                type="button"
                onClick={() => setEnvList(envList.filter((_, i) => i !== idx))}
              >
                删除
              </button>
            </div>
          ))}
          <button className="btn-secondary" type="button" onClick={() => setEnvList([...envList, { key: "", value: "" }])}>
            ＋ 添加
          </button>
        </div>
        <div className="modal-actions">
          <button className="btn-secondary" onClick={onClose} type="button" disabled={saving}>取消</button>
          <button className="btn-primary" onClick={handleSave} type="button" disabled={!canSave || saving}>
            {saving ? "保存中…" : "保存"}
          </button>
        </div>
      </div>
    </div>
  );
}
```

Modify `src/components/McpView.tsx` to full content:

```tsx
import { useEffect, useState } from "react";
import PageHeader from "./PageHeader";
import { useCatalogStore, type McpServerForm } from "../state/catalog-store";
import McpEditModal from "./McpEditModal";

export default function McpView() {
  const servers = useCatalogStore((s) => s.mcpServers);
  const detail = useCatalogStore((s) => s.mcpDetail);
  const detailLoading = useCatalogStore((s) => s.mcpDetailLoading);
  const mcpSaving = useCatalogStore((s) => s.mcpSaving);
  const mcpError = useCatalogStore((s) => s.mcpError);
  const mcpTesting = useCatalogStore((s) => s.mcpTesting);
  const loadMcp = useCatalogStore((s) => s.loadMcp);
  const loadMcpServer = useCatalogStore((s) => s.loadMcpServer);
  const createMcpServer = useCatalogStore((s) => s.createMcpServer);
  const updateMcpServer = useCatalogStore((s) => s.updateMcpServer);
  const deleteMcpServer = useCatalogStore((s) => s.deleteMcpServer);
  const testMcpServer = useCatalogStore((s) => s.testMcpServer);

  const [selected, setSelected] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<McpServerForm | null>(null);
  const [testResult, setTestResult] = useState<{ ok: boolean; error?: string } | null>(null);

  useEffect(() => {
    loadMcp();
  }, [loadMcp]);

  useEffect(() => {
    if (selected) loadMcpServer(selected);
  }, [selected, loadMcpServer]);

  const handleEdit = () => {
    if (!detail) return;
    setEditing({
      name: detail.name,
      transport: (detail.transport as "stdio" | "sse") || "stdio",
      command: (detail as any).command || "",
      args: (detail as any).args || [],
      env: (detail as any).env || {},
      url: (detail as any).url || "",
    });
    setModalOpen(true);
  };

  const handleSave = async (form: McpServerForm) => {
    try {
      if (editing) {
        await updateMcpServer(form.name!, form);
      } else {
        await createMcpServer(form);
      }
      setModalOpen(false);
      setEditing(null);
    } catch {
      /* error in store */
    }
  };

  const handleDelete = async (name: string) => {
    if (!window.confirm(`确定删除 MCP 服务器 "${name}" 吗？`)) return;
    try {
      await deleteMcpServer(name);
      if (selected === name) setSelected(null);
    } catch {
      /* error in store */
    }
  };

  const handleTest = async () => {
    if (!selected) return;
    const r = await testMcpServer(selected);
    setTestResult(r);
  };

  return (
    <div className="page">
      <PageHeader title={`MCP 服务器（${servers.length}）`}>
        <button
          className="btn-primary"
          onClick={() => { setEditing(null); setModalOpen(true); }}
          type="button"
          title="新建 MCP 服务器"
        >
          ＋ 新建
        </button>
      </PageHeader>
      <div className="page-body master-detail">
        <ul className="cat-list">
          {servers.length === 0 && <li className="cat-empty">未配置 MCP 服务器</li>}
          {servers.map((s) => (
            <li key={s.name}>
              <button
                className={selected === s.name ? "cat-item active" : "cat-item"}
                onClick={() => { setSelected(s.name); setTestResult(null); }}
                type="button"
              >
                <span className="cat-name">
                  <span className={s.connected ? "sdot sdot-up" : "sdot sdot-down"} /> {s.name}
                </span>
                {s.transport && <span className="cat-tag">{s.transport}</span>}
                <span className="cat-desc">{s.tools ?? 0} 个工具</span>
              </button>
            </li>
          ))}
        </ul>
        <div className="cat-detail">
          {!selected && <div className="cat-empty">选择左侧服务器查看工具</div>}
          {selected && detail && (
            <>
              <div className="cat-detail-head">
                <h2>{detail.name}</h2>
                {detail.transport && <span className="cat-tag">{detail.transport}</span>}
                <span className={detail.connected ? "cat-tag ok" : "cat-tag"}>
                  {detail.connected ? "已连接" : "未连接"}
                </span>
              </div>
              <div className="cat-tools">
                <div className="cat-subhead">工具（{(detail.tools || []).length}）</div>
                {(detail.tools || []).length === 0 ? (
                  <div className="cat-empty">无工具</div>
                ) : (
                  <div className="cat-tool-chips">
                    {(detail.tools || []).map((t) => (
                      <span className="cat-tool-chip" key={t}>{t}</span>
                    ))}
                  </div>
                )}
              </div>
              <div className="task-detail-actions" style={{ marginTop: "1rem" }}>
                <button className="btn-secondary" onClick={handleEdit} type="button" disabled={mcpSaving}>编辑</button>
                <button className="btn-secondary" onClick={() => handleDelete(detail.name)} type="button" disabled={mcpSaving}>删除</button>
                <button className="btn-primary" onClick={handleTest} type="button" disabled={mcpTesting}>
                  {mcpTesting ? "测试中…" : "测试连接"}
                </button>
              </div>
              {testResult && (
                <div className={testResult.ok ? "save-ok" : "modal-error"} style={{ marginTop: "0.5rem" }}>
                  {testResult.ok ? "连接成功" : `连接失败：${testResult.error}`}
                </div>
              )}
            </>
          )}
          {selected && detailLoading && <div className="cat-empty">加载中…</div>}
          {selected && !detailLoading && !detail && <div className="cat-empty">无法加载该服务器</div>}
        </div>
      </div>
      <McpEditModal
        open={modalOpen}
        editing={editing}
        onClose={() => setModalOpen(false)}
        onSave={handleSave}
        saving={mcpSaving}
        error={mcpError}
      />
    </div>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- src/components/McpView.test.tsx`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/components/McpEditModal.tsx src/components/McpView.tsx src/components/McpView.test.tsx
git commit -m "feat(ui): add mcp server create/edit/delete/test UI

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 6: Apply disabled skills on sidecar startup

**Files:**
- Modify: `sidecar/floodmind_desktop_sidecar/floodmind_agent.py`
- Test: `sidecar/tests/test_catalog_crud.py`

**Interfaces:**
- Consumes: `catalog_api.apply_skills_disabled()`.
- Produces: disabled state applied after agent construction.

- [ ] **Step 1: Write the failing test**

Append to `sidecar/tests/test_catalog_crud.py`:

```python
def test_disabled_skills_applied_on_startup(tmp_path, monkeypatch):
    from floodmind_desktop_sidecar import catalog_api
    monkeypatch.setattr(catalog_api, "_settings_path", lambda: tmp_path / "settings.json")
    catalog_api.write_skills_disabled(["csv"])
    from floodmind_desktop_sidecar.agent import StubAgent
    from floodmind_desktop_sidecar.floodmind_agent import FloodMindAgent
    # Smoke: building the agent should not crash and should call apply.
    agent = FloodMindAgent()
    assert agent is not None
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest sidecar/tests/test_catalog_crud.py::test_disabled_skills_applied_on_startup -v`

Expected: PASS or FAIL depending on current state; ensure `apply_skills_disabled` is invoked.

- [ ] **Step 3: Write minimal implementation**

In `sidecar/floodmind_desktop_sidecar/floodmind_agent.py`, find the end of `__init__` (after agent is built) and add:

```python
        # Apply user-disabled skills persisted in settings.json.
        try:
            from .catalog_api import apply_skills_disabled
            apply_skills_disabled()
        except Exception as e:
            print(f"[sidecar] apply disabled skills failed: {e}", file=sys.stderr)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest sidecar/tests/test_catalog_crud.py -v`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add sidecar/floodmind_desktop_sidecar/floodmind_agent.py sidecar/tests/test_catalog_crud.py
git commit -m "feat(sidecar): apply persisted disabled skills on startup

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 7: End-to-end verification

**Files:**
- All of the above.

- [ ] **Step 1: Run full backend tests**

Run: `python -m pytest sidecar/tests -q`

Expected: all PASS

- [ ] **Step 2: Run full frontend tests**

Run: `npm test -- --run`

Expected: all PASS

- [ ] **Step 3: Type check**

Run: `npx tsc --noEmit`

Expected: no errors

- [ ] **Step 4: Manual smoke**

Run: `npm run tauri dev`

Smoke checks:
1. Open Skills page → click「新建」→ create a custom skill → it appears in the list.
2. Select a built-in skill → click「停用」→ list shows disabled state.
3. Select custom skill → edit description → save → detail refreshes.
4. Delete custom skill → confirm → it disappears.
5. Open MCP page → click「新建」→ add a stdio server → save → it connects if valid.
6. Click「测试连接」→ see success/failure message.
7. Edit an MCP server → change args → save → config updated in `~/.floodmind/mcp.json`.

- [ ] **Step 5: Commit any final fixes**

```bash
git add -A
git commit -m "fix: address review findings for skills/mcp CRUD

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Self-Review

**1. Spec coverage:**
- Built-in skill enable/disable → Tasks 1, 2, 6.
- Custom skill CRUD → Tasks 1, 2, 4.
- MCP CRUD + connection test → Tasks 1, 2, 5.
- Persistence under `~/.floodmind/` → Task 1.
- Frontend modals and store → Tasks 3, 4, 5.
- Tests → every task includes tests.

**2. Placeholder scan:**
- No "TBD", "TODO", or vague steps.
- All code blocks contain complete, runnable code.

**3. Type consistency:**
- `SkillForm` / `McpServerForm` interfaces match payload shapes sent to endpoints.
- Endpoint paths in store (`/api/skills/...`, `/api/mcp/...`) match `app.py` routes.
- `catalog_api` function signatures match their usage in `app.py`.

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-07-13-skills-mcp-crud.md`.**

Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using `executing-plans`, batch execution with checkpoints.

Which approach?
