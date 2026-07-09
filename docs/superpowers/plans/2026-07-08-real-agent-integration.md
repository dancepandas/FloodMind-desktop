# FloodMind Desktop — Plan 2: Real FloodMind Agent Integration

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Plan 1 stub agent with the real FloodMind `Agent`, and render its real event stream (streaming text, tool calls, workflow/todo, artifacts, permission asks) in the desktop UI.

**Architecture:** Keep the Plan 1 thin Flask sidecar and its `Agent` seam. Add a `FloodMindAgent` adapter that wraps `floodmind.agent.Agent` (bare mode) and translates its raw stream events into an expanded sidecar NDJSON schema. Expand the frontend `ChatEvent` union, the Zustand store, and the components to render tool-call cards, a workflow/Todo panel, artifact cards, and a permission approval bar.

**Tech Stack:** Python 3.13, floodmind SDK (editable install from `research/fm-sdk`), Flask; React 19, TypeScript, Zustand, vitest.

## Global Constraints

- Repo root: `D:\chengs\9.project\Agent_desktop` (Windows, bash, conda env `Agent_desktop`).
- The floodmind SDK is cloned at `research/fm-sdk` (gitignored). Install editable: `pip install -e research/fm-sdk` (pulls chromadb + sentence-transformers → torch transitively; heavy but dev-only — the torch-free *bundled* sidecar is a Plan 5 packaging concern).
- A working LLM provider + API key is **required** for the real agent. Config lives at `~/.floodmind/settings.json` (read by `ModelClient.from_settings()`). Plan 2 Task 1 sets this up.
- Keep the sidecar bound to `127.0.0.1` only; CORS already enabled (Plan 1).
- TDD where there's pure logic (event translation, frontend parsing). GUI steps verified by construction + manual check.
- Follow the review→fix→review→fix loop (superpowers requesting-code-review) after each task.

## SDK facts this plan depends on (verified from `research/fm-sdk` source)

- **Embedding API:** `from floodmind.agent import Agent` then `Agent(llm=<ModelClient>, tools=[...], system_prompt=..., permission_handler=callable)`. Methods: `.stream(message) -> Iterator[dict]`, `.run(message) -> str`. Props: `.last_usage`, `.artifacts`, `.raw`.
- **Model client:** `from floodmind.agent.native.model_client import ModelClient; ModelClient.from_settings()` reads `~/.floodmind/settings.json`.
- **Event types emitted by `Agent.stream()`** (raw, pre-server-transform): `answer_delta` (`{content}`), `thought_delta` (`{content}`), `final_text` (`{content}`), `action_start` (`{tool_name,status,call_id?,tool_input?}`), `action_end` (`{tool_name,status,content,call_id?}`), `workflow_plan` (`{title,steps[]}`), `workflow_step` (`{step_key,status,title?,detail?,outcome?}`), `file_generated` (`{filename,download_url,size}`), `image_generated` (`{filename,image_url,size}`), `permission_ask` (`{ask_id,call_id,tool_name,reason,tool_input}`), `heartbeat`, `token_usage` (`{prompt_tokens,completion_tokens,total_tokens}`), `error` (`{content}`), plus `llm_step_start/end`, `context_compress_*`.
- **Permission callback:** `permission_handler(tool_name, tool_input) -> bool` (synchronous) — return True to approve, False to deny. Cleaner than the web-server's ask_id/respond dance, so we use the callback and surface the ask to the UI.

## Sidecar NDJSON event schema (expanded — the contract between sidecar and frontend)

The adapter normalizes raw SDK events into this flat schema (one JSON object per line):

| `type` | fields | source SDK event |
|---|---|---|
| `text` | `content` | `answer_delta` |
| `thinking` | `content` | `thought_delta` |
| `tool_start` | `call_id`, `tool_name`, `input` | `action_start` (status≠pending_confirmation) |
| `tool_end` | `call_id`, `tool_name`, `status`, `output` | `action_end` |
| `plan` | `title`, `steps[]` | `workflow_plan` |
| `step` | `key`, `status`, `title?`, `outcome?` | `workflow_step` |
| `artifact` | `kind`(`file`\|`image`), `name`, `path` | `file_generated`/`image_generated` |
| `permission` | `ask_id`, `call_id`, `tool_name`, `reason`, `input` | `permission_ask` |
| `usage` | `prompt`, `completion`, `total` | `token_usage` |
| `error` | `content` | `error` |
| `done` | — | stream end (adapter-emitted) |

