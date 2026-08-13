import { useEffect, useRef, useState } from "react";
import Logo from "./Logo";
import BlockView from "./BlockView";
import ArtifactGroup from "./ArtifactGroup";
import WelcomeView from "./WelcomeView";
import { useChatStore, deriveStatusText, type ArtifactBlock, type Block, type Msg } from "../state/chat-store";
import { useUiStore } from "../state/ui-store";
import { openFileInSystem } from "../lib/open-file";
import { formatTokens } from "../lib/format-tokens";

/** 工具参数的定长截断展示（展开状态行时用）。 */
function truncateParam(input: string | object | undefined | null): string {
  const s = typeof input === "string" ? input : JSON.stringify(input ?? "");
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > 120 ? t.slice(0, 120) + "…" : t;
}

export default function Conversation() {
  const turns = useChatStore((s) => s.turns);
  const streaming = useChatStore((s) => s.streaming);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Instant scroll during streaming (smooth on every token delta jitters long
    // turns); smooth only when a turn starts/finishes.
    endRef.current?.scrollIntoView({ behavior: streaming ? "auto" : "smooth" });
  }, [turns, streaming]);

  if (turns.length === 0) {
    return (
      <div className="conversation">
        <WelcomeView />
      </div>
    );
  }

  return (
    <div className="conversation">
      <ResumeBanner />
      {turns.map((m, i) => (
        <TurnView key={m.id} turn={m} isLast={i === turns.length - 1} streaming={streaming} />
      ))}
      <div ref={endRef} />
    </div>
  );
}

/** 断点续跑：会话存在未完成的中断任务时给出「恢复执行」入口。 */
function ResumeBanner() {
  const checkpoint = useChatStore((s) => s.resumableCheckpoint);
  const resume = useChatStore((s) => s.resume);
  const streaming = useChatStore((s) => s.streaming);
  if (!checkpoint || streaming) return null;
  return (
    <div className="resume-banner">
      <span className="resume-banner-text">
        检测到未完成的任务（第 {checkpoint.iteration} 步时中断），可从中断处继续。
      </span>
      <button
        type="button"
        className="resume-banner-btn"
        onClick={() => resume(checkpoint.checkpoint_id)}
      >
        恢复执行
      </button>
    </div>
  );
}

