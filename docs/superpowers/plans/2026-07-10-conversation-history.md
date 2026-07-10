# Conversation History Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Multiple persistent, per-workspace conversations with isolated agent memory (shared experience library), browsable/resumable from a sidebar list.

**Architecture:** Sidecar owns a filesystem `ConversationStore` (one JSON per conversation + an `index.json` workspace→active pointer); each conversation carries a unique `session_id` so the SDK `DualMemory` chat-history is isolated, while the global experience library and long-term memory stay shared. The frontend owns the block transcript; after each completed turn it POSTs the turn pair to the sidecar. Switching conversations rebuilds the SDK agent bound to that conversation's `session_id`. Titles are LLM-generated in the background (reusing the SDK server-layer prompt).

**Tech Stack:** Python 3 / Flask sidecar (pytest), React 19 / Zustand / Vite / TypeScript frontend (vitest), FloodMind SDK (`DualMemory`, `ModelClient`).

## Global Constraints

- Sidecar tests must run **without the real SDK** — use `StubAgent`/`Spy` subclasses and `FloodMindAgent.__new__()` to bypass `__init__`, matching `sidecar/tests/` style. Lazy SDK imports inside methods, never at module top of `conversation_store.py`.
- `_app_data_dir()` is `Path.cwd()`; tests isolate it with `monkeypatch.chdir(tmp_path)`.
- Memory layout (must not drift): SDK memory dir = `<cwd>/<session_id>/memory` (from `FloodMindAgent._memory_target`); conversation records = `<cwd>/conversations/<conv_id>.json`; active pointer = `<cwd>/conversations/index.json`.
- Conversation `turns` are stored **opaque** (the sidecar never interprets block structure); shape == frontend `Msg[]`.
- No `@`-token in any persisted tool input gets mangled (existing project gotcha — irrelevant to pure store code, but keep tool-input out of titles).
- After each task: `npm run build && npm test` (frontend) and `python -m pytest sidecar/tests` (sidecar) must be green before committing.

---

## File Structure

**Sidecar (Python):**
- **Create** `sidecar/floodmind_desktop_sidecar/conversation_store.py` — SDK-free `ConversationStore`: CRUD over `conversations/*.json`, `index.json` active pointer, memory-dir cleanup on delete.
- **Modify** `sidecar/floodmind_desktop_sidecar/agent.py` — add `activate_conversation(session_id)` + `generate_title(message)` to the `Agent` Protocol and `StubAgent`.
- **Modify** `sidecar/floodmind_desktop_sidecar/floodmind_agent.py` — implement `activate_conversation` (rebuild via `_build_agent` + `_memory_target`) and `generate_title` (mirror SDK server-layer prompt).
- **Modify** `sidecar/floodmind_desktop_sidecar/app.py` — 6 conversation endpoints + `_first_user_text` / `_apply_title` helpers + `conversation_store`/`title_spawner` seams on `create_app`.
- **Create** `sidecar/tests/test_conversation_store.py`, **Modify** `sidecar/tests/test_conversations_api.py` (new), **Modify** `sidecar/tests/test_floodmind_agent.py`, **Modify** `sidecar/tests/conftest.py`.

**Frontend (TS/React):**
- **Create** `src/state/conversation-store.ts` — Zustand store wrapping the 6 endpoints.
- **Modify** `src/state/chat-store.ts` — add `conversationId`, post turns after a finalized turn, `startNew`, `loadConversation`, local-only `reset`.
- **Modify** `src/components/Sidebar.tsx` — "会话" section + 新会话 wired to `startNew`.
- **Modify** `src/App.tsx` — on workspace change, load list + ensure an active conversation.
- **Modify** `src/app.css` — `.conv-item` / `.conv-open` / `.conv-del` styles.
- **Modify** `src/state/chat-store.test.ts`, **Create** `src/state/conversation-store.test.ts`.

---

## Task 1: ConversationStore (SDK-free CRUD + active pointer)

**Files:**
- Create: `sidecar/floodmind_desktop_sidecar/conversation_store.py`
- Test: `sidecar/tests/test_conversation_store.py`

**Interfaces:**
- Produces: `ConversationStore(app_data_root: Path, clock=time.now) -> ` with methods `create(workspace, title="") -> dict`, `get(conv_id) -> dict|None`, `list(workspace) -> list[dict]`, `append_turns(conv_id, turns) -> dict|None`, `update_title(conv_id, title) -> bool`, `delete(conv_id) -> str|None` (returns session_id), `set_active(workspace, conv_id)`, `get_active(workspace) -> str|None`. Each list item is `{id,title,updated_at,active}`; full records add `session_id,workspace,created_at,turns`.

- [ ] **Step 1: Write the failing tests**

Create `sidecar/tests/test_conversation_store.py`:

