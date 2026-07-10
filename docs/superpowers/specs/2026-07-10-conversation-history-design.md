# Conversation History — Design Spec

**Date:** 2026-07-10
**Status:** Approved → ready for implementation plan

## Problem

The desktop client has a "新会话" (new conversation) button, but **no conversation persistence exists at all**:

- `session_id` is derived from the workspace path (`session_id_for(path)` in `sidecar/.../workspace.py`), so each workspace has exactly **one** memory thread, forever.
- "新会话" calls `chat-store.reset()` → clears local turns AND POSTs `/api/session/reset` → `FloodMindAgent.clear_memory()` wipes that single thread. The conversation is **destroyed**, not preserved.
- The frontend never persists the rendered transcript; it lives only in React memory.

So users cannot find past conversations — the system never kept them.

## Goal

Multiple named conversations per workspace, persisted across restarts, each with isolated agent memory but sharing the global experience library. A sidebar list to browse/resume them, ChatGPT/Claude-style.

## Verified SDK facts (from source)

- `DualMemory._turns` (conversation history) → persisted to `<persist_dir>/chat_history.json`, scoped by the `session_id` + `persist_dir` passed to `DualMemory(...)`. **Per-session.** (research/fm-sdk/floodmind/memory/dual_memory.py)
- Experience library (`task_experience.py`) → persisted under `cfg.persist_dir` read from `floodmind.config.settings`, **independent of the DualMemory session_id**. **Global/shared.**
- Long-term facts (`LongTermMemory`) → single fixed file `memory/long_term_memory.json`. **Global/shared.**
- **Conclusion:** giving each conversation its own `session_id`/`persist_dir` isolates conversation history **without** fragmenting the experience library or long-term memory. This is exactly "per-conversation short-term memory + shared experience library".
- LLM title generation exists in the SDK **server layer**: `_generate_session_title(message, model_key)` (research/fm-sdk/floodmind/server/routes/chat.py:49). Chinese prompt ("10–18 字, 突出任务目标"), `temperature=0.2, max_tokens=60, enable_thinking=False`, returns ≤24-char title. The agent-core `SessionManager._extract_title_from_user_input` is only truncation — we reuse the server-layer LLM approach, not the truncation.

## Architecture

**Sidecar-owned conversation store + frontend-replayed transcript.**

- The **sidecar** owns conversation records (JSON per conversation under app-data) and manages `session_id` switching. It stores `turns` as **opaque JSON** — it does not interpret block structure.
- The **frontend** is the single constructor of the block transcript (it already owns the `reduceEvent` reducer). After a turn completes it POSTs that turn to the sidecar for persistence. On resume it GETs turns and hydrates the store. **Zero reducer duplication.**
- Switching conversations = rebuilding the SDK agent bound to the target conversation's `session_id` (reuses existing `FloodMindAgent._build_agent`).

**Rejected alternatives:**
- Frontend persists via Tauri fs → transcript and session_id become two sources of truth, prone to drift.
- Reconstruct transcript from SDK memory → rejected by user (replay not faithful; thinking/tool detail lossy).
- Sidecar accumulates transcript during `stream()` → would duplicate the frontend block reducer in Python.

## Data model

```python
Conversation = {
  "id":           "conv-<uuid8>",     # desktop conversation id (filename stem)
  "session_id":   "<uuid>",           # passed to SDK DualMemory → isolation key
  "workspace":    "<abs path>",       # owning workspace
  "title":        "<str>",            # instant = truncated first user msg;
                                      #   background LLM-refined (SDK prompt)
  "created_at":   "<ISO8601>",
  "updated_at":   "<ISO8601>",
  "turns":        Msg[]               # same shape as frontend chat-store turns;
}                                     #   opaque to the sidecar
```

**Storage layout:**
- `<app_data>/conversations/<conv_id>.json` — one file per conversation (the full record incl. `turns`).
- Workspace → "last active conversation id" pointer stored in the existing `<app_data>/config.json` (alongside `current`/`recent` workspaces), keyed by workspace path.

## Memory isolation (per conversation)

- Each conversation gets a fresh `session_id` (uuid). On create/activate, `FloodMindAgent` rebuilds the SDK agent via `_build_agent(session_id, persist_dir)` where `persist_dir = <app_data>/<session_id>/memory`.
- Workspace file-permission plumbing (`_set_workspace`, called every stream) is unchanged — it still derives its sid from `session_id_for(workspace_path)`. The memory `session_id` (conversation uuid) and the workspace sid (path hash) are independent and coexist.
- Experience library + long-term memory remain global (see Verified facts) → shared automatically.
- **Implementation risk to verify:** confirm `create_flood_agent(session_id=<conv_uuid>)` does not look up a workspace by that session_id and fail. Mitigation: `_set_workspace()` explicitly calls `set_workspace()`/`set_session_context()` before each stream, so the workspace context is set independently of the agent's session_id. Verify with a real-SDK smoke test (open conversation A, chat, switch to B, chat, switch back to A, confirm agent remembers only A).

## Lifecycle

- **Open workspace** (or app start with a workspace): list conversations for that workspace → activate the workspace's "last active" conversation; if none exists, create one and activate it.
- **新会话 (new):** create a new record (new uuid + new `session_id`), activate it, frontend clears. The previous conversation is **preserved** (no longer wiped).
- **Open a history conversation:** `activate` (rebuild agent bound to its `session_id`) + GET its turns + hydrate the chat store. The workspace's "last active" pointer updates to it.
- **Delete a conversation:** remove its record file AND recursively remove its memory dir `<app_data>/<session_id>/` (user-confirmed: delete memory too). If the deleted conversation was active, activate another (most recent) or create new.