function TurnView({ turn, isLast, streaming }: { turn: Msg; isLast: boolean; streaming: boolean }) {
  // All hooks must run unconditionally on every render (rules of hooks), so the
  // user-turn early return below happens AFTER this useState. The state is only
  // read on the assistant branch.
  // 执行中点击状态行展开的项（thinking/tool）；新项到来时展示的始终是最新项。
  const [expandedKind, setExpandedKind] = useState<"thinking" | "tool" | null>(null);
  // 完成态「已用过程」折叠追踪（默认收起，对齐主流可复盘）。
  const [showProcess, setShowProcess] = useState(false);
  const openLightbox = useUiStore((s) => s.openLightbox);
  const setPreviewPath = useUiStore((s) => s.setPreviewPath);

  if (turn.role === "user") {
    const imgs = turn.images;
    const files = turn.attachments;
    const hasAttach = (imgs && imgs.length > 0) || (files && files.length > 0);
    return (
      <div className="turn user-turn">
        <div className="msg-user">{turn.content}</div>
        {hasAttach && (
          <div className="user-attach">
            {files &&
              files.map((f, idx) => (
                <button
                  key={`f-${idx}`}
                  type="button"
                  className="user-file-chip"
                  title={f.path}
                  onClick={() => setPreviewPath(f.path)}
                >
                  <span className="user-file-icon" aria-hidden="true">📄</span>
                  <span className="user-file-name">{f.name}</span>
                </button>
              ))}
            {imgs &&
              imgs.map((im, idx) => (
                <img
                  key={idx}
                  className="user-image-thumb"
                  src={im.thumb}
                  alt={im.name}
                  title={im.name}
                  onClick={() => openLightbox({ src: im.thumb, name: im.name })}
                />
              ))}
          </div>
        )}
      </div>
    );
  }

  // ── after the turn completes, only the final answer + artifacts remain ──
  const finalBlock = turn.done ? turn.blocks.find((b) => b.kind === "text" && b.final) : null;
  // 中断/失败 turn（done 但未 markFinal）：兜底展示最后一个 text 块的半截内容，不凭空消失。
  const abortedPartial =
    turn.done && !finalBlock ? [...turn.blocks].reverse().find((b) => b.kind === "text") ?? null : null;
  const finalArtifacts = turn.done
    ? turn.blocks.filter(
        (b): b is ArtifactBlock => b.kind === "artifact" && b.final !== false
      )
    : [];
  const errors = turn.blocks.filter((b) => b.kind === "error");
  const pendingPerms = turn.blocks.filter(
    (b) => b.kind === "permission" && b.approved === undefined
  );
  // 主答案（final 或中断兜底）不重复进复盘区。
  const mainTexts = [finalBlock, abortedPartial].filter((b): b is Block => b != null);
  const mainTextIds = new Set(mainTexts.map((b) => b.id));
  // 已用过程：思考/工具/权限 + 中间 text 块（完成态默认折叠的可复盘追踪）。
  const doneProcessBlocks = turn.blocks.filter(
    (b) =>
      (b.kind === "thinking" ||
        b.kind === "tool" ||
        b.kind === "permission" ||
        (b.kind === "text" && !b.final)) &&
      !mainTextIds.has(b.id)
  );

  // 完成态：默认不渲染过程；只留最终答案 + 产物 + 必须感知的信息，外加一个
  // 默认折叠的「已用过程」入口（对齐主流可复盘，而非彻底消失）。
  if (turn.done) {
    return (
      <div className="turn assistant-turn">
        <div className="assistant-header">
          <span className="assistant-avatar" aria-hidden="true">
            <Logo className="assistant-avatar-icon" />
          </span>
          <span className="assistant-name">FloodMind</span>
        </div>
        {finalBlock && (
          <div data-block-id={finalBlock.id}>
            <BlockView block={finalBlock} isLive={false} />
          </div>
        )}
        {abortedPartial && (
          <>
            <div className="blk blk-error">已停止</div>
            <div data-block-id={abortedPartial.id}>
              <BlockView block={abortedPartial} isLive={false} />
            </div>
          </>
        )}
        <ArtifactGroup
          artifacts={finalArtifacts}
          onOpen={setPreviewPath}
          onOpenFolder={(directory) => void openFileInSystem(directory)}
        />
        {errors.map((b) => <BlockView key={b.id} block={b} isLive={false} />)}
        {pendingPerms.map((b) => <BlockView key={b.id} block={b} isLive={false} />)}
        {/* 已用过程：默认折叠的可复盘追踪（对齐主流，不消失） */}
        {doneProcessBlocks.length > 0 && (
          <>
            <button
              className="show-process"
              onClick={() => setShowProcess((v) => !v)}
              type="button"
              aria-expanded={showProcess}
            >
              {showProcess ? "收起已用过程" : "已用过程"}
            </button>
            {showProcess &&
              doneProcessBlocks.map((b) => {
                // 复盘视图：工具直接显示「名 + 状态 + 定长参数」；思考/权限/中间 text 走 BlockView。
                if (b.kind === "tool") {
                  return (
                    <div key={b.id} className="blk blk-tool trace-tool">
                      <div className="tool-row">
                        <span className="tname">{b.tool_name}</span>
                        <span className="tstat">{b.status}</span>
                      </div>
                      {b.input && <div className="tool-detail">→ {truncateParam(b.input)}</div>}
                      {b.output && (
                        <div className="tool-detail">{String(b.output).slice(0, 200)}</div>
                      )}
                    </div>
                  );
                }
                return (
                  <div key={b.id} data-block-id={b.id}>
                    <BlockView block={b} isLive={false} />
                  </div>
                );
              })}
          </>
        )}
        {turn.usage && <UsageLine usage={turn.usage} />}
        <PlanConfirmBar turn={turn} />
      </div>
    );
  }

  // 执行中：一条随当前步骤变化的动态指示（主流），默认无过程详情；点击展开当前项。
  const lastBlock = turn.blocks[turn.blocks.length - 1];
  const statusText = deriveStatusText(lastBlock);
  // 只有「正在思考 / 正在调用工具」才有可点击展开的内容；过渡态（tool 已完成）不可展开。
  const runningTool =
    lastBlock?.kind === "tool" &&
    ["running", "pending", "awaiting_permission"].includes(lastBlock.status);
  const statusBlock =
    lastBlock?.kind === "thinking" || runningTool ? lastBlock : null;
  // 只流式展示【最后一个】text 块；更早的中间回答不占对话流（收进完成态复盘）。
  const lastTextBlock = [...turn.blocks].reverse().find((b) => b.kind === "text") ?? null;
  const stopped = !streaming && turn.blocks.length > 0;

  return (
    <div className="turn assistant-turn">
      <div className="assistant-header">
        <span className="assistant-avatar" aria-hidden="true">
          <Logo className="assistant-avatar-icon" />
        </span>
        <span className="assistant-name">FloodMind</span>
      </div>
      {stopped ? (
        <div className="blk blk-error">已停止</div>
      ) : (
        <>
          {/* 当前步骤动态指示（正在思考 → 正在调用工具 → 正在生成回答），随步骤变化 */}
          {statusText && (
            <span
              className="live-status-item"
              role={statusBlock ? "button" : undefined}
              tabIndex={statusBlock ? 0 : undefined}
              onClick={() => {
                if (!statusBlock) return;
                const k = statusBlock.kind === "thinking" ? "thinking" : "tool";
                setExpandedKind(expandedKind === k ? null : k);
              }}
              onKeyDown={(e) => {
                if (statusBlock && (e.key === "Enter" || e.key === " ")) {
                  e.preventDefault();
                  const k = statusBlock.kind === "thinking" ? "thinking" : "tool";
                  setExpandedKind(expandedKind === k ? null : k);
                }
              }}
            >
              <span className="live-label">
                {statusText}
                <span className="live-dots"><span className="live-dot" /><span className="live-dot" /><span className="live-dot" /></span>
              </span>
            </span>
          )}
          {expandedKind === "thinking" && statusBlock?.kind === "thinking" && (
            <div className="thinking-body">{statusBlock.content}</div>
          )}
          {expandedKind === "tool" && statusBlock?.kind === "tool" && (
            <div className="tool-detail live-tool-detail">
              <strong>{statusBlock.tool_name}</strong>
              {statusBlock.input ? `：${truncateParam(statusBlock.input)}` : ""}
            </div>
          )}
          {/* 流式回答输出（只流式展示最后一个 text 块，isLive 展开显示） */}
          {lastTextBlock && (
            <div data-block-id={lastTextBlock.id}>
              <BlockView block={lastTextBlock} isLive={true} />
            </div>
          )}
        </>
      )}
      {errors.map((b) => <BlockView key={b.id} block={b} isLive={false} />)}
      {turn.usage && <UsageLine usage={turn.usage} />}
    </div>
  );
}