(`heartbeat`, `final_text`, `llm_step_*`, `context_compress_*` are consumed/ignored by the adapter — heartbeat dropped, final_text dropped since `text` already streamed the answer, llm/context events optionally logged.)

---

## Task 1: Install floodmind SDK + configure LLM; verify a real one-shot stream

**Files:**
- Modify: `sidecar/pyproject.toml` (add `floodmind` to deps — or document editable install)
- Verify only: `~/.floodmind/settings.json`

**Interfaces:**
- Produces: `from floodmind.agent import Agent` importable; `Agent(llm=ModelClient.from_settings()).stream("你好")` yields events.

- [ ] **Step 1: Install the SDK editable**

```bash
cd "D:/chengs/9.project/Agent_desktop"
pip install -e research/fm-sdk
```
Expected: succeeds (slow first time — pulls chromadb, sentence-transformers→torch, pandas, matplotlib). Note the install size.

- [ ] **Step 2: Ensure LLM config exists**

Check `~/.floodmind/settings.json`. If absent, create from the README template with a real provider + `apiKey` + a model. The user must supply the API key. Minimal shape:

```json
{
  "provider": {
    "dashscope": {
      "name": "DashScope (Alibaba)",
      "options": { "apiKey": "sk-REPLACE", "baseURL": "https://dashscope.aliyuncs.com/compatible-mode/v1" },
      "models": { "deepseek-v4-flash": { "name": "DeepSeek V4 Flash", "maxTokens": 65536 } }
    }
  },
  "model": { "provider": "dashscope", "model": "deepseek-v4-flash" }
}
```

- [ ] **Step 3: Verify a real stream from Python**

```bash
python -c "from floodmind.agent import Agent; from floodmind.agent.native.model_client import ModelClient; a=Agent(llm=ModelClient.from_settings()); [print(e.get('type'), e.get('content','')[:30]) for e in a.stream('用一句话介绍你自己')]"
```
Expected: prints a sequence of event types including `answer_delta` (text) and finally `final_text`. If it errors on missing key/network, fix config before proceeding.

- [ ] **Step 4: Commit** (only if pyproject changed)

```bash
git add -A && git commit -m "chore(sidecar): depend on floodmind SDK (editable)"
```

---

## Task 2: `FloodMindAgent` adapter + expanded event schema (TDD)