```python
from pathlib import Path

from floodmind_desktop_sidecar.conversation_store import ConversationStore


def _store(tmp_path):
    # Deterministic, strictly-increasing clock so ordering + updated_at are stable.
    ticks = iter(range(10_000))
    clock = lambda: __import__("datetime").datetime(2026, 1, 1, 0, 0, t=next(ticks))  # noqa: E731
    return ConversationStore(tmp_path, clock=clock)


def test_create_assigns_ids_and_persists(tmp_path):
    s = _store(tmp_path)
    rec = s.create("/ws/A", title="hello")
    assert rec["id"].startswith("conv-")
    assert rec["session_id"]                   # non-empty uuid hex
    assert rec["workspace"] == "/ws/A"
    assert rec["title"] == "hello"
    assert rec["turns"] == []
    assert rec["created_at"] == rec["updated_at"]
    # Persisted to disk.
    assert s.get(rec["id"]) == rec


def test_list_filters_by_workspace_and_marks_active(tmp_path):
    s = _store(tmp_path)
    a1 = s.create("/ws/A")
    a2 = s.create("/ws/A")
    b1 = s.create("/ws/B")
    # create() sets active -> a2 is A's active, b1 is B's active.
    items = s.list("/ws/A")
    assert {i["id"] for i in items} == {a1["id"], a2["id"]}
    assert next(i for i in items if i["id"] == a2["id"])["active"] is True
    assert next(i for i in items if i["id"] == a1["id"])["active"] is False
    assert {i["id"] for i in s.list("/ws/B")} == {b1["id"]}
    # list items carry only summary fields.
    assert set(items[0]) == {"id", "title", "updated_at", "active"}


def test_list_orders_by_updated_at_desc(tmp_path):
    s = _store(tmp_path)
    old = s.create("/ws/A")
    new = s.create("/ws/A")
    s.append_turns(old["id"], [{"role": "user", "content": "x"}])  # bumps old's updated_at later
    ids = [i["id"] for i in s.list("/ws/A")]
    assert ids[0] == old["id"]                    # most-recently-updated first
    assert ids[1] == new["id"]


def test_append_turns_extends_and_bumps_updated_at(tmp_path):
    s = _store(tmp_path)
    rec = s.create("/ws/A")
    before = rec["updated_at"]
    out = s.append_turns(rec["id"], [{"role": "user", "content": "hi"}, {"role": "assistant", "blocks": []}])
    assert len(out["turns"]) == 2
    assert out["updated_at"] >= before
    assert s.get(rec["id"])["turns"] == [
        {"role": "user", "content": "hi"},
        {"role": "assistant", "blocks": []},
    ]


def test_append_turns_missing_returns_none(tmp_path):
    s = _store(tmp_path)
    assert s.append_turns("conv-nope", []) is None


def test_update_title(tmp_path):
    s = _store(tmp_path)
    rec = s.create("/ws/A")
    assert s.update_title(rec["id"], "新标题") is True
    assert s.get(rec["id"])["title"] == "新标题"
    assert s.update_title("conv-nope", "x") is False


def test_delete_removes_record_memory_dir_and_clears_active(tmp_path):
    s = _store(tmp_path)
    rec = s.create("/ws/A")
    # Simulate the SDK memory dir the agent would create: <root>/<session_id>/memory
    mem = tmp_path / rec["session_id"] / "memory"
    mem.mkdir(parents=True)
    (mem / "chat_history.json").write_text("{}", encoding="utf-8")

    sid = s.delete(rec["id"])
    assert sid == rec["session_id"]
    assert s.get(rec["id"]) is None              # record gone
    assert not mem.exists()                      # memory dir gone
    assert s.get_active("/ws/A") is None         # active pointer cleared
    assert s.delete(rec["id"]) is None           # already gone -> None


def test_set_and_get_active(tmp_path):
    s = _store(tmp_path)
    a = s.create("/ws/A")
    b = s.create("/ws/A")
    s.set_active("/ws/A", a["id"])
    assert s.get_active("/ws/A") == a["id"]
    assert next(i for i in s.list("/ws/A") if i["id"] == a["id"])["active"] is True
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python -m pytest sidecar/tests/test_conversation_store.py -v`
Expected: FAIL — `ModuleNotFoundError: floodmind_desktop_sidecar.conversation_store`.

- [ ] **Step 3: Implement ConversationStore**

Create `sidecar/floodmind_desktop_sidecar/conversation_store.py`:

```python
"""Filesystem-backed conversation store for the desktop sidecar.

One JSON file per conversation under <app_data_root>/conversations/<id>.json, plus
an index.json mapping workspace path -> that workspace's last-active conversation id.

SDK-free (pure filesystem) so it is unit-testable without the FloodMind SDK. The
`turns` field is stored opaque — the sidecar never interprets block structure; the
frontend rehydrates it verbatim.
"""
from __future__ import annotations

import json
import shutil
import threading
import uuid
from datetime import datetime
from pathlib import Path
from typing import Callable, Optional


def _now() -> datetime:
    return datetime.now()


class ConversationStore:
    def __init__(self, app_data_root: Path, clock: Callable[[], datetime] = _now):
        self._root = Path(app_data_root) / "conversations"
        self._root.mkdir(parents=True, exist_ok=True)
        self._index_path = self._root / "index.json"
        self._clock = clock
        self._lock = threading.Lock()

    # ── paths ────────────────────────────────────────────────
    def _record_path(self, conv_id: str) -> Path:
        return self._root / f"{conv_id}.json"

    def _memory_dir(self, session_id: str) -> Path:
        # Parent of <root>/conversations == app_data_root; matches
        # FloodMindAgent._memory_target: <app_data>/<session_id>/memory.
        return self._root.parent / session_id

    # ── index (workspace -> active conv id) ──────────────────
    def _load_index(self) -> dict:
        try:
            return json.loads(self._index_path.read_text(encoding="utf-8"))
        except Exception:
            return {}

    def _save_index(self, data: dict) -> None:
        self._index_path.write_text(
            json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8"
        )

    def _set_active(self, workspace: str, conv_id: str) -> None:
        idx = self._load_index()
        idx[workspace] = conv_id
        self._save_index(idx)

    def set_active(self, workspace: str, conv_id: str) -> None:
        with self._lock:
            self._set_active(workspace, conv_id)

    def get_active(self, workspace: str) -> Optional[str]:
        return self._load_index().get(workspace)

    # ── CRUD ─────────────────────────────────────────────────
    def create(self, workspace: str, title: str = "") -> dict:
        with self._lock:
            conv_id = "conv-" + uuid.uuid4().hex[:12]
            session_id = uuid.uuid4().hex
            now = self._clock().isoformat()
            record = {
                "id": conv_id,
                "session_id": session_id,
                "workspace": workspace,
                "title": title or "新会话",
                "created_at": now,
                "updated_at": now,
                "turns": [],
            }
            self._record_path(conv_id).write_text(
                json.dumps(record, ensure_ascii=False, indent=2), encoding="utf-8"
            )
            self._set_active(workspace, conv_id)
            return record

    def get(self, conv_id: str) -> Optional[dict]:
        try:
            return json.loads(self._record_path(conv_id).read_text(encoding="utf-8"))
        except FileNotFoundError:
            return None
        except Exception:
            return None

    def list(self, workspace: str) -> list[dict]:
        active = self._load_index().get(workspace)
        out = []
        for p in self._root.glob("conv-*.json"):
            try:
                rec = json.loads(p.read_text(encoding="utf-8"))
            except Exception:
                continue
            if rec.get("workspace") != workspace:
                continue
            out.append(rec)
        # Most-recently-updated first (ISO strings sort chronologically).
        out.sort(key=lambda r: r.get("updated_at", ""), reverse=True)
        return [
            {
                "id": r["id"],
                "title": r.get("title") or "新会话",
                "updated_at": r.get("updated_at", ""),
                "active": r["id"] == active,
            }
            for r in out
        ]

    def append_turns(self, conv_id: str, turns: list) -> Optional[dict]:
        with self._lock:
            rec = self.get(conv_id)
            if rec is None:
                return None
            rec["turns"] = (rec.get("turns") or []) + list(turns)
            rec["updated_at"] = self._clock().isoformat()
            self._record_path(conv_id).write_text(
                json.dumps(rec, ensure_ascii=False, indent=2), encoding="utf-8"
            )
            return rec

    def update_title(self, conv_id: str, title: str) -> bool:
        with self._lock:
            rec = self.get(conv_id)
            if rec is None:
                return False
            rec["title"] = title
            rec["updated_at"] = self._clock().isoformat()
            self._record_path(conv_id).write_text(
                json.dumps(rec, ensure_ascii=False, indent=2), encoding="utf-8"
            )
            return True

    def delete(self, conv_id: str) -> Optional[str]:
        """Remove record + its SDK memory dir. Returns the removed session_id, or None."""
        with self._lock:
            rec = self.get(conv_id)
            if rec is None:
                return None
            try:
                self._record_path(conv_id).unlink()
            except FileNotFoundError:
                pass
            mem = self._memory_dir(rec["session_id"])
            if mem.exists():
                shutil.rmtree(mem, ignore_errors=True)
            idx = self._load_index()
            for ws, cid in list(idx.items()):
                if cid == conv_id:
                    idx.pop(ws, None)
            self._save_index(idx)
            return rec["session_id"]
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `python -m pytest sidecar/tests/test_conversation_store.py -v`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add sidecar/floodmind_desktop_sidecar/conversation_store.py sidecar/tests/test_conversation_store.py
git commit -m "feat(sidecar): add ConversationStore (per-workspace conversation persistence)"
```

