import { create } from "zustand";
import { getBaseUrl } from "../lib/sidecar-client";
import { streamChat, appendInstruction as postAppendInstruction, pauseChat, respondToPermissionAsk, type ArtifactSource, type ChatEvent, type ChatMessage, type ImageAttachmentWire } from "../lib/chat-stream";
import { looksLikeFsPath } from "../lib/file-refs";
import { useConversationStore, type Conversation } from "./conversation-store";
import { useConfigStore } from "./config-store";

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
  | { id: string; kind: "thinking"; content: string; round?: number }
  | {
      id: string;
      kind: "tool";
      call_id: string;
      tool_name: string;
      status: string;
      input?: string;
      output?: string;
      round?: number;
    }
  | { id: string; kind: "text"; content: string; final?: boolean; round?: number }
  | { id: string; kind: "plan"; title: string; steps: PlanStep[] }
  | {
      id: string;
      kind: "artifact";
      artKind: "file" | "image";
      name: string;
      path: string;
      final?: boolean;
      exists?: boolean;
      size?: number;
      source?: ArtifactSource;
    }
  | { id: string; kind: "permission"; ask_id: string; call_id: string; tool_name: string; reason: string; input?: unknown; approved?: boolean; auto_approved?: boolean }
  | { id: string; kind: "context"; label: string; content: string; round?: number }
  | { id: string; kind: "error"; content: string };

export type ArtifactBlock = Extract<Block, { kind: "artifact" }>;

export type Msg =
  | { id: string; role: "user"; content: string; images?: { name: string; thumb: string }[]; attachments?: { path: string; name: string }[] }
  | AssistantTurn;
export interface AssistantTurn {
  id: string;
  role: "assistant";
  blocks: Block[];
  usage: Usage | null;
  done: boolean;
  /** Plan-mode proposal awaiting user confirmation (produced by a plan-mode send). */
  plan?: { awaiting: boolean; originalText?: string; cancelled?: boolean };
  /** Latest non-`tool_calls` finish_reason from `llm_step_end` (drives turn status). */
  finishReason?: string;
  /** Block id of the final answer text block (data pointer, not DOM position). */
  finalNodeId?: string;
  /** Epoch ms the turn was created / completed (for the elapsed-time metric). */
  startedAt?: number;
  completedAt?: number;
  /** SDK internal LLM iteration currently streaming. Process blocks inherit it. */
  activeRound?: number;
}

interface ChatState {
  turns: Msg[];
  streaming: boolean;
  /** Guards the async new-conversation creation (防连击: rapid clicks on 新建任务
   *  must not spawn a pile of empty conversations). */
  startingNew: boolean;
  abortController: AbortController | null;
  conversationId: string | null;
  /** Title of the active conversation (shown in the TopBar). Mirrors the
   *  conversation-store record; updated on new/load/turns-POST so the TopBar
   *  shows the generated title instead of the raw first user message. */
  title: string;
  send: (
    text: string,
    attachments?: ImageAttachmentWire[],
    images?: { name: string; thumb: string }[],
    fileRefs?: { path: string; name: string }[],
    mode?: import("./config-store").WorkMode,
  ) => Promise<void>;
  appendInstruction: (text: string) => Promise<void>;
  pause: () => Promise<void>;
  respondToPermission: (askId: string, approved: boolean) => Promise<void>;
  /** Confirm a plan-mode proposal: re-send the original request in craft mode. */
  confirmPlan: (turnId: string) => Promise<void>;
  /** Dismiss a plan proposal without executing (for 补充/讨论 — the plan stays visible). */
  dismissPlan: (turnId: string) => void;
  /** Cancel a plan-mode proposal (marks the turn cancelled; no execution). */
  cancelPlan: (turnId: string) => void;
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

/** Append a thinking/text delta, merging only inside the same internal round. */
function appendDelta(
  blocks: Block[],
  kind: "thinking" | "text",
  content: string,
  round?: number,
): Block[] {
  const last = blocks[blocks.length - 1];
  if (last && last.kind === kind && last.round === round) {
    const out = blocks.slice();
    out[out.length - 1] = { ...last, content: last.content + content };
    return out;
  }
  return [...blocks, { id: nextId(), kind, content, ...(round !== undefined ? { round } : {}) }];
}

/**
 * Mark the last text block as the final answer, returning its id too. This is a
 * fallback for paths that never emit `llm_step_end(reason="stop")` (e.g. a
 * provider/step that skips the finish signal); the primary final-answer path is
 * the `finish` event handled in reduceEvent().
 */
function finalizeBlocks(blocks: Block[]): { blocks: Block[]; finalNodeId?: string } {
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (blocks[i].kind === "text") {
      const out = blocks.slice();
      out[i] = { ...(out[i] as Extract<Block, { kind: "text" }>), final: true };
      return { blocks: out, finalNodeId: out[i].id };
    }
  }
  return { blocks };
}

