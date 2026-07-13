# Persona & Rules Editing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add SOUL.md (identity) and global AGENTS.md (rules) editors to the desktop Settings page, saving to `~/.floodmind/` and taking effect on the next message via an agent rebuild.

**Architecture:** Sidecar gains pure file-IO helpers (`config_api.py`) + 4 routes (`app.py`) + a `reload_persona()` agent rebuild. Frontend gains a persona slice in `config-store.ts` and a 3-tab `SettingsView.tsx` (模型 / 身份 / 规则). Save triggers `reload_persona()` so the new SOUL.md/AGENTS.md is baked into the running agent's prompt immediately; saving is disabled while a chat stream is active.

**Tech Stack:** Python/Flask sidecar, React 19 + TypeScript + Zustand + Vite, vitest + pytest.

## Global Constraints

- SOUL.md hard cap: `SOUL_MAX_CHARS = 20_000` (aligned with SDK `SOUL_MD_MAX_CHARS`). Enforce both client- and server-side.
- Edit ONLY `~/.floodmind/SOUL.md` and `~/.floodmind/AGENTS.md` (via `get_floodmind_home()`). Do NOT touch the legacy `~/.config/floodmind/AGENTS.md`.
- Empty/whitespace content = delete the file (both endpoints). SOUL empty → back to `DEFAULT_SOUL_MD` (`isDefault:true`); AGENTS empty → no global rules.
- No SDK changes. The desktop's full-mode agent ignores the passed `system_prompt`; identity comes from `load_soul_md()`.
- Save buttons in 身份/规则 tabs are disabled while `useChatStore.streaming` is true.
- Chinese UI copy throughout.

---

## File Structure

- `sidecar/floodmind_desktop_sidecar/config_api.py` — **modify**: add `read_soul`/`write_soul`/`read_agents_md`/`write_agents_md` (pure file IO).
- `sidecar/floodmind_desktop_sidecar/agent.py` — **modify**: add `reload_persona` to the `Agent` Protocol + `StubAgent`.
- `sidecar/floodmind_desktop_sidecar/floodmind_agent.py` — **modify**: add `FloodMindAgent.reload_persona()`.
- `sidecar/floodmind_desktop_sidecar/app.py` — **modify**: add 4 routes `GET/POST /api/config/soul`, `GET/POST /api/config/agents`.
- `sidecar/tests/test_config.py` — **modify**: add persona helper tests.
- `sidecar/tests/test_floodmind_agent.py` — **modify**: add `reload_persona` test.
- `sidecar/tests/test_conversations_api.py`-style — **new file** `sidecar/tests/test_persona_api.py`: route tests.
- `src/state/config-store.ts` — **modify**: add persona slice (`loadPersona`/`saveSoul`/`saveAgents`/`resetSoul`).
- `src/state/config-store.test.ts` — **new file**: persona slice tests.
- `src/components/SettingsView.tsx` — **modify**: 3-tab layout + identity/rules editors.
- `src/components/SettingsView.test.tsx` — **new file**: tab render + streaming-gate test.
- `src/app.css` — **modify**: `.settings-tabs`, `.persona-editor`, `.char-counter`.

---

## Task 1: Backend persona file-IO helpers

**Files:**
- Modify: `sidecar/floodmind_desktop_sidecar/config_api.py` (append to end)
- Test: `sidecar/tests/test_config.py` (append)

**Interfaces:**
- Produces: `read_soul() -> {content:str, isDefault:bool, path:str}`, `write_soul(content:str) -> same` (raises `ValueError` if >20000 chars), `read_agents_md() -> {content:str, path:str}`, `write_agents_md(content:str) -> same`. All resolve paths via `get_floodmind_home()`.

- [ ] **Step 1: Write the failing tests**

Append to `sidecar/tests/test_config.py` (update the top import line to add the four new helpers):

```python
from floodmind_desktop_sidecar.config_api import (
    read_model_config,
    write_model_config,
    read_soul,
    write_soul,
    read_agents_md,
    write_agents_md,
)


def test_read_soul_returns_default_when_absent(isolated_home):
    res = read_soul()
    assert res["isDefault"] is True
    assert "FloodMind" in res["content"]
    assert res["path"].endswith("SOUL.md")


def test_write_then_read_soul(isolated_home):
    res = write_soul("你是 TestBot，一个测试助手。")
    assert res["isDefault"] is False
    assert res["content"] == "你是 TestBot，一个测试助手。"
    again = read_soul()
    assert again["content"] == "你是 TestBot，一个测试助手。"
    assert again["isDefault"] is False


def test_write_soul_empty_deletes_back_to_default(isolated_home):
    write_soul("临时身份")
    res = write_soul("   ")
    assert res["isDefault"] is True
    assert not (isolated_home / "SOUL.md").exists()


def test_write_soul_rejects_too_long(isolated_home):
    with pytest.raises(ValueError):
        write_soul("x" * 20001)


def test_read_agents_md_absent_returns_empty(isolated_home):
    res = read_agents_md()
    assert res["content"] == ""
    assert res["path"].endswith("AGENTS.md")


def test_write_then_read_agents_md(isolated_home):
    res = write_agents_md("## 绘图风格\n- 必须有图例")
    assert res["content"] == "## 绘图风格\n- 必须有图例"
    assert "图例" in read_agents_md()["content"]


def test_write_agents_md_empty_deletes(isolated_home):
    write_agents_md("规则")
    assert read_agents_md()["content"] == "规则"
    res = write_agents_md("")
    assert res["content"] == ""
    assert not (isolated_home / "AGENTS.md").exists()
```