---

## Task 2: Agent seam — activate_conversation + generate_title

**Files:**
- Modify: `sidecar/floodmind_desktop_sidecar/agent.py` (Protocol + StubAgent)
- Modify: `sidecar/floodmind_desktop_sidecar/floodmind_agent.py` (FloodMindAgent)
- Test: `sidecar/tests/test_floodmind_agent.py`

**Interfaces:**
- Consumes: `FloodMindAgent._memory_target(session_id) -> (session_id, persist_dir)` and `_build_agent(session_id, persist_dir)` (existing).
- Produces: `Agent.activate_conversation(session_id: str) -> None`, `Agent.generate_title(message: str) -> str` on the Protocol, StubAgent (no-op / ""), and FloodMindAgent (rebuild / LLM call).

- [ ] **Step 1: Add the failing tests**

Append to `sidecar/tests/test_floodmind_agent.py`:

```python
def test_activate_conversation_rebuilds_with_session_id(tmp_path, monkeypatch):
    # _memory_target uses _app_data_dir() == cwd.
    monkeypatch.chdir(tmp_path)
    from floodmind_desktop_sidecar.floodmind_agent import FloodMindAgent

    built = []
    a = FloodMindAgent.__new__(FloodMindAgent)
    a._build_agent = lambda sid, pd: built.append((sid, pd)) or ("AGENT", sid, pd)

    a.activate_conversation("sess-xyz")

    assert built == [("sess-xyz", str(tmp_path / "sess-xyz" / "memory"))]
    assert a._agent == ("AGENT", "sess-xyz", str(tmp_path / "sess-xyz" / "memory"))


def test_activate_conversation_swallows_errors(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    from floodmind_desktop_sidecar.floodmind_agent import FloodMindAgent

    a = FloodMindAgent.__new__(FloodMindAgent)
    a._agent = "ORIGINAL"
    a._build_agent = lambda sid, pd: (_ for _ in ()).throw(RuntimeError("nope"))

    a.activate_conversation("sess-1")     # must not raise
    assert a._agent == "ORIGINAL"         # left untouched on failure


def test_generate_title_invokes_llm_and_cleans_output(monkeypatch):
    import importlib
    from floodmind_desktop_sidecar.floodmind_agent import FloodMindAgent

    class FakeResult:
        content = "  1. 帮我画个销售折线图\nignore me"

    class FakeMC:
        last_prompt = None

        @classmethod
        def from_settings(cls, **kw):
            cls.last_kwargs = kw
            llm = type("L", (), {"invoke": lambda self, p: setattr(FakeMC, "last_prompt", p) or FakeResult()})()
            return llm

    monkeypatch.setattr(
        importlib.import_module("floodmind.agent.native.model_client"), "ModelClient", FakeMC
    )

    a = FloodMindAgent.__new__(FloodMindAgent)
    title = a.generate_title("帮我画个销售折线图")

    assert title == "帮我画个销售折线图"           # leading "1. " stripped, trailing line dropped, ≤24
    assert FakeMC.last_kwargs["temperature"] == 0.2
    assert FakeMC.last_kwargs["max_tokens"] == 60
    assert FakeMC.last_kwargs["enable_thinking"] is False
    assert "销售折线图" in FakeMC.last_prompt


def test_generate_title_returns_empty_on_failure(monkeypatch):
    import importlib
    from floodmind_desktop_sidecar.floodmind_agent import FloodMindAgent

    class FakeMC:
        @classmethod
        def from_settings(cls, **kw):
            raise RuntimeError("llm down")

    monkeypatch.setattr(
        importlib.import_module("floodmind.agent.native.model_client"), "ModelClient", FakeMC
    )
    a = FloodMindAgent.__new__(FloodMindAgent)
    assert a.generate_title("anything") == ""    # swallowed, not raised
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python -m pytest sidecar/tests/test_floodmind_agent.py::test_activate_conversation_rebuilds_with_session_id -v`
Expected: FAIL — `AttributeError: activate_conversation`.

- [ ] **Step 3: Extend the Agent Protocol + StubAgent**

In `sidecar/floodmind_desktop_sidecar/agent.py`, add to the `Agent` Protocol (after `reload_model`):

```python
    def activate_conversation(self, session_id: str) -> None:
        """Rebuild the agent bound to this conversation's session_id (memory isolation)."""
        ...

    def generate_title(self, message: str) -> str:
        """Return a short LLM-generated title for the conversation, or '' on failure."""
        ...
```