/**
 * 重连对账：网络断流但 run 在 sidecar 后台继续时，按游标从缓冲补拉
 * 错过的 wire 事件，直至 run 完结。返回 true 表示已补拉并完结。
 */
async function catchUpEvents(
  lastCount: number,
  onEvent: (ev: ChatEvent) => void,
  signal?: AbortSignal,
  maxMs = 120_000,
): Promise<boolean> {
  let count = lastCount;
  const baseUrl = await getBaseUrl();
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    if (signal?.aborted) return false;
    try {
      const r = await fetch(`${baseUrl}/api/chat/events?since=${count}`);
      if (!r.ok) return false;
      const data = (await r.json().catch(() => ({}))) as { events?: unknown[]; done?: boolean };
      for (const raw of data.events ?? []) {
        const ev = raw as ChatEvent;
        if (ev.type === "done") continue;
        count += 1;
        onEvent(ev);
      }
      if (data.done) return true;
    } catch {
      return false;
    }
    await new Promise((res) => setTimeout(res, 800));
  }
  return false;
}

/**
 * Fold one streamed event into the active assistant turn. Pure — returns a new
 * turn — so it is unit-testable in isolation. Events arrive in order, so the
 * block list is naturally interleaved (think → tool → text → tool → final).
 */
export function reduceEvent(turn: AssistantTurn, ev: ChatEvent): AssistantTurn {
  let blocks = turn.blocks;
  let usage = turn.usage;
  let finishReason = turn.finishReason;
  let finalNodeId = turn.finalNodeId;
  let activeRound = turn.activeRound;

  switch (ev.type) {
    case "round_start": {
      if (activeRound === ev.iteration) break; // replay/duplicate event
      activeRound = ev.iteration;
      // A queued mid-run instruction can revive the executor after a temporary
      // stop. That answer becomes intermediate once a newer LLM round starts.
      if (finalNodeId) {
        blocks = blocks.map((block) =>
          block.id === finalNodeId && block.kind === "text"
            ? { ...block, final: false }
            : block
        );
        finalNodeId = undefined;
        finishReason = undefined;
      }
      break;
    }
    case "thinking":
      blocks = appendDelta(blocks, "thinking", ev.content, activeRound);
      break;
    case "text":
      blocks = appendDelta(blocks, "text", ev.content, activeRound);
      break;
    case "tool_start":
      blocks = [
        ...blocks,
        {
          id: nextId(),
          kind: "tool",
          call_id: ev.call_id,
          tool_name: ev.tool_name,
          status: "running",
          input: ev.input,
          ...(activeRound !== undefined ? { round: activeRound } : {}),
        },
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
          {
            id: nextId(),
            kind: "tool",
            call_id: ev.call_id,
            tool_name: ev.tool_name,
            status: ev.status,
            output: ev.output,
            ...(activeRound !== undefined ? { round: activeRound } : {}),
          },
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
      blocks = [
        ...blocks,
        {
          id: nextId(),
          kind: "artifact",
          artKind: ev.kind,
          name: ev.name,
          path: ev.path,
          ...(ev.final !== undefined ? { final: ev.final } : {}),
          ...(ev.exists !== undefined ? { exists: ev.exists } : {}),
          ...(ev.size !== undefined ? { size: ev.size } : {}),
          ...(ev.source !== undefined ? { source: ev.source } : {}),
        },
      ];
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
    case "context":
      blocks = [
        ...blocks,
        {
          id: nextId(),
          kind: "context",
          label: ev.label,
          content: ev.content,
          ...(activeRound !== undefined ? { round: activeRound } : {}),
        },
      ];
      break;
    case "finish": {
      if (ev.reason === "tool_calls") break; // intermediate step — loop continues
      finishReason = ev.reason;
      if (ev.reason === "stop") {
        // Final answer = last text block. Record its id as the turn's finalNodeId
        // pointer (the UI reads this, not DOM position).
        const res = finalizeBlocks(blocks);
        blocks = res.blocks;
        finalNodeId = res.finalNodeId;
      }
      break;
    }
    case "usage": {
      const prev = usage ?? { prompt: 0, completion: 0, total: 0 };
      // Each LLM request's usage.prompt_tokens already counts the FULL
      // conversation context (history + new user message).  Accumulating
      // across calls would double/triple-count history — the context ring
      // needs the latest value.  completion & total accumulate per-call
      // so the usage badge shows a rough "total tokens this turn" metric.
      usage = {
        prompt: ev.prompt,
        completion: prev.completion + ev.completion,
        total: prev.total + ev.total,
      };
      break;
    }
    case "done":
      break; // done flag handled in send()'s finally
  }

  return { ...turn, blocks, usage, finishReason, finalNodeId, activeRound };
}

export const useChatStore = create<ChatState>((set, get) => ({
  turns: [],
  streaming: false,
  startingNew: false,
  abortController: null,
  conversationId: null,
  title: "新会话",

  async send(
    text: string,
    attachments?: ImageAttachmentWire[],
    images?: { name: string; thumb: string }[],
    fileRefs?: { path: string; name: string }[],
    mode?: import("./config-store").WorkMode,
  ) {
    if (!text.trim()) return;
    // While a stream is active, route to the append path: the message is added
    // to the agent's memory and the SDK executor injects it into the running
    // loop (mid-run steering / queued follow-up).
    if (get().streaming) return get().appendInstruction(text);
    // Request mode defaults to the Composer's current work mode.
    const workMode: import("./config-store").WorkMode =
      mode ?? useConfigStore.getState().workMode ?? "craft";

    const controller = new AbortController();
    // Index of the first turn belonging to THIS send, so the finally block can
    // persist the whole [user, …promoted appends, assistant] slice in one shot.
    const startLen = get().turns.length;
    set((s) => ({
      turns: [
        ...s.turns,
        // Images are single-turn display only — stamped on the user bubble for
        // live thumbnail rendering, but NOT persisted (the finally block strips
        // them and writes a [已附图片：…] prefix into the stored content).
        // fileRefs (structured file attachments) ARE persisted on the turn; the
        // [引用文件] markdown block is appended to the wire text below so the
        // LLM still sees the same prompt, but turn.content stays clean so the
        // bubble can render file chips without duplicating the path list.
        {
          id: nextTurnId(),
          role: "user",
          content: text,
          ...(images ? { images } : {}),
          ...(fileRefs ? { attachments: fileRefs } : {}),
        },
        { id: nextTurnId(), role: "assistant", blocks: [], usage: null, done: false, startedAt: Date.now() },
      ],
      streaming: true,
      abortController: controller,
    }));

    let errored = false;
    // 重连对账：已消费事件数，断流时按游标从 sidecar 缓冲补拉。
    let eventCount = 0;
    try {
      const baseUrl = await getBaseUrl();
      // Append [引用文件] refs to the wire text so the LLM receives the same
      // prompt as before the structured-attachments refactor. turn.content
      // stays clean (no refs markdown); the file chips in the bubble read
      // from turn.attachments instead. Workspace-EXTERNAL refs (absolute
      // paths) are marked "已授权读取" so the model reads the exact attached
      // path instead of hunting for a same-named copy elsewhere (e.g. an
      // installed skill in site-packages).
      const refLine = (r: { path: string }) =>
        looksLikeFsPath(r.path) ? `- ${r.path}（工作区外，已授权读取）` : `- ${r.path}`;
      const refsBlock = fileRefs && fileRefs.length > 0
        ? (text.trim()
            ? `\n\n[引用文件]\n${fileRefs.map(refLine).join("\n")}`
            : `请处理以下文件：\n${fileRefs.map(refLine).join("\n")}`)
        : "";
      const wireText = text + refsBlock;
      for await (const ev of streamChat(baseUrl, [{ role: "user", content: wireText }], controller.signal, attachments, workMode)) {
        if (ev.type === "done") continue;
        eventCount += 1;
        set((s) => {
          const turns = s.turns.slice();
          const last = turns[turns.length - 1];
          if (last && last.role === "assistant") turns[turns.length - 1] = reduceEvent(last, ev);
          return { turns };
        });
      }
    } catch (e) {
      if (controller.signal.aborted) return; // finally finalizes without marking final
      // 网络断流（fetch/reader 错误）但 run 可能在 sidecar 后台继续——按游标补拉。
      const recovered = await catchUpEvents(eventCount, (ev) => {
        set((s) => {
          const turns = s.turns.slice();
          const last = turns[turns.length - 1];
          if (last && last.role === "assistant") turns[turns.length - 1] = reduceEvent(last, ev);
          return { turns };
        });
      }, controller.signal);
      if (recovered) return; // 已补拉完结 → finally 正常 finalize + 持久化
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
          // Final-answer marking is driven by the `finish(reason="stop")` event in
          // reduceEvent(); fall back to the last-text heuristic only when no such
          // signal arrived (older providers / plan-only turns with no final text).
          const finalized = finalize && !last.finalNodeId
            ? finalizeBlocks(last.blocks)
            : { blocks: last.blocks };
          turns[turns.length - 1] = {
            ...last,
            blocks: finalized.blocks,
            ...(finalized.finalNodeId ? { finalNodeId: finalized.finalNodeId } : {}),
            done: true,
            completedAt: Date.now(),
            // A client-side abort cuts the stream before the sidecar's
            // `llm_step_end(reason="aborted")` can be read — record it here so
            // the turn renders as 已停止 rather than 已中断.
            ...(aborted ? { finishReason: "aborted" } : {}),
            // A successful plan-mode turn becomes a plan proposal awaiting the
            // user's confirm/cancel before anything executes.
            ...(finalize && workMode === "plan"
              ? { plan: { awaiting: true, originalText: text } }
              : {}),
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
                // Persistence: images are single-turn only, so the user turn's
                // `images` key is dropped entirely and a [已附图片：a.png, …]
                // marker line is prepended to the stored content — a reloaded
                // transcript shows the marker instead of a vanished thumbnail.
                const persistedPair = pair.map((t) => {
                  const userImages = (t as { images?: { name: string }[] }).images;
                  if (t.role === "user" && userImages && userImages.length) {
                    const names = userImages.map((i) => i.name).join(", ");
                    return { id: t.id, role: "user", content: `[已附图片：${names}]\n${t.content}` };
                  }
                  // Assistant turns + image-less user turns: pass through as
                  // stored, but strip any stray `images` key defensively.
                  const { images: _drop, ...rest } = t as { images?: unknown };
                  return rest;
                });
                const r = await fetch(`${b}/api/conversations/${cid}/turns`, {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ turns: persistedPair }),
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
    // Permission requests cease to be actionable once this stream is stopped.
    // Remove the transient cards before send() finalizes the turn.
    set((s) => ({
      turns: s.turns.map((t) =>
        t.role === "assistant"
          ? {
              ...t,
              blocks: t.blocks.filter(
                (b) => !(b.kind === "permission" && b.approved === undefined)
              ),
            }
          : t
      ),
    }));
    // Stop reading the stream; the in-flight send()'s finally finalizes the
    // turn (aborted → not final, done). The next send() resumes from memory.
    ctl.abort();
  },

  async respondToPermission(askId: string, approved: boolean) {
    try {
      const baseUrl = await getBaseUrl();
      await respondToPermissionAsk(baseUrl, askId, approved);
      // Permission cards are transient UI. Once the sidecar accepts the
      // decision, remove the matching card from every assistant turn instead
      // of persisting it in the conversation history.
      set((s) => ({
        turns: s.turns.map((t) =>
          t.role === "assistant"
            ? {
                ...t,
                blocks: t.blocks.filter(
                  (b) => !(b.kind === "permission" && b.ask_id === askId)
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

  async confirmPlan(turnId: string) {
    const turn = get().turns.find((t) => t.id === turnId);
    if (!turn || turn.role !== "assistant" || !turn.plan?.originalText) return;
    const original = turn.plan.originalText;
    // 点击「执行」的瞬间就切回执行模式（本地立即反映 + 持久化），而不是等
    // 执行流结束——否则 Composer 一直显示计划模式，下一次发送还会再进计划。
    useConfigStore.setState({ workMode: "craft" });
    useConfigStore.getState().saveWorkMode("craft").catch(() => {});
    // Mark this proposal as confirmed so the confirm bar disappears; the
    // execution re-send below runs in craft mode against the plan in history.
    set((s) => ({
      turns: s.turns.map((t) =>
        t.id === turnId && t.role === "assistant"
          ? { ...t, plan: t.plan ? { ...t.plan, awaiting: false } : undefined }
          : t
      ),
    }));
    await get().send(`（已确认计划）请开始执行：${original}`, undefined, undefined, undefined, "craft");
  },

  cancelPlan(turnId: string) {
    set((s) => ({
      turns: s.turns.map((t) =>
        t.id === turnId && t.role === "assistant" && t.plan
          ? { ...t, plan: { ...t.plan, awaiting: false, cancelled: true } }
          : t
      ),
    }));
  },

  dismissPlan(turnId: string) {
    // 补充/讨论：解除「等待确认」状态，计划保留可见；用户继续在当前模式发送。
    set((s) => ({
      turns: s.turns.map((t) =>
        t.id === turnId && t.role === "assistant" && t.plan
          ? { ...t, plan: { ...t.plan, awaiting: false } }
          : t
      ),
    }));
  },

  reset: () => {
    get().abortController?.abort();
    set({ turns: [], streaming: false, abortController: null, title: "新会话" });
  },

  async startNew(workspace: string) {
    // 防连击：上一次新建未完成（create 是异步 POST）时忽略后续点击。
    if (get().startingNew) return;
    set({ startingNew: true });
    try {
      get().abortController?.abort();
      const currentId = get().conversationId;
      const hasContent = get().turns.length > 0;
      // 清理该工作区残留的空会话（保留当前会话），避免侧边栏堆"新会话"。
      await useConversationStore.getState().removeEmpty(workspace, currentId ?? undefined);
      let conv: Conversation | null = null;
      if (hasContent) {
        // 当前会话有内容 → 新建一个空会话。
        conv = await useConversationStore.getState().create(workspace);
      } else {
        // 当前本来就是空会话 → 不再新建，复用（只是清空本地态）。
        conv = currentId ? await useConversationStore.getState().open(currentId) : null;
      }
      set({
        turns: [],
        streaming: false,
        abortController: null,
        conversationId: conv ? conv.id : null,
        title: conv ? conv.title : "新会话",
      });
      await useConversationStore.getState().loadList(workspace);
    } finally {
      set({ startingNew: false });
    }
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
    // 恢复该会话绑定的模型（sticky）。与当前活动模型不同则 reload。
    // Wrapped so a model-restore failure never breaks conversation loading.
    try {
      const bound = await useConfigStore.getState().loadConversationModel(id);
      const current = useConfigStore.getState().resolveActiveModel(null);
      const differs =
        !!bound &&
        !!current &&
        (bound.provider !== current.provider || bound.model !== current.model);
      if (bound && differs) {
        await useConfigStore.getState().switchActive(bound.provider, bound.model, id);
      }
    } catch {
      /* 模型恢复失败不阻断会话加载 */
    }
  },
}));