Note: the existing top import in `test_config.py` is `from floodmind_desktop_sidecar.config_api import read_model_config, write_model_config` — replace that single line with the multi-symbol import block above.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd sidecar && python -m pytest tests/test_config.py -v`
Expected: FAIL — `ImportError: cannot import name 'read_soul'`.

- [ ] **Step 3: Implement the helpers**

Append to `sidecar/floodmind_desktop_sidecar/config_api.py`:

```python
# ── Persona / rules files (SOUL.md + global AGENTS.md) ──────────────
# Identity + behavior-rule editors for the Settings GUI. These edit ONLY the
# ~/.floodmind/ files the runtime actually injects (NOT the legacy
# ~/.config/floodmind/AGENTS.md). Empty content = delete (back to default / no
# rules).

SOUL_MAX_CHARS = 20_000  # mirrors SDK floodmind.profile.soul.SOUL_MD_MAX_CHARS


def read_soul() -> dict:
    """Return {content, isDefault, path} for ~/.floodmind/SOUL.md.

    Missing/empty file → DEFAULT_SOUL_MD with isDefault=True.
    """
    from floodmind.config.settings import get_floodmind_home
    from floodmind.profile.soul import DEFAULT_SOUL_MD

    path = get_floodmind_home() / "SOUL.md"
    try:
        content = path.read_text(encoding="utf-8").strip() if path.exists() else ""
    except Exception:
        content = ""
    if not content:
        return {"content": DEFAULT_SOUL_MD, "isDefault": True, "path": str(path)}
    return {"content": content, "isDefault": False, "path": str(path)}


def write_soul(content: str) -> dict:
    """Write SOUL.md. Empty/whitespace → delete file (back to default).

    Raises ValueError if content exceeds SOUL_MAX_CHARS.
    """
    text = (content or "").strip()
    if len(text) > SOUL_MAX_CHARS:
        raise ValueError(f"SOUL.md 不得超过 {SOUL_MAX_CHARS} 字符")
    home = get_floodmind_home()
    home.mkdir(parents=True, exist_ok=True)
    path = home / "SOUL.md"
    if not text:
        try:
            path.unlink()
        except FileNotFoundError:
            pass
    else:
        path.write_text(text, encoding="utf-8")
    return read_soul()


def read_agents_md() -> dict:
    """Return {content, path} for ~/.floodmind/AGENTS.md. Missing → content=''."""
    path = get_floodmind_home() / "AGENTS.md"
    try:
        content = path.read_text(encoding="utf-8").strip() if path.exists() else ""
    except Exception:
        content = ""
    return {"content": content, "path": str(path)}


def write_agents_md(content: str) -> dict:
    """Write global AGENTS.md. Empty/whitespace → delete file (no global rules)."""
    text = (content or "").strip()
    home = get_floodmind_home()
    home.mkdir(parents=True, exist_ok=True)
    path = home / "AGENTS.md"
    if not text:
        try:
            path.unlink()
        except FileNotFoundError:
            pass
    else:
        path.write_text(text, encoding="utf-8")
    return read_agents_md()
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd sidecar && python -m pytest tests/test_config.py -v`
Expected: PASS (all model + persona tests).

- [ ] **Step 5: Commit**

```bash
git add sidecar/floodmind_desktop_sidecar/config_api.py sidecar/tests/test_config.py
git commit -m "feat(sidecar): persona file-IO helpers (SOUL.md + global AGENTS.md)"
```

---

## Task 2: `reload_persona()` on the agent

**Files:**
- Modify: `sidecar/floodmind_desktop_sidecar/agent.py` (Protocol + StubAgent)
- Modify: `sidecar/floodmind_desktop_sidecar/floodmind_agent.py` (add method near `reload_model`)
- Test: `sidecar/tests/test_floodmind_agent.py` (append)

**Interfaces:**
- Consumes: `FloodMindAgent._build_agent(session_id, persist_dir)`, `._memory_target(session_id)`, `._set_workspace()`, `._agent.session_id` (all exist).
- Produces: `Agent.reload_persona() -> bool` (True if rebuilt). Routes (Task 3) call this after writing files.

- [ ] **Step 1: Write the failing test**

Append to `sidecar/tests/test_floodmind_agent.py`:

```python
def test_reload_persona_rebuilds_and_rebinds_workspace():
    """reload_persona builds a fresh agent (same session) and re-binds the
    workspace so the new SOUL.md/AGENTS.md takes effect immediately."""
    import types
    from floodmind_desktop_sidecar.floodmind_agent import FloodMindAgent

    a = FloodMindAgent.__new__(FloodMindAgent)
    a._agent = types.SimpleNamespace(session_id="sid-1")

    built = []
    a._memory_target = lambda sid: (sid, "/tmp/mem")
    a._build_agent = lambda sid, persist_dir: built.append(sid) or types.SimpleNamespace(session_id=sid)
    rebinds = []
    a._set_workspace = lambda: rebinds.append(True)

    assert a.reload_persona() is True
    assert built == ["sid-1"]          # rebuilt with the SAME session_id
    assert rebinds == [True]           # workspace re-bound (+ prompt refreshed)
    assert a._agent.session_id == "sid-1"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd sidecar && python -m pytest tests/test_floodmind_agent.py::test_reload_persona_rebuilds_and_rebinds_workspace -v`
Expected: FAIL — `AttributeError: reload_persona`.

- [ ] **Step 3: Add the Protocol + StubAgent methods**

In `sidecar/floodmind_desktop_sidecar/agent.py`, add to the `Agent` Protocol (after `reload_model`):

```python
    def reload_persona(self) -> bool:
        """Rebuild the agent so SOUL.md / AGENTS.md edits take effect now.

        Returns True if rebuilt, False on failure (files are still saved; a
        restart will apply them).
        """
        ...