And add to `StubAgent` (after `reload_model`):

```python
    def activate_conversation(self, session_id: str) -> None:
        pass

    def generate_title(self, message: str) -> str:
        return ""
```

- [ ] **Step 4: Implement on FloodMindAgent**

In `sidecar/floodmind_desktop_sidecar/floodmind_agent.py`, add these two methods to the `FloodMindAgent` class (e.g. after `reload_model`):

```python
    def activate_conversation(self, session_id: str) -> None:
        """Rebuild the SDK agent bound to this conversation's session_id.

        Reuses _build_agent + _memory_target so the conversation's DualMemory chat
        history is loaded from its own persist_dir. The experience library and
        long-term memory stay global (see docs/memory-model). A fresh agent also
        means an in-flight stream holding the old agent is untouched.
        """
        try:
            sid, persist_dir = self._memory_target(session_id)
            self._agent = self._build_agent(sid, persist_dir)
        except Exception as e:
            print(f"[sidecar] activate_conversation failed for {session_id}: {e}", file=sys.stderr)

    def generate_title(self, message: str) -> str:
        """LLM-generate a short Chinese title (mirrors the SDK server-layer prompt).

        Uses a dedicated low-temperature ModelClient; '' on any failure so callers
        can keep a fallback title.
        """
        import re
        try:
            from floodmind.agent.native.model_client import ModelClient

            llm = ModelClient.from_settings(temperature=0.2, max_tokens=60, enable_thinking=False)
            prompt = (
                "请根据用户问题拟一个简短的中文会话标题，用于左侧历史会话列表展示。"
                "要求：10到18个字，突出任务目标，不要带引号，不要解释，不要句号。\n\n"
                f"用户问题：{message}"
            )
            result = llm.invoke(prompt)
            if result is None or not hasattr(result, "content"):
                return ""
            raw = (getattr(result, "content", "") or "").strip()
            title = raw.splitlines()[0].strip().strip('"""')
            title = re.sub(r"^[#\-*\d.\s]+", "", title).strip()
            return title[:24] if title else ""
        except Exception as e:
            print(f"[sidecar] generate_title failed: {e}", file=sys.stderr)
            return ""
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `python -m pytest sidecar/tests/test_floodmind_agent.py -v`
Expected: PASS (all, including the 4 new ones).

- [ ] **Step 6: Commit**

```bash
git add sidecar/floodmind_desktop_sidecar/agent.py sidecar/floodmind_desktop_sidecar/floodmind_agent.py sidecar/tests/test_floodmind_agent.py
git commit -m "feat(sidecar): agent.activate_conversation + generate_title (memory isolation, LLM titles)"
```

---

## Task 3: Conversation API endpoints + title orchestration

**Files:**
- Modify: `sidecar/floodmind_desktop_sidecar/app.py`
- Create: `sidecar/tests/test_conversations_api.py`

**Interfaces:**
- Consumes: `ConversationStore` (Task 1), `Agent.activate_conversation` / `Agent.generate_title` (Task 2).
- Produces: 6 endpoints (`GET/POST /api/conversations`, `GET /api/conversations/<id>`, `POST .../activate`, `POST .../turns`, `DELETE .../<id>`); `create_app(agent, workspace_manager=None, conversation_store=None, title_spawner=None)`.

- [ ] **Step 1: Write the failing endpoint tests**

Create `sidecar/tests/test_conversations_api.py`:

```python
from floodmind_desktop_sidecar.agent import StubAgent
from floodmind_desktop_sidecar.app import create_app


class SpyAgent(StubAgent):
    def __init__(self):
        self.activated = []
        self.title_input = None

    def activate_conversation(self, session_id):
        self.activated.append(session_id)

    def generate_title(self, message):
        self.title_input = message
        return "生成的标题"


def _client(tmp_path, monkeypatch, spy=None, spawner=None):
    monkeypatch.chdir(tmp_path)          # _app_data_dir() == cwd
    spy = spy or SpyAgent()
    client = create_app(spy, title_spawner=spawner).test_client()
    return client, spy


def test_create_then_list_then_get(tmp_path, monkeypatch):
    client, _ = _client(tmp_path, monkeypatch)
    r = client.post("/api/conversations", json={"workspace": "/ws/A"})
    assert r.status_code == 200
    rec = r.get_json()
    assert rec["id"].startswith("conv-")
    conv_id = rec["id"]

    r = client.get("/api/conversations?workspace=/ws/A")
    assert r.status_code == 200
    items = r.get_json()["conversations"]
    assert [i["id"] for i in items] == [conv_id]
    assert items[0]["active"] is True

    r = client.get(f"/api/conversations/{conv_id}")
    assert r.status_code == 200
    assert r.get_json()["id"] == conv_id


def test_create_activates_agent(tmp_path, monkeypatch):
    client, spy = _client(tmp_path, monkeypatch)
    rec = client.post("/api/conversations", json={"workspace": "/ws/A"}).get_json()
    assert spy.activated == [rec["session_id"]]


def test_create_requires_workspace(tmp_path, monkeypatch):
    client, _ = _client(tmp_path, monkeypatch)
    r = client.post("/api/conversations", json={})
    assert r.status_code == 400


def test_activate_endpoint_rebuilds_and_sets_active(tmp_path, monkeypatch):
    client, spy = _client(tmp_path, monkeypatch)
    a = client.post("/api/conversations", json={"workspace": "/ws/A"}).get_json()
    b = client.post("/api/conversations", json={"workspace": "/ws/A"}).get_json()
    spy.activated.clear()

    r = client.post(f"/api/conversations/{a['id']}/activate")
    assert r.status_code == 200
    assert spy.activated == [a["session_id"]]
    # active pointer now points at a
    items = {i["id"]: i for i in client.get("/api/conversations?workspace=/ws/A").get_json()["conversations"]}
    assert items[a["id"]]["active"] is True
    assert items[b["id"]]["active"] is False