## Title strategy

1. On the first user message of a new conversation, set an **instant fallback title** = first user message truncated (≤30 chars, env-prefix-stripped) so the list is never blank.
2. Schedule a **background LLM title generation** (reuse the SDK server-layer prompt + a dedicated `ModelClient.from_settings(temperature=0.2, max_tokens=60, enable_thinking=False)` call) after that first turn. On success, overwrite the title in the record.
3. Failures are logged and swallowed — the fallback title remains.
4. The frontend refreshes the conversation list (lightweight re-fetch) to pick up the refined title. (No streaming/push channel for titles in MVP; a simple re-list after a turn completes is enough.)

## UI

Sidebar layout (new "会话" section inserted directly under "新会话"):

```
品牌 FloodMind
[+ 新会话]
会话                          ← NEW: list of current-workspace conversations
  · <title>  (active highlighted; hover → delete ✕)
  · <title>
最近                         (workspaces)
工作区                        (+ file tree)
…
Skills / MCP / 设置
```

- List is scoped to the **current workspace**.
- Active conversation is highlighted.
- Hover reveals a delete button (with confirm).
- MVP capabilities: **new / list / open / delete** + LLM auto-title. **Rename and search are deferred** (out of scope for this spec).

## API (sidecar)

| Method | Path | Body / Query | Returns | Effect |
|---|---|---|---|---|
| GET | `/api/conversations` | `?workspace=<abs>` | `[{id,title,updated_at,active}]` | list summaries for the workspace |
| POST | `/api/conversations` | `{workspace}` | `{id,session_id,title}` | create + activate; updates workspace's last-active pointer |
| GET | `/api/conversations/<id>` | — | full Conversation (incl. turns) | load for resume |
| POST | `/api/conversations/<id>/activate` | — | `{ok}` | rebuild agent bound to its session_id; set workspace last-active |
| POST | `/api/conversations/<id>/turns` | `{turns:[userTurn, assistantTurn]}` | `{ok}` | append persisted turn pair (frontend → sidecar) |
| DELETE | `/api/conversations/<id>` | — | `{ok}` | remove record + memory dir; re-activate if needed |

Notes:
- All endpoints degrade gracefully (500 → JSON `{error}`); creation/activation never crash chat.
- The sidecar tracks `active_conversation_id` on the `FloodMindAgent` (or the app-level agent wrapper).
- `POST /api/conversations/<id>/turns` also bumps `updated_at` and, for the first turn, triggers background title generation.
- The old `POST /api/session/reset` endpoint stays in place but the frontend's "新会话" flow **no longer calls it** — it calls `POST /api/conversations` (create) instead. The reset endpoint is retained only so any out-of-band caller doesn't 404; it can be removed in a later cleanup.

## Frontend changes

- **`src/state/chat-store.ts`:**
  - Add `conversationId: string | null`.
  - `send()` finally block: after a turn finalizes, POST the completed user+assistant turn(s) to `/api/conversations/<id>/turns`.
  - Rename the "new session" action: instead of wiping, call `conversationStore.create()` (POST) → set `conversationId` + clear `turns`.
  - Add `hydrate(turns: Msg[])` and `loadConversation(id)` (activate + GET + hydrate).
- **New `src/state/conversation-store.ts`:** `list(workspace)`, `load(id)`, `create(workspace)`, `remove(id)`, `activate(id)`. Mirrors the API.
- **`src/components/Sidebar.tsx`:** add the "会话" section between "新会话" and "最近".
- **`src/App.tsx` / workspace-store:** on workspace change, fetch the conversation list and activate the workspace's conversation (the sidecar's create-if-none handles initial activation).
- After a completed turn, re-fetch the conversation list so the refined LLM title + updated_at show.

## Error handling

- Conversation file read/write failures: logged + swallowed; chat continues in-memory. A missing/corrupt record is skipped in the list.
- `activate` failure (agent rebuild error): logged; the previous agent remains active so chat still works. Surface a non-blocking error to the UI.
- Title generation failure: fallback title retained (see Title strategy).
- Delete of a non-existent conversation: 404 → UI removes it from the list optimistically anyway.
- Concurrent writes (Flask threaded=True): the conversation store uses a lock around read-modify-write, mirroring `WorkspaceManager`.

## Testing

**Sidecar (pytest):**
- CRUD: create → list → get → delete round-trip on a tmp app-data dir.
- `activate` rebuilds the agent with the conversation's session_id (spy on `_build_agent`).
- Delete removes the record file AND the `<session_id>/` memory dir.
- Title generation: monkeypatch `ModelClient` to return a canned title → record updated; failure path retains fallback.
- Workspace scoping: conversations for workspace A don't appear in workspace B's list.
- Thread-safety smoke: concurrent turn-appends don't corrupt the JSON.

**Frontend (vitest):**
- `chat-store`: hydrate restores turns; completed turn POSTs to the sidecar (fetch mock); "new session" creates (POST) rather than wipes.
- `conversation-store`: list/create/delete/activate call the right endpoints.

**Real-SDK smoke (Agent_desktop conda env):**
- Open workspace → a conversation is auto-created and active.
- Chat a multi-step task → turn persists; reopen app → conversation reappears with full transcript.
- New conversation → old one preserved in the list.
- Open the old one → agent remembers only that conversation's context (memory isolation verified).
- Delete → record + memory dir gone.

## Out of scope (later)

- Rename a conversation (LLM titles reduce the need; revisit if users report bad titles).
- Full-text search across conversation history.
- MCP-style CRUD UI polish (pin, archive, multi-select delete).
- Cross-workspace conversation move.