```

Add to `StubAgent` (after `reload_model`):

```python
    def reload_persona(self) -> bool:
        return True
```

- [ ] **Step 4: Add `FloodMindAgent.reload_persona`**

In `sidecar/floodmind_desktop_sidecar/floodmind_agent.py`, add this method immediately after `reload_model` (it mirrors `reload_model` but doesn't touch the model client):

```python
    def reload_persona(self) -> bool:
        """Rebuild the agent so edited SOUL.md / global AGENTS.md take effect.

        A fresh NativeFloodAgent re-reads SOUL.md via _build_stable_prompt and
        gets a new ContextRuntime (AGENTS.md TTL cache cleared). Re-binding the
        workspace then re-runs _init_executors, baking the new identity into the
        cached prompt so the NEXT message sees it. History is preserved
        (persist_dir reused). Safe to call mid-stream: the in-flight generator
        holds the old agent; self._agent swaps on the next stream.
        """
        try:
            sid = self._agent.session_id
            _, persist_dir = self._memory_target(sid)
            self._agent = self._build_agent(sid, persist_dir)
            self._set_workspace()  # rebind workspace + refresh cached prompt
            return True
        except Exception as e:
            print(f"[sidecar] reload_persona failed: {e}", file=sys.stderr)
            return False
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd sidecar && python -m pytest tests/test_floodmind_agent.py -v`
Expected: PASS (all existing + new reload_persona test).

- [ ] **Step 6: Commit**

```bash
git add sidecar/floodmind_desktop_sidecar/agent.py sidecar/floodmind_desktop_sidecar/floodmind_agent.py sidecar/tests/test_floodmind_agent.py
git commit -m "feat(sidecar): FloodMindAgent.reload_persona (rebuild for SOUL/AGENTS edits)"
```

---

## Task 3: Persona config routes

**Files:**
- Modify: `sidecar/floodmind_desktop_sidecar/app.py` (add 4 routes near the existing `/api/config/model` block, ~line 315-338)
- Test: `sidecar/tests/test_persona_api.py` (new file)

**Interfaces:**
- Consumes: `config_api.read_soul/write_soul/read_agents_md/write_agents_md` (Task 1), `agent.reload_persona()` (Task 2).
- Produces: `GET/POST /api/config/soul`, `GET/POST /api/config/agents`. POST body `{content:str}`; response includes `reloaded:bool`.

- [ ] **Step 1: Write the failing tests**

Create `sidecar/tests/test_persona_api.py`:

```python
"""Routes for SOUL.md + global AGENTS.md editing."""


def test_get_soul_returns_default(client, monkeypatch, tmp_path):
    monkeypatch.setenv("FLOODMIND_HOME", str(tmp_path))
    res = client.get("/api/config/soul")
    assert res.status_code == 200
    j = res.get_json()
    assert j["isDefault"] is True
    assert "FloodMind" in j["content"]


def test_post_soul_writes_and_reloads(monkeypatch, tmp_path):
    monkeypatch.setenv("FLOODMIND_HOME", str(tmp_path))
    from floodmind_desktop_sidecar.agent import StubAgent
    from floodmind_desktop_sidecar.app import create_app

    class RecAgent(StubAgent):
        def __init__(self):
            self.reloads = 0

        def reload_persona(self):
            self.reloads += 1
            return True

    agent = RecAgent()
    client = create_app(agent).test_client()

    res = client.post("/api/config/soul", json={"content": "你是 TestBot"})
    assert res.status_code == 200
    assert res.get_json()["isDefault"] is False
    assert agent.reloads == 1
    assert (tmp_path / "SOUL.md").read_text(encoding="utf-8") == "你是 TestBot"


def test_post_soul_too_long_returns_400(client, monkeypatch, tmp_path):
    monkeypatch.setenv("FLOODMIND_HOME", str(tmp_path))
    res = client.post("/api/config/soul", json={"content": "x" * 20001})
    assert res.status_code == 400