function UsageLine({ usage }: { usage: { prompt: number; completion: number; total: number } }) {
  return (
    <div className="usage-line" aria-label="token 统计">
      <span className="usage-pill">{formatTokens(usage.total)}</span>
    </div>
  );
}

/** Confirm/cancel bar for a plan-mode proposal (shown once the plan is done). */
function PlanConfirmBar({ turn }: { turn: Extract<Msg, { role: "assistant" }> }) {
  const confirmPlan = useChatStore((s) => s.confirmPlan);
  const dismissPlan = useChatStore((s) => s.dismissPlan);
  const showToast = useUiStore((s) => s.showToast);
  const [confirming, setConfirming] = useState(false);
  if (!turn.plan?.awaiting || turn.plan.cancelled) return null;
  return (
    <div className="plan-confirm">
      <span className="plan-confirm-label">已生成计划，请选择：</span>
      <button
        type="button"
        className="plan-confirm-btn ok"
        disabled={confirming}
        onClick={async () => {
          setConfirming(true);
          try {
            await confirmPlan(turn.id);
          } finally {
            setConfirming(false);
          }
        }}
      >
        {confirming ? "执行中…" : "执行"}
      </button>
      <button
        type="button"
        className="plan-confirm-btn"
        onClick={() => {
          dismissPlan(turn.id);
          showToast("已取消执行，请补充想法后重新发送（将基于原任务重新规划）");
        }}
      >
        补充
      </button>
      <button
        type="button"
        className="plan-confirm-btn"
        onClick={() => {
          dismissPlan(turn.id);
          showToast("已取消执行，可继续与模型讨论该计划");
        }}
      >
        讨论
      </button>
    </div>
  );
}
