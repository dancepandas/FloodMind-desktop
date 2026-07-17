import { create } from "zustand";
import { getBaseUrl } from "../lib/sidecar-client";
import { streamChat, appendInstruction as postAppendInstruction, pauseChat, respondToPermissionAsk, type ChatEvent, type ChatMessage } from "../lib/chat-stream";
import { useConversationStore } from "./conversation-store";

export interface PlanStep {
  key: string;
  status: string;
  title?: string;
  outcome?: string;
}
export interface Usage {
  prompt: number;
  completion: number;
  total: number;
}

export type Block =
  | { id: string; kind: "thinking"; content: string }
  | {
      id: string;
      kind: "tool";
      call_id: string;
      tool_name: string;
      status: string;
      input?: string;
      output?: string;
    }
  | { id: string; kind: "text"; content: string; final?: boolean }
  | { id: string; kind: "plan"; title: string; steps: PlanStep[] }
  | { id: string; kind: "artifact"; artKind: "file" | "image"; name: string; path: string }
  | { id: string; kind: "permission"; ask_id: string; call_id: string; tool_name: string; reason: string; input?: unknown; approved?: boolean; auto_approved?: boolean }
  | { id: string; kind: "error"; content: string };

export type Msg = { id: string; role: "user"; content: string } | AssistantTurn;
export interface AssistantTurn {
  id: string;
  role: "assistant";
  blocks: Block[];
  usage: Usage | null;
  done: boolean;
}

/**
 * Derive a human-readable streaming action status from the latest assistant
 * block. Returns an empty string when there is no meaningful action to show.
 */
export function deriveStatusText(lastBlock?: Block): string {
  if (!lastBlock) return "等待响应…";
  if (lastBlock.kind === "thinking") return "正在思考…";
  if (lastBlock.kind === "tool" && lastBlock.status === "running") return `正在执行：${lastBlock.tool_name}…`;
  if (lastBlock.kind === "tool") return "";
  if (lastBlock.kind === "permission" && lastBlock.approved === undefined) return `等待授权：${lastBlock.tool_name}`;
  if (lastBlock.kind === "text" && !lastBlock.final) return "正在回答…";
  return "";
}

interface ChatState {
  turns: Msg[];
  streaming: boolean;
  abortController: AbortController | null;
  conversationId: string | null;
  /** Title of the active conversation (shown in the TopBar). Mirrors the
   *  conversation-store record; updated on new/load/turns-POST so the TopBar
   *  shows the generated title instead of the raw first user message. */
  title: string;
  send: (text: string) => Promise<void>;
  appendInstruction: (text: string) => Promise<void>;
  pause: () => Promise<void>;
  respondToPermission: (askId: string, approved: boolean) => Promise<void>;
  reset: () => void;
  startNew: (workspace: string) => Promise<void>;
  loadConversation: (id: string) => Promise<void>;
}

// Deterministic block ids (also keeps test assertions stable).
let _blockSeq = 0;
const nextId = () => `b${++_blockSeq}`;
// Stable turn ids so React keys survive mid-array splices (e.g. an appended
// user instruction inserted before the active assistant turn). Reusing the same
// counter space as block ids is fine — ids only need to be unique.
const nextTurnId = () => `t${++_blockSeq}`;
/** Test-only: reset the block-id counter so assertions are order-independent. */
export const _resetBlockIdsForTest = () => {
  _blockSeq = 0;
};

/** Append a thinking/text delta, merging into the last block when it's the same kind. */
function appendDelta(blocks: Block[], kind: "thinking" | "text", content: string): Block[] {
  const last = blocks[blocks.length - 1];
  if (last && last.kind === kind) {
    const out = blocks.slice();
    out[out.length - 1] = { ...last, content: (last as { content: string }).content + content };
    return out;
  }
  return [...blocks, { id: nextId(), kind, content }];
}

/** Mark the last text block as the final answer (expanded in the UI). */
function markFinal(blocks: Block[]): Block[] {
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (blocks[i].kind === "text") {
      const out = blocks.slice();
      out[i] = { ...(out[i] as Extract<Block, { kind: "text" }>), final: true };
      return out;
    }
  }
  return blocks;
}

/**
 * Fold one streamed event into the active assistant turn. Pure — returns a new
 * turn — so it is unit-testable in isolation. Events arrive in order, so the
 * block list is naturally interleaved (think → tool → text → tool → final).
 */