def test_post_soul_empty_deletes(client, monkeypatch, tmp_path):
    monkeypatch.setenv("FLOODMIND_HOME", str(tmp_path))
    (tmp_path / "SOUL.md").write_text("旧的", encoding="utf-8")
    res = client.post("/api/config/soul", json={"content": "  "})
    assert res.status_code == 200
    assert res.get_json()["isDefault"] is True
    assert not (tmp_path / "SOUL.md").exists()


def test_get_agents_returns_empty_when_absent(client, monkeypatch, tmp_path):
    monkeypatch.setenv("FLOODMIND_HOME", str(tmp_path))
    res = client.get("/api/config/agents")
    assert res.status_code == 200
    assert res.get_json()["content"] == ""


def test_post_agents_writes_and_reloads(monkeypatch, tmp_path):
    monkeypatch.setenv("FLOODMIND_HOME", str(tmp_path))
    from floodmind_desktop_sidecar.agent import StubAgent
    from floodmind_desktop_sidecar.app import create_app

    class RecAgent(StubAgent):
        def __init__(self):
            self.reloads = 0

        def reload_persona(self):
            self.reloads += 1
            return True

    agent = RecAgent()
    client = create_app(agent).test_client()

    res = client.post("/api/config/agents", json={"content": "## 规则\n- 用中文"})
    assert res.status_code == 200
    assert "规则" in res.get_json()["content"]
    assert agent.reloads == 1
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd sidecar && python -m pytest tests/test_persona_api.py -v`
Expected: FAIL — 404 for `/api/config/soul` (route not yet registered).

- [ ] **Step 3: Add the 4 routes**

In `sidecar/floodmind_desktop_sidecar/app.py`, immediately AFTER the existing `@app.post("/api/config/model")` handler's `return jsonify({"ok": True, "reloaded": reloaded, "model": snapshot})` line, add:

```python
    @app.get("/api/config/soul")
    def config_soul_get():
        from .config_api import read_soul
        try:
            return jsonify(read_soul())
        except Exception as e:  # pragma: no cover - defensive
            return jsonify({"error": str(e)}), 500

    @app.post("/api/config/soul")
    def config_soul_set():
        from .config_api import write_soul
        body = request.get_json(silent=True) or {}
        try:
            snapshot = write_soul(body.get("content", ""))
        except ValueError as e:
            return jsonify({"error": str(e)}), 400
        except Exception as e:  # pragma: no cover - defensive
            return jsonify({"error": str(e)}), 500
        reloaded = False
        try:
            reloaded = bool(agent.reload_persona())
        except Exception as e:  # pragma: no cover - defensive
            app.logger.warning("agent.reload_persona failed: %s", e)
        return jsonify({"ok": True, "reloaded": reloaded, **snapshot})

    @app.get("/api/config/agents")
    def config_agents_get():
        from .config_api import read_agents_md
        try:
            return jsonify(read_agents_md())
        except Exception as e:  # pragma: no cover - defensive
            return jsonify({"error": str(e)}), 500

    @app.post("/api/config/agents")
    def config_agents_set():
        from .config_api import write_agents_md
        body = request.get_json(silent=True) or {}
        try:
            snapshot = write_agents_md(body.get("content", ""))
        except Exception as e:  # pragma: no cover - defensive
            return jsonify({"error": str(e)}), 500
        reloaded = False
        try:
            reloaded = bool(agent.reload_persona())
        except Exception as e:  # pragma: no cover - defensive
            app.logger.warning("agent.reload_persona failed: %s", e)
        return jsonify({"ok": True, "reloaded": reloaded, **snapshot})
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd sidecar && python -m pytest tests/test_persona_api.py -v && python -m pytest sidecar/tests -v` (full suite for regressions)
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add sidecar/floodmind_desktop_sidecar/app.py sidecar/tests/test_persona_api.py
git commit -m "feat(sidecar): /api/config/{soul,agents} routes for persona editing"
```

---

## Task 4: Frontend persona slice in config-store

**Files:**
- Modify: `src/state/config-store.ts` (add persona state + actions)
- Test: `src/state/config-store.test.ts` (new file)

**Interfaces:**
- Consumes: `getBaseUrl` from `../lib/sidecar-client`; the 4 routes from Task 3.
- Produces: `useConfigStore` fields `soul/soulIsDefault/agents/personaLoading/personaSaving/personaError` + actions `loadPersona()/saveSoul(text)/saveAgents(text)/resetSoul()`.

- [ ] **Step 1: Write the failing tests**