def test_append_turns_and_background_title(tmp_path, monkeypatch):
    # Synchronous spawner so the title side-effect is observable in-test.
    ran = []
    client, spy = _client(
        tmp_path, monkeypatch, spawner=lambda fn: (fn(), ran.append(True))[0]
    )
    conv = client.post("/api/conversations", json={"workspace": "/ws/A"}).get_json()

    r = client.post(f"/api/conversations/{conv['id']}/turns", json={
        "turns": [{"role": "user", "content": "帮我画图"}, {"role": "assistant", "blocks": []}]
    })
    assert r.status_code == 200
    assert ran == [True]                              # title job ran
    assert spy.title_input == "帮我画图"              # first user message used
    rec = client.get(f"/api/conversations/{conv['id']}").get_json()
    assert rec["title"] == "生成的标题"               # title applied
    assert len(rec["turns"]) == 2


def test_append_turns_only_schedules_title_on_first_turn(tmp_path, monkeypatch):
    runs = []
    client, _ = _client(tmp_path, monkeypatch, spawner=lambda fn: (fn(), runs.append(True))[0])
    conv = client.post("/api/conversations", json={"workspace": "/ws/A"}).get_json()
    client.post(f"/api/conversations/{conv['id']}/turns", json={"turns": [{"role": "user", "content": "a"}]})
    runs.clear()
    client.post(f"/api/conversations/{conv['id']}/turns", json={"turns": [{"role": "user", "content": "b"}]})
    assert runs == []                                 # no title gen on 2nd append


def test_append_turns_404_for_missing(tmp_path, monkeypatch):
    client, _ = _client(tmp_path, monkeypatch)
    r = client.post("/api/conversations/conv-nope/turns", json={"turns": []})
    assert r.status_code == 404


def test_delete_removes_conversation(tmp_path, monkeypatch):
    client, _ = _client(tmp_path, monkeypatch)
    conv = client.post("/api/conversations", json={"workspace": "/ws/A"}).get_json()
    r = client.delete(f"/api/conversations/{conv['id']}")
    assert r.status_code == 200
    assert client.get(f"/api/conversations/{conv['id']}").status_code == 404
    assert client.delete(f"/api/conversations/{conv['id']}").status_code == 404
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python -m pytest sidecar/tests/test_conversations_api.py -v`
Expected: FAIL — 404 on `/api/conversations` (routes not defined).

- [ ] **Step 3: Add helpers + endpoints to create_app**

In `sidecar/floodmind_desktop_sidecar/app.py`:

Add imports at top (with the existing `from pathlib import Path`):

```python
import threading
```

Add module-level helpers above `create_app`:

```python
def _first_user_text(turns: list) -> str:
    """First user-message content in a turn pair (for title generation)."""
    for t in turns or []:
        if isinstance(t, dict) and t.get("role") == "user":
            return str(t.get("content", ""))
    return ""


def _apply_title(store, title_fn, conv_id: str, user_text: str) -> None:
    """Call title_fn(user_text); on a non-empty result, persist it. Swallows errors."""
    try:
        title = title_fn(user_text)
        if title:
            store.update_title(conv_id, title)
    except Exception as e:  # pragma: no cover - defensive
        print(f"[sidecar] title apply failed: {e}", file=sys.stderr)
```

Extend the `create_app` signature and add the store + spawner + routes. Change the def line to:

```python
def create_app(agent: Agent, workspace_manager=None, conversation_store=None, title_spawner=None) -> Flask:
```

Right after `CORS(app, ...)` (before `@app.get("/api/health")`), add:

```python
    if conversation_store is None:
        from .workspace import _app_data_dir
        from .conversation_store import ConversationStore
        conversation_store = ConversationStore(_app_data_dir())
    if title_spawner is None:
        def title_spawner(fn):
            threading.Thread(target=fn, daemon=True, name="conv-title").start()
```

Add the conversation routes (e.g. right after the `session_reset` route, before the Skills section):

```python
    # ── Conversations (per-workspace history) ─────────────────
    @app.get("/api/conversations")
    def conversations_list():
        ws = request.args.get("workspace", "")
        return jsonify({"conversations": conversation_store.list(ws)})

    @app.post("/api/conversations")
    def conversations_create():
        body = request.get_json(silent=True) or {}
        ws = body.get("workspace", "")
        if not ws:
            return jsonify({"error": "workspace required"}), 400
        rec = conversation_store.create(ws)
        try:
            agent.activate_conversation(rec["session_id"])
        except Exception as e:  # pragma: no cover - defensive
            app.logger.warning("activate_conversation failed: %s", e)
        return jsonify(rec)

    @app.get("/api/conversations/<conv_id>")
    def conversations_get(conv_id):
        rec = conversation_store.get(conv_id)
        if rec is None:
            return jsonify({"error": "not found"}), 404
        return jsonify(rec)

    @app.post("/api/conversations/<conv_id>/activate")
    def conversations_activate(conv_id):
        rec = conversation_store.get(conv_id)
        if rec is None:
            return jsonify({"error": "not found"}), 404
        try:
            agent.activate_conversation(rec["session_id"])
            conversation_store.set_active(rec["workspace"], conv_id)
        except Exception as e:  # pragma: no cover - defensive
            app.logger.warning("activate failed: %s", e)
        return jsonify({"ok": True})

    @app.post("/api/conversations/<conv_id>/turns")
    def conversations_append_turns(conv_id):
        body = request.get_json(silent=True) or {}
        turns = body.get("turns") or []
        rec = conversation_store.append_turns(conv_id, turns)
        if rec is None:
            return jsonify({"error": "not found"}), 404
        # First-turn background title generation: nothing was persisted before this append.
        if len(rec.get("turns", [])) <= len(turns):
            user_text = _first_user_text(turns)
            if user_text:
                title_spawner(lambda: _apply_title(conversation_store, agent.generate_title, conv_id, user_text))
        return jsonify({"ok": True})

    @app.delete("/api/conversations/<conv_id>")
    def conversations_delete(conv_id):
        session_id = conversation_store.delete(conv_id)
        if session_id is None:
            return jsonify({"error": "not found"}), 404
        return jsonify({"ok": True})
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `python -m pytest sidecar/tests/test_conversations_api.py sidecar/tests -v`
Expected: PASS (new tests + all existing sidecar tests still green).

- [ ] **Step 5: Commit**

```bash
git add sidecar/floodmind_desktop_sidecar/app.py sidecar/tests/test_conversations_api.py
git commit -m "feat(sidecar): conversation CRUD + activate + turn-append + background title API"
```

---

## Task 4: Frontend conversation-store