export function reduceEvent(turn: AssistantTurn, ev: ChatEvent): AssistantTurn {
  let blocks = turn.blocks;
  let usage = turn.usage;

  switch (ev.type) {
    case "thinking":
      blocks = appendDelta(blocks, "thinking", ev.content);
      break;
    case "text":
      blocks = appendDelta(blocks, "text", ev.content);
      break;
    case "tool_start":
      blocks = [
        ...blocks,
        { id: nextId(), kind: "tool", call_id: ev.call_id, tool_name: ev.tool_name, status: "running", input: ev.input },
      ];
      break;
    case "tool_end": {
      const idx = blocks.findIndex((b) => b.kind === "tool" && b.call_id === ev.call_id);
      if (idx >= 0) {
        blocks = blocks.map((b, i) =>
          i === idx && b.kind === "tool" ? { ...b, status: ev.status, output: ev.output } : b
        );
      } else {
        // Orphan tool_end (no matching start): show it rather than drop the output.
        blocks = [
          ...blocks,
          { id: nextId(), kind: "tool", call_id: ev.call_id, tool_name: ev.tool_name, status: ev.status, output: ev.output },
        ];
      }
      break;
    }
    case "plan": {
      const steps: PlanStep[] = Array.isArray(ev.steps)
        ? ev.steps.map((st: any) => ({
            key: st.key,
            status: st.status,
            title: st.title,
            outcome: st.outcome,
          }))
        : [];
      const idx = blocks.findIndex((b) => b.kind === "plan");
      if (idx >= 0) {
        blocks = blocks.map((b, i) => (i === idx && b.kind === "plan" ? { ...b, title: ev.title, steps } : b));
      } else {
        blocks = [...blocks, { id: nextId(), kind: "plan", title: ev.title, steps }];
      }
      break;
    }
    case "step":
      blocks = blocks.map((b) =>
        b.kind === "plan"
          ? {
              ...b,
              steps: b.steps.map((p) =>
                p.key === ev.key ? { ...p, status: ev.status, outcome: ev.outcome ?? p.outcome } : p
              ),
            }
          : b
      );
      break;
    case "artifact":
      blocks = [...blocks, { id: nextId(), kind: "artifact", artKind: ev.kind, name: ev.name, path: ev.path }];
      break;
    case "permission":
      blocks = [
        ...blocks,
        {
          id: nextId(),
          kind: "permission",
          ask_id: ev.ask_id,
          call_id: ev.call_id,
          tool_name: ev.tool_name,
          reason: ev.reason,
          input: ev.input,
          approved: ev.approved,
          auto_approved: ev.auto_approved,
        },
      ];
      break;
    case "error":
      blocks = [...blocks, { id: nextId(), kind: "error", content: ev.content }];
      break;
    case "usage": {
      const prev = usage ?? { prompt: 0, completion: 0, total: 0 };
      usage = {
        prompt: prev.prompt + ev.prompt,
        completion: prev.completion + ev.completion,
        total: prev.total + ev.total,
      };
      break;
    }
    case "done":
      break; // completion (incl. final-answer marking) handled in send()'s finally
  }

  return { ...turn, blocks, usage };
}