Create `src/state/config-store.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { useConfigStore } from "./config-store";

vi.mock("../lib/sidecar-client", () => ({ getBaseUrl: vi.fn(async () => "http://test") }));

describe("config-store persona slice", () => {
  beforeEach(() => {
    useConfigStore.setState({
      soul: "",
      soulIsDefault: true,
      agents: "",
      personaLoading: false,
      personaSaving: false,
      personaError: null,
    });
    vi.clearAllMocks();
  });

  it("loadPersona fetches both endpoints and fills the store", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes("/soul")) {
        return new Response(JSON.stringify({ content: "我是Bot", isDefault: false }), { status: 200 });
      }
      return new Response(JSON.stringify({ content: "## 规则" }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await useConfigStore.getState().loadPersona();

    const s = useConfigStore.getState();
    expect(s.soul).toBe("我是Bot");
    expect(s.soulIsDefault).toBe(false);
    expect(s.agents).toBe("## 规则");
    expect(s.personaError).toBeNull();
    vi.unstubAllGlobals();
  });

  it("saveSoul rejects >20000 chars without sending a request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await useConfigStore.getState().saveSoul("x".repeat(20001));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(useConfigStore.getState().personaError).toContain("20000");
    vi.unstubAllGlobals();
  });

  it("saveSoul posts and updates the store from the response", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true, reloaded: true, content: "新身份", isDefault: false }), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);

    await useConfigStore.getState().saveSoul("新身份");

    expect(fetchMock).toHaveBeenCalledWith(
      "http://test/api/config/soul",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ content: "新身份" }) })
    );
    const s = useConfigStore.getState();
    expect(s.soul).toBe("新身份");
    expect(s.soulIsDefault).toBe(false);
    expect(s.personaSaving).toBe(false);
    vi.unstubAllGlobals();
  });

  it("resetSoul posts empty content (delete → default)", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true, reloaded: true, content: "默认", isDefault: true }), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);

    await useConfigStore.getState().resetSoul();

    expect(fetchMock).toHaveBeenCalledWith(
      "http://test/api/config/soul",
      expect.objectContaining({ body: JSON.stringify({ content: "" }) })
    );
    expect(useConfigStore.getState().soulIsDefault).toBe(true);
    vi.unstubAllGlobals();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- --run src/state/config-store.test.ts`