**Files:**
- Create: `src/state/conversation-store.ts`
- Create: `src/state/conversation-store.test.ts`

**Interfaces:**
- Consumes: `Msg` type (type-only import from `./chat-store`); `getBaseUrl` from `../lib/sidecar-client`.
- Produces: `useConversationStore` with `list: ConvSummary[]`, `loadList(workspace)`, `create(workspace)`, `open(id)`, `activate(id)`, `remove(id)`; types `ConvSummary`, `Conversation`.

- [ ] **Step 1: Write the failing tests**

Create `src/state/conversation-store.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../lib/sidecar-client", () => ({ getBaseUrl: vi.fn(async () => "http://test") }));

import { useConversationStore } from "./conversation-store";

beforeEach(() => {
  vi.clearAllMocks();
  useConversationStore.setState({ list: [] });
});

describe("conversation-store", () => {
  it("loadList hits GET /api/conversations?workspace= and stores items", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ conversations: [{ id: "c1", title: "T", updated_at: "x", active: true }] }), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);

    const items = await useConversationStore.getState().loadList("/ws/A");
    expect(items).toHaveLength(1);
    expect(useConversationStore.getState().list[0].id).toBe("c1");
    expect(String(fetchMock.mock.calls[0][0])).toContain("/api/conversations?workspace=");
  });

  it("create POSTs {workspace} and returns the record", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ id: "c2", session_id: "s", workspace: "/ws/A", title: "x", created_at: "", updated_at: "", turns: [] }), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);
    const rec = await useConversationStore.getState().create("/ws/A");
    expect(rec?.id).toBe("c2");
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ workspace: "/ws/A" });
  });

  it("activate and remove use POST / DELETE on the id", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await useConversationStore.getState().activate("c1");
    await useConversationStore.getState().remove("c1");
    expect(String(fetchMock.mock.calls[0][0])).toContain("/api/conversations/c1/activate");
    expect((fetchMock.mock.calls[0][1] as RequestInit).method).toBe("POST");
    expect(String(fetchMock.mock.calls[1][0])).toContain("/api/conversations/c1");
    expect((fetchMock.mock.calls[1][1] as RequestInit).method).toBe("DELETE");
  });

  it("returns [] / null / false on fetch failure without throwing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 500 })));
    expect(await useConversationStore.getState().loadList("/ws")).toEqual([]);
    expect(await useConversationStore.getState().create("/ws")).toBeNull();
    expect(await useConversationStore.getState().activate("c1")).toBe(false);
    expect(await useConversationStore.getState().remove("c1")).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- conversation-store`
Expected: FAIL — cannot find module `./conversation-store`.

- [ ] **Step 3: Implement conversation-store**

Create `src/state/conversation-store.ts`:

```typescript
import { create } from "zustand";
import { getBaseUrl } from "../lib/sidecar-client";
import type { Msg } from "./chat-store";

export interface ConvSummary {
  id: string;
  title: string;
  updated_at: string;
  active: boolean;
}
export interface Conversation extends ConvSummary {
  session_id: string;
  workspace: string;
  created_at: string;
  turns: Msg[];
}

interface ConversationState {
  list: ConvSummary[];
  loadList: (workspace: string) => Promise<ConvSummary[]>;
  create: (workspace: string) => Promise<Conversation | null>;
  open: (id: string) => Promise<Conversation | null>;
  activate: (id: string) => Promise<boolean>;
  remove: (id: string) => Promise<boolean>;
}

async function getJson(url: string, init?: RequestInit): Promise<any | null> {
  try {
    const b = await getBaseUrl();
    const r = await fetch(`${b}${url}`, init);
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

export const useConversationStore = create<ConversationState>((set) => ({
  list: [],

  async loadList(workspace) {
    const data = await getJson(`/api/conversations?workspace=${encodeURIComponent(workspace)}`);
    const items: ConvSummary[] = (data && data.conversations) || [];
    set({ list: items });
    return items;
  },

  create(workspace) {
    return getJson("/api/conversations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspace }),
    });
  },

  open(id) {
    return getJson(`/api/conversations/${encodeURIComponent(id)}`);
  },

  async activate(id) {
    const v = await getJson(`/api/conversations/${encodeURIComponent(id)}/activate`, { method: "POST" });
    return v !== null;
  },

  async remove(id) {
    const v = await getJson(`/api/conversations/${encodeURIComponent(id)}`, { method: "DELETE" });
    return v !== null;
  },
}));
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- conversation-store`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/state/conversation-store.ts src/state/conversation-store.test.ts
git commit -m "feat(ui): conversation-store (sidecar conversation API client)"
```

---

## Task 5: chat-store — conversationId, persist turns, startNew, loadConversation

**Files:**
- Modify: `src/state/chat-store.ts`
- Modify: `src/state/chat-store.test.ts`

**Interfaces:**
- Consumes: `useConversationStore` (Task 4).
- Produces: `chat-store` gains `conversationId: string | null`, `startNew(workspace)`, `loadConversation(id)`; `reset()` becomes a local-only clear (no sidecar call). `send()` POSTs the finalized turn pair to `/api/conversations/<id>/turns`.

- [ ] **Step 1: Update the tests**

In `src/state/chat-store.test.ts`, **replace** the existing `reset` test (the one asserting `/api/session/reset`) with local-clear behavior, and **add** new tests for startNew / loadConversation / send-posts-turns. Add a mock for conversation-store at the top with the other mocks:

```typescript
vi.mock("../lib/sidecar-client", () => ({
  getBaseUrl: vi.fn(async () => "http://test"),
}));
vi.mock("../lib/chat-stream", () => ({
  streamChat: vi.fn(),
}));
vi.mock("./conversation-store", () => ({
  useConversationStore: {
    getState: () => ({
      create: vi.fn(async (_ws: string) => ({
        id: "c-new", session_id: "s-new", workspace: _ws, title: "新会话",
        created_at: "t", updated_at: "t", turns: [],
      })),
      activate: vi.fn(async (_id: string) => true),
      open: vi.fn(async (id: string) => ({
        id, session_id: "s", workspace: "/ws", title: "old", created_at: "t", updated_at: "t",
        turns: [{ role: "user", content: "loaded" }],
      })),
      loadList: vi.fn(async () => []),
    }),
  },
}));
```

Replace the `reset` test with:

```typescript
  it("reset clears local turns without a sidecar call", () => {
    const fetchMock = vi.fn();
    useChatStore.setState({
      turns: [{ role: "user", content: "x" }, { role: "assistant", blocks: [], usage: null, done: true }],
      streaming: false,
    });
    useChatStore.getState().reset();
    expect(useChatStore.getState().turns).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("startNew creates a conversation, clears turns, sets conversationId", async () => {
    useChatStore.setState({
      turns: [{ role: "user", content: "old" }],
      streaming: false,
      conversationId: null,
    });
    await useChatStore.getState().startNew("/ws/A");
    const st = useChatStore.getState();
    expect(st.turns).toEqual([]);
    expect(st.conversationId).toBe("c-new");
  });

  it("loadConversation activates + hydrates turns from the loaded record", async () => {
    await useChatStore.getState().loadConversation("c-old");
    const st = useChatStore.getState();
    expect(st.conversationId).toBe("c-old");
    expect(st.turns).toHaveLength(1);
    expect((st.turns[0] as any).content).toBe("loaded");
  });

  it("send posts the finalized turn pair when a conversation is active", async () => {
    (streamChat as any).mockImplementation(async function* () {
      yield { type: "text", content: "Hi" };
      yield { type: "done" };
    });
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    useChatStore.setState({ turns: [], streaming: false, conversationId: "c1" });
    _resetBlockIdsForTest();

    await useChatStore.getState().send("hello");

    const posted = fetchMock.mock.calls.find(
      (c) => String(c[0]).includes("/api/conversations/c1/turns")
    );
    expect(posted).toBeTruthy();
    const body = JSON.parse((posted![1] as RequestInit).body as string);
    expect(body.turns).toHaveLength(2);
    expect(body.turns[0]).toMatchObject({ role: "user", content: "hello" });
    expect(body.turns[1].role).toBe("assistant");
    vi.unstubAllGlobals();
  });

  it("send does NOT post when no conversation is active", async () => {
    (streamChat as any).mockImplementation(async function* () {
      yield { type: "done" };
    });
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    useChatStore.setState({ turns: [], streaming: false, conversationId: null });
    _resetBlockIdsForTest();

    await useChatStore.getState().send("hi");
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- chat-store`
Expected: FAIL — `startNew`/`loadConversation` not defined; `reset` still calls fetch.

- [ ] **Step 3: Modify chat-store**

In `src/state/chat-store.ts`:

Add the import (top, with others):

```typescript
import { useConversationStore } from "./conversation-store";
```

Extend the `ChatState` interface — add `conversationId`, `startNew`, `loadConversation`:

```typescript
interface ChatState {
  turns: Msg[];
  streaming: boolean;
  abortController: AbortController | null;
  conversationId: string | null;
  send: (text: string) => Promise<void>;
  reset: () => void;
  startNew: (workspace: string) => Promise<void>;
  loadConversation: (id: string) => Promise<void>;
}
```

Add `conversationId: null` to the initial state object (next to `turns: []`).

Rewrite `reset` to be local-only (remove the sidecar POST):

```typescript
  reset: () => {
    get().abortController?.abort();
    set({ turns: [], streaming: false, abortController: null });
  },
```

In `send`, capture the user text at the top and post the pair on successful finalize. Change the `finally` block to (replacing the existing `finally`):

```typescript
    } finally {
      const aborted = controller.signal.aborted;
      const finalize = !aborted && !errored;
      set((s) => {
        const turns = s.turns.slice();
        const last = turns[turns.length - 1];
        if (last && last.role === "assistant") {
          turns[turns.length - 1] = {
            ...last,
            blocks: finalize ? markFinal(last.blocks) : last.blocks,
            done: true,
          };
        }
        return { turns, streaming: false, abortController: null };
      });
      // Persist the completed user+assistant pair to the active conversation.
      if (finalize && text.trim()) {
        const cid = get().conversationId;
        if (cid) {
          const turns = get().turns;
          const last = turns[turns.length - 1];
          if (last && last.role === "assistant") {
            const pair = [
              { role: "user", content: text } as Msg,
              last,
            ];
            getBaseUrl()
              .then((b) =>
                fetch(`${b}/api/conversations/${cid}/turns`, {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ turns: pair }),
                })
              )
              .catch(() => {
                /* persistence is best-effort; the local transcript is the live source */
              });
          }
        }
      }
    }
```

Add the two new actions at the end of the store object (after `reset`):

```typescript
  async startNew(workspace: string) {
    get().abortController?.abort();
    const conv = await useConversationStore.getState().create(workspace);
    set({
      turns: [],
      streaming: false,
      abortController: null,
      conversationId: conv ? conv.id : get().conversationId,
    });
    await useConversationStore.getState().loadList(workspace);
  },

  async loadConversation(id: string) {
    get().abortController?.abort();
    await useConversationStore.getState().activate(id);
    const conv = await useConversationStore.getState().open(id);
    if (!conv) return;
    set({
      turns: conv.turns || [],
      streaming: false,
      abortController: null,
      conversationId: conv.id,
    });
  },
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- chat-store`
Expected: PASS (all chat-store tests).

- [ ] **Step 5: Commit**

```bash
git add src/state/chat-store.ts src/state/chat-store.test.ts
git commit -m "feat(ui): chat-store tracks conversationId, persists turns, startNew/loadConversation"
```

---

## Task 6: Sidebar 会话 list + App workspace activation + styles

**Files:**
- Modify: `src/components/Sidebar.tsx`
- Modify: `src/App.tsx`
- Modify: `src/app.css`

**Interfaces:**
- Consumes: `useConversationStore` (Task 4), `chat-store.startNew` / `loadConversation` / `conversationId` (Task 5), `useWorkspaceStore` (existing).
- Produces: a "会话" section in the sidebar (list/active/open/delete) and app-level orchestration that loads + activates a conversation whenever the workspace changes.

- [ ] **Step 1: Wire App.tsx workspace→conversation activation**

In `src/App.tsx`, add the workspace effect. Replace the file body:

```typescript
import { useEffect } from "react";
import Composer from "./components/Composer";
import Conversation from "./components/Conversation";
import McpView from "./components/McpView";
import SettingsView from "./components/SettingsView";
import Sidebar from "./components/Sidebar";
import SkillsView from "./components/SkillsView";
import TopBar from "./components/TopBar";
import { useUiStore } from "./state/ui-store";
import { useWorkspaceStore } from "./state/workspace-store";
import { useConversationStore } from "./state/conversation-store";
import { useChatStore } from "./state/chat-store";

export default function App() {
  const view = useUiStore((s) => s.view);
  const currentPath = useWorkspaceStore((s) => s.current?.path);

  useEffect(() => {
    if (!currentPath) return;
    // On workspace change: load its conversations and ensure one is active+loaded.
    (async () => {
      const items = await useConversationStore.getState().loadList(currentPath);
      const active = items.find((i) => i.active);
      if (active) {
        await useChatStore.getState().loadConversation(active.id);
      } else if (items.length > 0) {
        await useChatStore.getState().loadConversation(items[0].id);
      } else {
        await useChatStore.getState().startNew(currentPath);
      }
    })();
  }, [currentPath]);

  return (
    <div className="app">
      <Sidebar />
      <div className="main">
        {view === "chat" && (
          <>
            <TopBar />
            <Conversation />
            <Composer />
          </>
        )}
        {view === "skills" && <SkillsView />}
        {view === "mcp" && <McpView />}
        {view === "settings" && <SettingsView />}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Add the 会话 section to Sidebar.tsx**

In `src/components/Sidebar.tsx`, add the conversation-store + new chat-store hooks and the section.

Add imports:

```typescript
import { useConversationStore } from "../state/conversation-store";
```

Inside the component, add (alongside the other hooks):

```typescript
  const convList = useConversationStore((s) => s.list);
  const loadList = useConversationStore((s) => s.loadList);
  const removeConv = useConversationStore((s) => s.remove);
  const conversationId = useChatStore((s) => s.conversationId);
  const startNew = useChatStore((s) => s.startNew);
  const loadConversation = useChatStore((s) => s.loadConversation);
```

Change the 新会话 button to call `startNew` with the current workspace path:

```tsx
      <button
        className="new-thread"
        onClick={() => current && startNew(current.path)}
        type="button"
        disabled={streaming || !current}
        title={current ? undefined : "请先打开一个工作区"}
      >
        <span>＋</span>
        新会话
      </button>
```

Insert the 会话 section **directly after** the 新会话 button and **before** the 最近 section:

```tsx
      {current && convList.length > 0 && (
        <div className="sidebar-section">
          <div className="sidebar-label">会话</div>
          {convList.map((c) => (
            <div
              key={c.id}
              className={c.id === conversationId ? "sidebar-item conv-item active" : "sidebar-item conv-item"}
            >
              <button
                className="conv-open"
                onClick={() => loadConversation(c.id)}
                disabled={streaming}
                title={c.title}
                type="button"
              >
                <span className="item-name">{c.title}</span>
              </button>
              <button
                className="conv-del"
                onClick={() => {
                  const wasActive = c.id === conversationId;
                  removeConv(c.id).then(() => {
                    if (!current) return;
                    // Spec: deleting the active conversation activates another
                    // (here: a fresh one); otherwise just refresh the list.
                    if (wasActive) startNew(current.path);
                    else loadList(current.path);
                  });
                }}
                title="删除会话"
                type="button"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}
```

- [ ] **Step 3: Add CSS for the conversation items**

In `src/app.css`, append:

```css
.conv-item {
  display: flex;
  align-items: center;
  gap: 2px;
  padding-right: 4px;
}
.conv-item .conv-open {
  flex: 1;
  min-width: 0;
  background: none;
  border: none;
  color: inherit;
  text-align: left;
  cursor: pointer;
  padding: 0;
  font: inherit;
}
.conv-item .conv-open:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}
.conv-item .conv-open .item-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.conv-item .conv-del {
  flex: 0 0 auto;
  background: none;
  border: none;
  color: var(--muted, #9ca3af);
  cursor: pointer;
  font-size: 12px;
  line-height: 1;
  padding: 2px 4px;
  opacity: 0;
  transition: opacity 0.12s;
}
.conv-item:hover .conv-del,
.conv-item .conv-del:focus {
  opacity: 1;
}
.conv-item .conv-del:hover {
  color: #ef4444;
}
```

- [ ] **Step 4: Build + test**

Run: `npm run build && npm test`
Expected: build succeeds; all vitest tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/components/Sidebar.tsx src/App.tsx src/app.css
git commit -m "feat(ui): sidebar conversation list + workspace→conversation activation"
```

---

## Task 7: End-to-end verification (build, tests, real-SDK smoke)

**Files:** none (verification only).

- [ ] **Step 1: Full sidecar test suite**

Run: `python -m pytest sidecar/tests -v`
Expected: all green (existing + new store/agent/api tests).

- [ ] **Step 2: Full frontend build + tests**

Run: `npm run build && npm test`
Expected: build OK; all vitest green.

- [ ] **Step 3: Real-SDK smoke (Agent_desktop conda env, `npm run tauri dev`)**

Manual checklist (the memory-isolation guarantee can only be proven with the real SDK):
1. Open a workspace → a conversation is auto-created and active (sidebar 会话 shows one highlighted item).
2. Send a multi-step task → answer streams; after it completes the turn is persisted (restart app → conversation reappears with full transcript, blocks intact).
3. Click 新会话 → previous conversation stays in the list; a new blank one becomes active.
4. Click the old conversation → its transcript reloads; ask a follow-up → the agent remembers only that conversation's context (proves `session_id` isolation; experience library still shared across both).
5. Hover a conversation → ✕ appears; click it → record + its `<cwd>/<session_id>/` memory dir are gone, and it leaves the list. Deleting the active conversation leaves the list non-empty (activate another) or creates a new one on next workspace focus.
6. After the first turn of a brand-new conversation, the title refreshes from "新会话" to an LLM-generated one within a few seconds (re-list after the turn).

- [ ] **Step 4: Commit any smoke-fixes (if needed)**

Only if Step 3 surfaced a bug — fix under a focused commit, re-run the relevant test tier. Otherwise this step is a no-op.

---

## Out of scope (separate plans)

- **Scheduled-tasks feature** (expose SDK `ScheduledTaskRuntime` to the desktop UI) — recorded as a backlog memory; its own brainstorm/spec/plan.
- Conversation **rename** and **full-text search** (deferred per design spec).