export const useChatStore = create<ChatState>((set, get) => ({
  turns: [],
  streaming: false,
  abortController: null,
  conversationId: null,
  title: "新会话",

  async send(text: string) {
    if (!text.trim()) return;
    // While a stream is active, route to the append path: the message is added
    // to the agent's memory and the SDK executor injects it into the running
    // loop (mid-run steering / queued follow-up).
    if (get().streaming) return get().appendInstruction(text);

    const controller = new AbortController();
    // Index of the first turn belonging to THIS send, so the finally block can
    // persist the whole [user, …promoted appends, assistant] slice in one shot.
    const startLen = get().turns.length;
    set((s) => ({
      turns: [
        ...s.turns,
        { id: nextTurnId(), role: "user", content: text },
        { id: nextTurnId(), role: "assistant", blocks: [], usage: null, done: false },
      ],
      streaming: true,
      abortController: controller,
    }));

    let errored = false;
    try {
      const baseUrl = await getBaseUrl();
      for await (const ev of streamChat(baseUrl, [{ role: "user", content: text }], controller.signal)) {
        if (ev.type === "done") continue;
        set((s) => {
          const turns = s.turns.slice();
          const last = turns[turns.length - 1];
          if (last && last.role === "assistant") turns[turns.length - 1] = reduceEvent(last, ev);
          return { turns };
        });
      }
    } catch (e) {
      if (controller.signal.aborted) return; // finally finalizes without marking final
      errored = true;
      // Surface a mid-stream failure as an error block on the active turn.
      set((s) => {
        const turns = s.turns.slice();
        const last = turns[turns.length - 1];
        if (last && last.role === "assistant") {
          turns[turns.length - 1] = {
            ...last,
            blocks: [...last.blocks, { id: nextId(), kind: "error", content: `⚠️ ${(e as Error).message}` }],
          };
        }
        return { turns };
      });
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
      // Persist this send's slice — the original user turn, any appended user
      // turns inserted during the run, and the final assistant turn — together.
      if (finalize && text.trim()) {
        const cid = get().conversationId;
        if (cid) {
          const pair = get().turns.slice(startLen);
          const last = pair[pair.length - 1];
          if (last && last.role === "assistant") {
            getBaseUrl()
              .then(async (b) => {
                const r = await fetch(`${b}/api/conversations/${cid}/turns`, {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ turns: pair }),
                });
                if (!r.ok) return;
                const data = await r.json().catch(() => ({}));
                const title = data?.title;
                if (title) {
                  // TopBar reads chat-store `title`; the sidebar reads
                  // byWorkspace. Update both so the generated title shows live
                  // without a workspace/conversation switch.
                  set({ title });
                  useConversationStore.setState((s) => ({
                    list: s.list.map((c) =>
                      c.id === cid ? { ...c, title } : c
                    ),
                    byWorkspace: Object.fromEntries(
                      Object.entries(s.byWorkspace).map(([ws, items]) => [
                        ws,
                        items.map((c) => (c.id === cid ? { ...c, title } : c)),
                      ])
                    ),
                  }));
                }
              })
              .catch(() => {
                /* persistence is best-effort; the local transcript is the live source */
              });
          }
        }
      }
    }
  },

  async appendInstruction(text: string) {
    const trimmed = text.trim();
    if (!trimmed) return;
    // Insert the appended instruction as a normal user bubble placed just
    // BEFORE the active assistant turn (NOT at the end). The streaming reducer
    // only updates turns[last] when it is the assistant's, so appending at the
    // end would freeze the UI — inserting before keeps the assistant turn last
    // while showing the instruction immediately, below the original request.
    // The SDK picks the text up at the next iteration boundary; the still-open
    // /api/chat stream keeps reducing into the assistant turn.
    const marker: Msg = { id: nextTurnId(), role: "user", content: trimmed };
    set((s) => {
      const turns = s.turns.slice();
      const lastIdx = turns.length - 1;
      if (lastIdx >= 0 && turns[lastIdx].role === "assistant") {
        turns.splice(lastIdx, 0, marker);
      } else {
        turns.push(marker);
      }
      return { turns };
    });
    try {
      const baseUrl = await getBaseUrl();
      await postAppendInstruction(baseUrl, trimmed);
    } catch {
      // The SDK never received it — roll back the optimistic bubble so the
      // transcript doesn't record an instruction that was never queued. The
      // running stream is unaffected.
      set((s) => ({ turns: s.turns.filter((t) => t !== marker) }));
    }
  },

  async pause() {
    const ctl = get().abortController;
    if (!ctl) return;
    // Tell the server to abort the agent at the next LLM/tool boundary (the
    // partial round is discarded, not written to memory).
    try {
      const baseUrl = await getBaseUrl();
      await pauseChat(baseUrl);
    } catch {
      // best-effort — still abort the client stream below
    }
    // Stop reading the stream; the in-flight send()'s finally finalizes the
    // turn (aborted → not final, done). The next send() resumes from memory.
    ctl.abort();
  },

  async respondToPermission(askId: string, approved: boolean) {
    try {
      const baseUrl = await getBaseUrl();
      await respondToPermissionAsk(baseUrl, askId, approved);
      // Optimistically reflect the user's choice in the UI; the SDK emits
      // permission_resolved after the fact, but translate_event currently drops
      // it. Search EVERY assistant turn (not just the last) — in a multi-turn
      // session the ask may live on an earlier turn, and only updating the last
      // would leave a stale "waiting for authorization" block behind.
      set((s) => ({
        turns: s.turns.map((t) =>
          t.role === "assistant"
            ? {
                ...t,
                blocks: t.blocks.map((b) =>
                  b.kind === "permission" && b.ask_id === askId ? { ...b, approved } : b
                ),
              }
            : t
        ),
      }));
    } catch (e) {
      set((s) => {
        const turns = s.turns.slice();
        const last = turns[turns.length - 1];
        if (last && last.role === "assistant") {
          turns[turns.length - 1] = {
            ...last,
            blocks: [...last.blocks, { id: nextId(), kind: "error", content: `⚠️ ${(e as Error).message}` }],
          };
        }
        return { turns };
      });
    }
  },

  reset: () => {
    get().abortController?.abort();
    set({ turns: [], streaming: false, abortController: null, title: "新会话" });
  },

  async startNew(workspace: string) {
    get().abortController?.abort();
    const conv = await useConversationStore.getState().create(workspace);
    set({
      turns: [],
      streaming: false,
      abortController: null,
      conversationId: conv ? conv.id : null,
      title: conv ? conv.title : "新会话",
    });
    await useConversationStore.getState().loadList(workspace);
  },

  async loadConversation(id: string) {
    get().abortController?.abort();
    await useConversationStore.getState().activate(id);
    const conv = await useConversationStore.getState().open(id);
    if (!conv) return;
    set({
      // Assign fresh stable ids on load (server stores turns opaquely); keys
      // only need to be stable within a render session.
      turns: (conv.turns || []).map((t: Msg) => ({ ...t, id: nextTurnId() })),
      streaming: false,
      abortController: null,
      conversationId: conv.id,
      title: conv.title,
    });
  },
}));