**Files:**
- Create: `sidecar/floodmind_desktop_sidecar/floodmind_agent.py`
- Modify: `sidecar/floodmind_desktop_sidecar/agent.py` (keep `StubAgent` + `Agent` Protocol; the Protocol's `stream` return is unchanged — `Iterator[dict]`)
- Modify: `sidecar/floodmind_desktop_sidecar/__main__.py` (use `FloodMindAgent` instead of `StubAgent`)
- Create: `sidecar/tests/test_floodmind_agent.py`

**Interfaces:**
- Produces: `FloodMindAgent` implementing the sidecar `Agent` Protocol; `.stream(messages)` yields the expanded-schema events above. `permission_handler` defaults to auto-approve for now (Task 4 wires the real UI).

- [ ] **Step 1: Write the failing translation test (pure, no network)**

The adapter has a pure function `translate_event(raw: dict) -> list[dict]` that maps one SDK event to zero-or-more schema events. Test it against fixture raw events (no real agent needed):

`sidecar/tests/test_floodmind_agent.py`:
```python
from floodmind_desktop_sidecar.floodmind_agent import translate_event


def test_answer_delta_becomes_text():
    out = translate_event({"type": "answer_delta", "content": "Hello"})
    assert out == [{"type": "text", "content": "Hello"}]


def test_action_start_becomes_tool_start():
    out = translate_event(
        {"type": "action_start", "tool_name": "search", "status": "running",
         "call_id": "c1", "tool_input": '{"q": "x"}'}
    )
    assert out == [{"type": "tool_start", "call_id": "c1", "tool_name": "search", "input": '{"q": "x"}'}]


def test_workflow_plan_becomes_plan():
    raw = {"type": "workflow_plan", "title": "T", "steps": [{"key": "s1", "label": "a", "title": "A", "status": "pending", "detail": "", "outcome": "", "expected_deliverables": [], "output_artifacts": [], "subtasks": []}]}
    out = translate_event(raw)
    assert out[0]["type"] == "plan"
    assert out[0]["title"] == "T" and out[0]["steps"][0]["key"] == "s1"


def test_heartbeat_dropped():
    assert translate_event({"type": "heartbeat"}) == []


def test_file_generated_becomes_artifact():
    out = translate_event({"type": "file_generated", "filename": "r.xlsx", "download_url": "/x", "size": 10})
    assert out == [{"type": "artifact", "kind": "file", "name": "r.xlsx", "path": "/x"}]


def test_unknown_event_passes_through_minimal():
    out = translate_event({"type": "something_new", "content": "x"})
    assert out == [{"type": "something_new", "content": "x"}]
```

- [ ] **Step 2: Run → fail (module missing)**

```bash
cd sidecar && python -m pytest tests/test_floodmind_agent.py -v
```
Expected: `ModuleNotFoundError: floodmind_desktop_sidecar.floodmind_agent`.

- [ ] **Step 3: Implement the adapter**

`sidecar/floodmind_desktop_sidecar/floodmind_agent.py`:
```python
"""Adapter wrapping the real FloodMind SDK Agent behind our sidecar Agent seam."""
from __future__ import annotations

from typing import Iterator

from .agent import Agent as SidecarAgent, Message


def translate_event(raw: dict) -> list[dict]:
    """Map one raw SDK event to zero-or-more sidecar-schema events."""
    t = raw.get("type")
    if t == "answer_delta":
        return [{"type": "text", "content": raw.get("content", "")}]
    if t == "thought_delta":
        return [{"type": "thinking", "content": raw.get("content", "")}]
    if t == "action_start":
        return [{"type": "tool_start", "call_id": raw.get("call_id", ""),
                 "tool_name": raw.get("tool_name", ""), "input": raw.get("tool_input", "")}]
    if t == "action_end":
        return [{"type": "tool_end", "call_id": raw.get("call_id", ""),
                 "tool_name": raw.get("tool_name", ""),
                 "status": raw.get("status", ""), "output": raw.get("content", "")}]
    if t == "workflow_plan":
        return [{"type": "plan", "title": raw.get("title", ""),
                 "steps": raw.get("steps", [])}]
    if t == "workflow_step":
        return [{"type": "step", "key": raw.get("step_key", raw.get("key", "")),
                 "status": raw.get("status", ""), "title": raw.get("title", ""),
                 "outcome": raw.get("outcome", "")}]
    if t in ("file_generated", "image_generated"):
        return [{"type": "artifact", "kind": "image" if t == "image_generated" else "file",
                 "name": raw.get("filename", raw.get("file_name", "")),
                 "path": raw.get("image_url", raw.get("download_url", ""))}]
    if t == "permission_ask":
        return [{"type": "permission", "ask_id": raw.get("ask_id", ""),
                 "call_id": raw.get("call_id", ""), "tool_name": raw.get("tool_name", ""),
                 "reason": raw.get("reason", ""), "input": raw.get("tool_input", {})}]
    if t == "token_usage":
        return [{"type": "usage", "prompt": raw.get("prompt_tokens", 0),
                 "completion": raw.get("completion_tokens", 0),
                 "total": raw.get("total_tokens", 0)}]
    if t == "error":
        return [{"type": "error", "content": raw.get("content", "")}]
    # Drop noisy/Redundant events.
    if t in ("heartbeat", "final_text", "llm_step_start", "llm_step_end",
             "context_compress_start", "context_compress_done", "permission_resolved"):
        return []
    # Unknown: minimal pass-through so new event types aren't silently lost.
    return [{"type": t or "unknown", **{k: v for k, v in raw.items() if k != "type"}}]


class FloodMindAgent:
    """Sidecar Agent backed by the real FloodMind SDK."""

    def __init__(self, permission_handler=None):
        from floodmind.agent import Agent
        from floodmind.agent.native.model_client import ModelClient

        llm = ModelClient.from_settings()
        # Auto-approve by default; Task 4 replaces this with a UI-driven handler.
        self._permission_handler = permission_handler or (lambda tool_name, tool_input: True)
        self._agent = Agent(
            llm=llm,
            permission_handler=self._permission_handler,
            max_iterations=50,
        )

    def stream(self, messages: list[Message]) -> Iterator[dict]:
        user_text = messages[-1]["content"] if messages else ""
        for raw in self._agent.stream(user_text):
            for ev in translate_event(raw):
                yield ev
        yield {"type": "done"}
```

- [ ] **Step 4: Run → green**

```bash
python -m pytest tests/test_floodmind_agent.py -v
```
Expected: 6 passed.

- [ ] **Step 5: Wire it into `__main__.py`**

In `sidecar/floodmind_desktop_sidecar/__main__.py`, replace `StubAgent()` with `FloodMindAgent()`:
```python
from .floodmind_agent import FloodMindAgent
# ...
    app = create_app(FloodMindAgent())
```

- [ ] **Step 6: Smoke-test the sidecar end-to-end**

```bash
cd "D:/chengs/9.project/Agent_desktop"
python -m floodmind_desktop_sidecar > /tmp/sc.log 2>&1 &
PID=$!; sleep 4
PORT=$(head -n1 /tmp/sc.log | awk '{print $2}')
curl -s -X POST "http://127.0.0.1:$PORT/api/chat" -H "Origin: http://127.0.0.1:1420" -H "Content-Type: application/json" --data-raw '{"messages":[{"role":"user","content":"用一句话介绍你自己"}]}'
kill $PID
```
Expected: NDJSON lines including `{"type":"text",...}` and ending `{"type":"done"}` (and possibly `usage`, `plan`/`step`/`tool_*` depending on the model's behavior).

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "feat(sidecar): real FloodMind agent adapter + expanded event schema"
```

---

## Task 3: Frontend — expand ChatEvent types, parser, and store

**Files:**
- Modify: `src/lib/chat-stream.ts` (broaden `ChatEvent` union)
- Modify: `src/lib/chat-stream.test.ts` (add a multi-event-type parse test)
- Modify: `src/state/chat-store.ts` (handle the new event types into dedicated slices)

**Interfaces:**
- Produces: a `ChatEvent` union covering all sidecar schema types; the store exposes `messages`, `tools`, `plan`, `artifacts`, `permission`, `usage`.

- [ ] **Step 1: Broaden `ChatEvent` in `chat-stream.ts`**

```ts
export type ChatMessage = { role: string; content: string };

export type ChatEvent =
  | { type: "text"; content: string }
  | { type: "thinking"; content: string }
  | { type: "tool_start"; call_id: string; tool_name: string; input: string }
  | { type: "tool_end"; call_id: string; tool_name: string; status: string; output: string }
  | { type: "plan"; title: string; steps: any[] }
  | { type: "step"; key: string; status: string; title?: string; outcome?: string }
  | { type: "artifact"; kind: "file" | "image"; name: string; path: string }
  | { type: "permission"; ask_id: string; call_id: string; tool_name: string; reason: string; input: any }
  | { type: "usage"; prompt: number; completion: number; total: number }
  | { type: "error"; content: string }
  | { type: "done" };
```
(The `streamChat` body is unchanged — it already yields `JSON.parse(line) as ChatEvent`.)

- [ ] **Step 2: Add a parse test for mixed events**

Append to `src/lib/chat-stream.test.ts`:
```ts
it("parses mixed event types", async () => {
  (globalThis.fetch as any).mockResolvedValue(
    ndjsonResponse([
      '{"type":"tool_start","call_id":"c1","tool_name":"search","input":"x"}\n',
      '{"type":"text","content":"Hi"}\n',
      '{"type":"artifact","kind":"file","name":"r.xlsx","path":"/r"}\n',
      '{"type":"done"}\n',
    ])
  );
  const events = [];
  for await (const e of streamChat("http://x", [{ role: "user", content: "hi" }])) events.push(e);
  expect(events.map((e) => e.type)).toEqual(["tool_start", "text", "artifact", "done"]);
});
```
Run `npm test` → green (4 chat-stream tests).

- [ ] **Step 3: Expand the store to route events into slices**

Rewrite `src/state/chat-store.ts` to accumulate text into the assistant message (as before) and collect the rest:
```ts
import { create } from "zustand";
import { getBaseUrl } from "../lib/sidecar-client";
import { streamChat, type ChatEvent, type ChatMessage } from "../lib/chat-stream";

type Role = "user" | "assistant";
export interface ToolCall { call_id: string; tool_name: string; status: string; input?: string; output?: string; }
export interface PlanStep { key: string; status: string; title?: string; outcome?: string; }
export interface Artifact { kind: "file" | "image"; name: string; path: string; }

interface ChatState {
  messages: { role: Role; content: string }[];
  streaming: boolean;
  tools: ToolCall[];
  planTitle: string;
  planSteps: PlanStep[];
  artifacts: Artifact[];
  usage: { prompt: number; completion: number; total: number } | null;
  permission: { ask_id: string; call_id: string; tool_name: string; reason: string; input: any } | null;
  error: string | null;
  send: (text: string) => Promise<void>;
  reset: () => void;
}

export const useChatStore = create<ChatState>((set, get) => ({
  messages: [], streaming: false, tools: [], planTitle: "", planSteps: [],
  artifacts: [], usage: null, permission: null, error: null,

  async send(text: string) {
    if (!text.trim() || get().streaming) return;
    const userMsg: ChatMessage = { role: "user", content: text };
    set((s) => ({
      messages: [...s.messages, { role: "user", content: text }, { role: "assistant", content: "" }],
      streaming: true, tools: [], planTitle: "", planSteps: [], artifacts: [],
      usage: null, permission: null, error: null,
    }));
    try {
      const baseUrl = await getBaseUrl();
      let acc = "";
      for await (const ev of streamChat(baseUrl, [userMsg])) {
        switch (ev.type) {
          case "text":
            acc += ev.content;
            set((s) => { const m = [...s.messages]; m[m.length - 1] = { role: "assistant", content: acc }; return { messages: m }; });
            break;
          case "tool_start":
            set((s) => ({ tools: [...s.tools, { call_id: ev.call_id, tool_name: ev.tool_name, status: "running", input: ev.input }] }));
            break;
          case "tool_end":
            set((s) => ({ tools: s.tools.map((t) => t.call_id === ev.call_id ? { ...t, status: ev.status, output: ev.output } : t) }));
            break;
          case "plan":
            set({ planTitle: ev.title, planSteps: ev.steps.map((st: any) => ({ key: st.key, status: st.status, title: st.title, outcome: st.outcome })) });
            break;
          case "step":
            set((s) => ({ planSteps: s.planSteps.map((p) => p.key === ev.key ? { ...p, status: ev.status, outcome: ev.outcome ?? p.outcome } : p) }));
            break;
          case "artifact":
            set((s) => ({ artifacts: [...s.artifacts, { kind: ev.kind, name: ev.name, path: ev.path }] }));
            break;
          case "permission":
            set({ permission: { ask_id: ev.ask_id, call_id: ev.call_id, tool_name: ev.tool_name, reason: ev.reason, input: ev.input } });
            break;
          case "usage":
            set({ usage: { prompt: ev.prompt, completion: ev.completion, total: ev.total } });
            break;
          case "error":
            set({ error: ev.content });
            break;
        }
      }
    } catch (e) {
      set((s) => { const m = [...s.messages]; m[m.length - 1] = { role: "assistant", content: `⚠️ 出错：${(e as Error).message}` }; return { messages: m, error: (e as Error).message }; });
    } finally {
      set({ streaming: false });
    }
  },

  reset: () => set({ messages: [], streaming: false, tools: [], planTitle: "", planSteps: [], artifacts: [], usage: null, permission: null, error: null }),
}));
```

- [ ] **Step 4: Update the store test for the new slices**

Adjust `src/state/chat-store.test.ts` so the accumulation test still asserts `messages` and `streaming`, and add a test that a `tool_start`/`tool_end` pair populates `tools`. Run `npm test` → green.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(ui): expanded ChatEvent union + store slices for tools/plan/artifacts/usage"
```

---

## Task 4: Render tool calls, workflow/Todo, artifacts, usage

**Files:**
- Create: `src/components/ToolList.tsx`, `src/components/PlanPanel.tsx`, `src/components/ArtifactList.tsx`, `src/components/UsageBadge.tsx`
- Modify: `src/App.tsx` (lay out chat + a right rail), `src/app.css`

**Interfaces:**
- Consumes: the new store slices.

- [ ] **Step 1: ToolList** — renders each `tools[]` entry as a compact card (tool_name, status chip, expandable input/output).
- [ ] **Step 2: PlanPanel** — renders `planTitle` + `planSteps[]` with status chips (pending/running/completed/error).
- [ ] **Step 3: ArtifactList** — lists `artifacts[]` (name, kind icon). (Opening the file is Plan 4 — desktop fs integration; here just display the path/name.)
- [ ] **Step 4: UsageBadge** — shows `usage.total` tokens when present.
- [ ] **Step 5: App layout** — header(HealthBadge + UsageBadge), main row: ChatView (flex) + right rail (PlanPanel, ToolList, ArtifactList). Update CSS.
- [ ] **Step 6: Build + test** — `npm run build && npm test` green.
- [ ] **Step 7: Manual check** — `npm run tauri dev`, ask the agent a task that uses tools (e.g. "生成一个简单的 Excel 报表"), confirm cards/panel/artifacts appear and stream.
- [ ] **Step 8: Commit** — `git commit -m "feat(ui): render tool calls, workflow plan, artifacts, usage"`.

---

## Task 5: Permission approval flow — DEFERRED to Plan 4

**Finding during Plan 2:** bare mode (the `Agent` class) skips `permission_ask` events and registers no tools, so we switched `FloodMindAgent` to **`create_flood_agent` (non-bare)**, which uses the SDK's `AskService` and DOES emit `permission_ask` through the stream. So the flow is now implementable via the SDK's native machinery:

- `permission_ask` events flow through the stream → our adapter already maps them to `{type:"permission",...}` → frontend `PermissionBar`.
- Frontend POSTs `/api/permission/respond {ask_id, approved}` → calls the SDK's `get_ask_service().respond(...)` to unblock the executor.

**Why deferred:** (1) permission gating is a safety refinement — the flood-forecasting agent is low-destructiveness, and we currently pass `permission_handler=auto-approve`, which works for MVP; (2) we need to empirically confirm whether our `permission_handler` callback bypasses `AskService` asks entirely (in which case no `permission_ask` events fire) or coexists with them — that determines the exact wiring; (3) whether asks fire at all depends on the default tools' `permission_policy` settings.

**Carry to Plan 4:** build `PermissionBar` + the `/api/permission/respond` route wired to `get_ask_service().respond`; drop the auto-approve handler; verify a real tool (e.g. a file-writing or bash tool) triggers an ask. The adapter's `permission` mapping (`floodmind_agent.py:translate_event`) is already in place and tested.

---

## Task 6: Session persistence across sidecar restarts (optional for MVP)

**Files:**
- Modify: `sidecar/floodmind_desktop_sidecar/floodmind_agent.py`, `__main__.py`

- [ ] Persist `DualMemory` chat history to disk on stream end; reload on startup keyed by a `session_id`. This is a nice-to-have; if the real agent already persists via its memory layer, verify and skip. Defer to Plan 3 (Workspace) if it overlaps.

---

## Plan 2 Done — Definition of Done

- [ ] Real floodmind `Agent` powers the sidecar (stub removed from the active path; kept for tests).
- [ ] Streaming text, tool calls, workflow/plan, artifacts, usage all render in the desktop UI.
- [ ] Permission asks surface a working Approve/Deny bar.
- [ ] `npm test`, `cd sidecar && python -m pytest`, `cd src-tauri && cargo test --lib` all green.
- [ ] Manual: a real multi-step task (e.g. "分析并生成一份简报") streams text, shows tool cards + plan steps + an artifact, and token usage.

## Carry-overs

- **Plan 3 (Workspace):** per-workspace agent instances + memory isolation; session_id tied to workspace.
- **Plan 4 (rich surface):** open artifacts with the system default app (desktop fs), memory search panel, artifact file-explorer, autoscroll throttle, RTL/component tests.
- **Plan 5 (packaging):** torch-free bundled sidecar (install SDK with `--no-deps` + manual light deps, or lazy-import the heavy modules), restrict CORS origin, Job Object kill, graceful startup-error dialog.