Expected: FAIL — `personaLoading`/`saveSoul` etc. undefined (slicing not added; setState can't set unknown keys cleanly, actions missing).

- [ ] **Step 3: Add the persona slice to the store**

In `src/state/config-store.ts`:

3a. Extend `ConfigState` (add after `error: string | null;` and before the closing brace of the interface):

```typescript
  // persona slice
  soul: string;
  soulIsDefault: boolean;
  agents: string;
  personaLoading: boolean;
  personaSaving: boolean;
  personaError: string | null;
  loadPersona: () => Promise<void>;
  saveSoul: (text: string) => Promise<boolean>;
  saveAgents: (text: string) => Promise<boolean>;
  resetSoul: () => Promise<void>;
```

3b. Add initial values inside `create<ConfigState>((set) => ({ ... })`, after `error: null,`:

```typescript
  soul: "",
  soulIsDefault: true,
  agents: "",
  personaLoading: false,
  personaSaving: false,
  personaError: null,
```

3c. Add the action implementations, after the existing `clearSaved: ...` line and before the closing `}))`:

```typescript

  async loadPersona() {
    set({ personaLoading: true, personaError: null });
    try {
      const b = await getBaseUrl();
      const [sr, ar] = await Promise.all([
        fetch(`${b}/api/config/soul`),
        fetch(`${b}/api/config/agents`),
      ]);
      const soul = sr.ok ? await sr.json() : { content: "", isDefault: true };
      const agents = ar.ok ? await ar.json() : { content: "" };
      set({
        soul: soul.content || "",
        soulIsDefault: !!soul.isDefault,
        agents: agents.content || "",
        personaLoading: false,
      });
    } catch {
      set({ personaLoading: false, personaError: "无法加载身份/规则" });
    }
  },

  async saveSoul(text) {
    if (text.length > 20000) {
      set({ personaError: "SOUL.md 不得超过 20000 字符" });
      return false;
    }
    set({ personaSaving: true, personaError: null });
    try {
      const b = await getBaseUrl();
      const r = await fetch(`${b}/api/config/soul`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: text }),
      });
      if (!r.ok) {
        set({ personaSaving: false, personaError: "保存失败" });
        return false;
      }
      const data = await r.json();
      set({
        soul: data.content || "",
        soulIsDefault: !!data.isDefault,
        personaSaving: false,
      });
      return true;
    } catch {
      set({ personaSaving: false, personaError: "无法连接到 sidecar" });
      return false;
    }
  },

  async saveAgents(text) {
    set({ personaSaving: true, personaError: null });
    try {
      const b = await getBaseUrl();
      const r = await fetch(`${b}/api/config/agents`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: text }),
      });
      if (!r.ok) {
        set({ personaSaving: false, personaError: "保存失败" });
        return false;
      }
      const data = await r.json();
      set({ agents: data.content || "", personaSaving: false });
      return true;
    } catch {
      set({ personaSaving: false, personaError: "无法连接到 sidecar" });
      return false;
    }
  },

  async resetSoul() {
    await this.saveSoul("");
  },
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- --run src/state/config-store.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/state/config-store.ts src/state/config-store.test.ts
git commit -m "feat(ui): persona slice in config-store (load/save SOUL + AGENTS)"
```

---

## Task 5: SettingsView 3-tab UI + CSS

**Files:**
- Modify: `src/components/SettingsView.tsx` (rewrite to tabbed layout; keep existing model form verbatim as the 模型 tab body)
- Modify: `src/app.css` (append tab + editor styles)
- Test: `src/components/SettingsView.test.tsx` (new file)

**Interfaces:**
- Consumes: `useConfigStore` (model slice + persona slice from Task 4), `useChatStore` (`streaming` for the save gate).
- Produces: the tabbed 设置 page.

- [ ] **Step 1: Write the failing test**

This repo's component tests use `renderToStaticMarkup` (SSR to an HTML string) under vitest's `node` environment — no jsdom, no `@testing-library`. Match that pattern. (SSR does not run `useEffect`, so the persona tabs render from the seeded store values directly.)

Create `src/components/SettingsView.test.tsx`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import SettingsView from "./SettingsView";
import { useConfigStore } from "../state/config-store";

// Persona tabs read `streaming` from the chat store; stub it hermetically.
vi.mock("../state/chat-store", () => ({
  useChatStore: (selector: (s: any) => any) => selector({ streaming: false }),
}));

describe("SettingsView tabs", () => {
  beforeEach(() => {
    useConfigStore.setState({
      model: null,
      providers: [],
      apiKeyPresent: false,
      baseURL: "",
      envOverrides: [],
      loading: false,
      saving: false,
      savedAt: null,
      reloadFailed: false,
      error: null,
      soul: "默认身份",
      soulIsDefault: true,
      agents: "",
      personaLoading: false,
      personaSaving: false,
      personaError: null,
    });
    vi.clearAllMocks();
  });

  it("renders the three tabs (模型 / 身份 / 规则)", () => {
    const html = renderToStaticMarkup(<SettingsView />);
    expect(html).toContain("模型");
    expect(html).toContain("身份");
    expect(html).toContain("规则");
  });
});
```

Note on coverage: tab *switching*, the SOUL textarea content, and the streaming-disabled gate are interactive behaviors that SSR cannot exercise. Those are covered by the `config-store` persona-slice unit tests (Task 4, which test the save/reset logic end-to-end with mocked fetch) plus the manual smoke checklist in **Verification**. This matches the repo's existing test philosophy (SSR render assertions + store unit tests; e.g. `TaskEditModal.test.tsx`).

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --run src/components/SettingsView.test.tsx`
Expected: FAIL — current SettingsView renders `PageHeader title="模型配置"` and no tab buttons, so "身份"/"规则" are absent from the HTML.

- [ ] **Step 3: Rewrite SettingsView to a tabbed layout**

Replace the entire contents of `src/components/SettingsView.tsx` with:

```typescript
import { useEffect, useState } from "react";
import PageHeader from "./PageHeader";
import { useConfigStore, type ModelForm } from "../state/config-store";
import { useChatStore } from "../state/chat-store";

type Tab = "model" | "identity" | "rules";

export default function SettingsView() {
  const [tab, setTab] = useState<Tab>("model");
  return (
    <div className="page">
      <PageHeader title="设置" />
      <div className="page-body settings-body">
        <div className="settings-tabs" role="tablist">
          <button role="tab" className={`settings-tab${tab === "model" ? " active" : ""}`} onClick={() => setTab("model")}>模型</button>
          <button role="tab" className={`settings-tab${tab === "identity" ? " active" : ""}`} onClick={() => setTab("identity")}>身份</button>
          <button role="tab" className={`settings-tab${tab === "rules" ? " active" : ""}`} onClick={() => setTab("rules")}>规则</button>
        </div>
        {tab === "model" && <ModelTab />}
        {tab === "identity" && <IdentityTab />}
        {tab === "rules" && <RulesTab />}
      </div>
    </div>
  );
}

/* ── 模型 tab：原 SettingsView 表单 ───────────────────────────── */
function ModelTab() {
  const model = useConfigStore((s) => s.model);
  const providers = useConfigStore((s) => s.providers);
  const apiKeyPresent = useConfigStore((s) => s.apiKeyPresent);
  const baseURL = useConfigStore((s) => s.baseURL);
  const envOverrides = useConfigStore((s) => s.envOverrides);
  const loading = useConfigStore((s) => s.loading);
  const saving = useConfigStore((s) => s.saving);
  const savedAt = useConfigStore((s) => s.savedAt);
  const reloadFailed = useConfigStore((s) => s.reloadFailed);
  const error = useConfigStore((s) => s.error);
  const load = useConfigStore((s) => s.load);
  const save = useConfigStore((s) => s.save);
  const clearSaved = useConfigStore((s) => s.clearSaved);

  const [form, setForm] = useState<ModelForm | null>(null);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (model) {
      setForm({
        provider: model.provider,
        model: model.model,
        apiKey: "",
        baseURL,
        temperature: model.temperature,
        maxTokens: model.maxTokens,
        enableReasoning: model.enableReasoning,
        enableSearch: model.enableSearch,
      });
    }
  }, [model, baseURL]);

  if (loading || !form) {
    return <div className="cat-empty">{error || "加载中…"}</div>;
  }

  const providerModels = providers.find((p) => p.id === form.provider)?.models || [];
  const set = (patch: Partial<ModelForm>) => {
    clearSaved();
    setForm((f) => (f ? { ...f, ...patch } : f));
  };

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (form) await save(form);
  }

  return (
    <>
      {envOverrides.length > 0 && (
        <div className="env-warn">
          ⚠ 以下环境变量正在覆盖配置文件，GUI 修改不会生效：{envOverrides.join(", ")}
        </div>
      )}
      {error && <div className="env-warn error">{error}</div>}
      {savedAt && (
        <div className={reloadFailed ? "env-warn" : "save-ok"}>
          {reloadFailed ? "⚠ 已保存，但热重载失败——重启后生效" : "✓ 已保存并重载模型"}
        </div>
      )}
      <form className="settings-form" onSubmit={onSubmit}>
        <label className="field">
          <span className="field-label">服务商</span>
          <select value={form.provider} onChange={(e) => {
            const pid = e.target.value;
            const p = providers.find((x) => x.id === pid);
            clearSaved();
            setForm((f) => f ? { ...f, provider: pid, apiKey: "", baseURL: p?.baseURL || "", model: p?.models?.[0] || "" } : f);
          }}>
            {providers.map((p) => (
              <option key={p.id} value={p.id}>{p.name} ({p.id})</option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="field-label">模型</span>
          <input list="model-options" value={form.model} onChange={(e) => set({ model: e.target.value })} placeholder="模型 ID" />
          <datalist id="model-options">
            {providerModels.map((m) => (<option key={m} value={m} />))}
          </datalist>
        </label>
        <label className="field">
          <span className="field-label">API Key {apiKeyPresent && !form.apiKey && <em>（已设置，留空保持不变）</em>}</span>
          <input type="password" value={form.apiKey} onChange={(e) => set({ apiKey: e.target.value })} placeholder={apiKeyPresent ? "••••••（留空不修改）" : "输入 API Key"} autoComplete="off" />
        </label>
        <label className="field">
          <span className="field-label">Base URL</span>
          <input value={form.baseURL} onChange={(e) => set({ baseURL: e.target.value })} placeholder="https://…" />
        </label>
        <div className="field-row">
          <label className="field">
            <span className="field-label">温度（0–2）</span>
            <input type="number" step="0.1" min="0" max="2" value={form.temperature} onChange={(e) => set({ temperature: parseFloat(e.target.value) || 0 })} />
          </label>
          <label className="field">
            <span className="field-label">最大 Token</span>
            <input type="number" step="1" min="1" value={form.maxTokens} onChange={(e) => set({ maxTokens: Math.trunc(parseInt(e.target.value, 10) || 0) })} />
          </label>
        </div>
        <div className="field-row toggles">
          <label className="toggle">
            <input type="checkbox" checked={form.enableReasoning} onChange={(e) => set({ enableReasoning: e.target.checked })} /> 推理模式
          </label>
          <label className="toggle">
            <input type="checkbox" checked={form.enableSearch} onChange={(e) => set({ enableSearch: e.target.checked })} /> 联网搜索
          </label>
        </div>
        <button className="save-btn" type="submit" disabled={saving}>{saving ? "保存中…" : "保存并重载"}</button>
      </form>
    </>
  );
}

/* ── 身份 tab：SOUL.md ───────────────────────────────────────── */
function IdentityTab() {
  const soul = useConfigStore((s) => s.soul);
  const isDefault = useConfigStore((s) => s.soulIsDefault);
  const loading = useConfigStore((s) => s.personaLoading);
  const saving = useConfigStore((s) => s.personaSaving);
  const error = useConfigStore((s) => s.personaError);
  const loadPersona = useConfigStore((s) => s.loadPersona);
  const saveSoul = useConfigStore((s) => s.saveSoul);
  const resetSoul = useConfigStore((s) => s.resetSoul);
  const streaming = useChatStore((s) => s.streaming);
  const [draft, setDraft] = useState(soul);

  useEffect(() => { loadPersona(); }, [loadPersona]);
  useEffect(() => { setDraft(soul); }, [soul]);

  const over = draft.length > 20000;
  const dirty = draft !== soul;
  const canSave = !streaming && !saving && dirty && !over;

  if (loading) return <div className="cat-empty">加载中…</div>;
  return (
    <div className="persona-editor">
      <p className="persona-hint">SOUL.md 决定智能体的身份与职责，对所有会话生效。</p>
      {error && <div className="env-warn error">{error}</div>}
      <textarea
        aria-label="SOUL.md 编辑器"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        rows={16}
      />
      <div className="persona-bottom">
        <span className={`char-counter${over ? " over" : ""}`}>{draft.length} / 20000</span>
        <div className="persona-actions">
          <button type="button" className="btn-secondary" onClick={() => resetSoul()} disabled={streaming || saving || isDefault}>恢复默认</button>
          <button type="button" className="save-btn" onClick={() => saveSoul(draft)} disabled={!canSave}>
            {saving ? "保存中…" : "保存"}
          </button>
        </div>
      </div>
      {streaming && <div className="env-warn">任务执行中，结束后保存生效。</div>}
    </div>
  );
}

/* ── 规则 tab：全局 AGENTS.md ────────────────────────────────── */
function RulesTab() {
  const agents = useConfigStore((s) => s.agents);
  const loading = useConfigStore((s) => s.personaLoading);
  const saving = useConfigStore((s) => s.personaSaving);
  const error = useConfigStore((s) => s.personaError);
  const loadPersona = useConfigStore((s) => s.loadPersona);
  const saveAgents = useConfigStore((s) => s.saveAgents);
  const streaming = useChatStore((s) => s.streaming);
  const [draft, setDraft] = useState(agents);

  useEffect(() => { loadPersona(); }, [loadPersona]);
  useEffect(() => { setDraft(agents); }, [agents]);

  const dirty = draft !== agents;
  const canSave = !streaming && !saving && dirty;

  if (loading) return <div className="cat-empty">加载中…</div>;
  return (
    <div className="persona-editor">
      <p className="persona-hint">全局行为规则（AGENTS.md）：绘图风格、文档模板、用词偏好等。留空则无全局规则。</p>
      {error && <div className="env-warn error">{error}</div>}
      <textarea
        aria-label="AGENTS.md 编辑器"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        rows={16}
      />
      <div className="persona-bottom">
        <span className="char-counter">{draft.length} 字符</span>
        <button type="button" className="save-btn" onClick={() => saveAgents(draft)} disabled={!canSave}>
          {saving ? "保存中…" : "保存"}
        </button>
      </div>
      {streaming && <div className="env-warn">任务执行中，结束后保存生效。</div>}
    </div>
  );
}
```

- [ ] **Step 4: Add the CSS**

Append to `src/app.css`:

```css
/* ── Settings tabs + persona editor ─────────────────────── */
.settings-tabs {
  display: flex;
  gap: 0.25rem;
  border-bottom: 1px solid var(--border);
  margin-bottom: 1.25rem;
}
.settings-tab {
  background: transparent;
  border: none;
  border-bottom: 2px solid transparent;
  padding: 0.5rem 1rem;
  font: inherit;
  font-size: 14px;
  color: var(--muted);
  cursor: pointer;
}
.settings-tab:hover {
  color: var(--fg-secondary);
}
.settings-tab.active {
  color: var(--fg);
  border-bottom-color: var(--accent);
}

.persona-editor textarea {
  width: 100%;
  min-height: 320px;
  resize: vertical;
  border: 1px solid var(--border);
  border-radius: 0.5rem;
  padding: 0.6rem 0.75rem;
  font-family: var(--font-mono, monospace);
  font-size: 13px;
  line-height: 1.55;
  background: var(--surface);
  color: var(--fg);
  outline: none;
}
.persona-editor textarea:focus {
  border-color: var(--accent);
}
.persona-hint {
  margin: 0 0 0.6rem;
  color: var(--muted);
  font-size: 13px;
}
.persona-bottom {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 0.5rem;
}
.persona-actions {
  display: flex;
  gap: 0.5rem;
}
.char-counter {
  font-size: 12px;
  color: var(--muted);
}
.char-counter.over {
  color: #dc2626;
}
.btn-secondary {
  background: transparent;
  border: 1px solid var(--border);
  padding: 0.4rem 0.85rem;
  border-radius: 0.5rem;
  font: inherit;
  font-size: 13px;
  color: var(--fg-secondary);
  cursor: pointer;
}
.btn-secondary:hover:not(:disabled) {
  background: var(--surface-2);
}
.btn-secondary:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm test -- --run src/components/SettingsView.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 6: Run full frontend suite + type-check build**

Run: `npm test -- --run && npm run build`
Expected: all vitest tests PASS; build succeeds.

- [ ] **Step 7: Commit**

```bash
git add src/components/SettingsView.tsx src/components/SettingsView.test.tsx src/app.css
git commit -m "feat(ui): tabbed Settings — 模型/身份/规则 (SOUL.md + global AGENTS.md editors)"
```

---

## Verification (end-to-end, after all tasks)

1. `cd sidecar && python -m pytest` — full Python suite green.
2. `npm test -- --run && npm run build` — frontend green.
3. `npm run tauri dev` smoke:
   - Settings → 身份 tab: edit SOUL.md → 保存 → "已保存"; send a chat message → agent adopts new identity.
   - 规则 tab: add "回答必须以『收到』结尾" → 保存 → next reply ends with 收到.
   - During a streaming task, both 保存 buttons are disabled and the "任务执行中" hint shows.
   - 恢复默认 returns SOUL.md to `DEFAULT_SOUL_MD`.

## Self-Review (completed during authoring)

- **Spec coverage**: §4.1 helpers → Task 1; §4.2 routes → Task 3; §4.3 reload_persona → Task 2; §5.1 store slice → Task 4; §5.2/5.3 UI+CSS → Task 5; §7 streaming-gate → Task 5 (`streaming` disables save) + smoke; §8 tests → TDD in Tasks 1–5 (Task 5 SettingsView test is SSR-structural per repo convention; persona save/reset logic covered by Task 4 store tests; streaming-gate + tab-switch verified by smoke). Workspace-level AGENTS.md explicitly out-of-scope (§9).
- **Placeholders**: none — every code step shows complete code.
- **Type consistency**: `reload_persona() -> bool` consistent across Protocol, StubAgent, FloodMindAgent, route call sites, and the `reloaded` response field. `saveSoul/saveAgents -> Promise<boolean>` consistent in store and tests. `SOUL_MAX_CHARS = 20_000` matches the 20000 used in frontend validation and tests.
