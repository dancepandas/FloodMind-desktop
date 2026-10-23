import { useEffect, useId, useRef, useState } from "react";
import Logo from "./Logo";
import BlockView from "./BlockView";
import ArtifactGroup from "./ArtifactGroup";
import WelcomeView from "./WelcomeView";
import { useChatStore, type ArtifactBlock, type Block, type Msg } from "../state/chat-store";
import { useUiStore } from "../state/ui-store";
import { useConfigStore, type TurnMetrics } from "../state/config-store";
import { useTurnCollapseStore } from "../state/turn-collapse-store";
import { turnStatus, turnStatusLabel, finalNode } from "../lib/turn-status";
import { openFileInSystem } from "../lib/open-file";
import { formatTokens } from "../lib/format-tokens";
import { useChatScroll } from "../lib/use-chat-scroll";

/** 毫秒 → 人类可读耗时。 */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem ? `${m}m${rem}s` : `${m}m`;
}

/**
 * 键盘焦点 / 文本选择是否落在容器内。用于「结束答复仍在交互时不自动折叠」。
 */
function useFocusWithin(ref: React.RefObject<HTMLElement | null>): boolean {
  const [within, setWithin] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const check = () => {
      try {
        const active = document.activeElement;
        const inActive = active instanceof Node && el.contains(active);
        const sel = window.getSelection();
        const inSel =
          !!sel && !sel.isCollapsed && sel.rangeCount > 0 &&
          el.contains(sel.getRangeAt(0).startContainer);
        setWithin(inActive || inSel);
      } catch {
        /* selection APIs can throw in exotic states — ignore */
      }
    };
    check();
    el.addEventListener("focusin", check);
    el.addEventListener("focusout", check);
    document.addEventListener("selectionchange", check);
    return () => {
      el.removeEventListener("focusin", check);
      el.removeEventListener("focusout", check);
      document.removeEventListener("selectionchange", check);
    };
  }, [ref]);
  return within;
}

export default function Conversation() {
  const turns = useChatStore((s) => s.turns);
  const streaming = useChatStore((s) => s.streaming);
  const conversationId = useChatStore((s) => s.conversationId);
  const { scrollRef, contentRef, showJumpToLatest, jumpToLatest } = useChatScroll(
    conversationId, turns, turns.length > 0,
  );

  if (turns.length === 0) {
    return (
      <div className="conversation-empty">
        <WelcomeView />
      </div>
    );
  }

  return (
    <div className="conversation-shell">
      <div className="conversation" ref={scrollRef}>
        <div className="conversation-content" ref={contentRef}>
          {turns.map((m, i) => (
            <TurnView key={m.id} turn={m} index={i} isLast={i === turns.length - 1} streaming={streaming} />
          ))}
        </div>
      </div>
      {showJumpToLatest && (
        <button type="button" className="conversation-jump" aria-label="跳转到最新消息" onClick={jumpToLatest}>
          <span aria-hidden="true">↓</span> 最新消息
        </button>
      )}
    </div>
  );
}

function TurnView({ turn, index, isLast: _isLast, streaming }: { turn: Msg; index: number; isLast: boolean; streaming: boolean }) {
  // All hooks must run unconditionally on every render (rules of hooks), so the
  // user-turn early return below happens AFTER these.
  const openLightbox = useUiStore((s) => s.openLightbox);
  const setPreviewPath = useUiStore((s) => s.setPreviewPath);
  const metrics = useConfigStore((s) => s.turnMetrics);
  const conversationId = useChatStore((s) => s.conversationId);
  const turnRef = useRef<HTMLDivElement>(null);
  const focusWithin = useFocusWithin(turnRef);
  // Collapse override keyed by (conversation, turn position) — survives switching
  // conversations within the session without relying on the regenerated turn id.
  const collapseKey = `${conversationId ?? ""}:${index}`;
  const override = useTurnCollapseStore((s) => s.overrides[collapseKey]);
  const setOverride = useTurnCollapseStore((s) => s.setOverride);

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

  const status = turnStatus(turn);
  const statusLabel = turnStatusLabel(turn);
  // Final answer = the turn's finalNode pointer; fall back to the last text block
  // for stopped/failed turns that carry a partial answer.
  const fn = finalNode(turn);
  const finalBlock = fn ?? [...turn.blocks].reverse().find((b) => b.kind === "text") ?? null;
  const mainTextId = finalBlock?.id;
  const finalArtifacts = turn.blocks.filter(
    (b): b is ArtifactBlock => b.kind === "artifact" && b.final !== false
  );
  const errors = turn.blocks.filter((b) => b.kind === "error");
  const pendingPerms = turn.blocks.filter(
    (b) => b.kind === "permission" && b.approved === undefined
  );
  // Foldable process activity: thinking / tool / context / intermediate text.
  const processBlocks = turn.blocks.filter(
    (b) =>
      b.kind === "thinking" ||
      b.kind === "tool" ||
      b.kind === "context" ||
      (b.kind === "text" && b.id !== mainTextId)
  );

  const toolCount = turn.blocks.filter((b) => b.kind === "tool").length;
  const hasElapsed = turn.startedAt != null && turn.completedAt != null;
  const elapsedMs = hasElapsed ? (turn.completedAt as number) - (turn.startedAt as number) : null;

  // ── done: summary bar + collapsible process + final answer ──
  if (turn.done) {
    const finalIdx = fn ? turn.blocks.indexOf(fn) : -1;
    const trailingAfterFinal = fn
      ? processBlocks.some((b) => turn.blocks.indexOf(b) > finalIdx)
      : false;
    const keepExpanded =
      status === "failed" ||
      status === "max_tokens" ||
      trailingAfterFinal ||
      focusWithin;
    const collapsed = override !== undefined ? override : !keepExpanded;
    const onToggle = () => setOverride(collapseKey, !collapsed);

    return (
      <div className="turn assistant-turn" ref={turnRef}>
        <div className="assistant-header">
          <span className="assistant-avatar" aria-hidden="true">
            <Logo className="assistant-avatar-icon" />
          </span>
          <span className="assistant-name">FloodMind</span>
        </div>
        {processBlocks.length > 0 && (
          <TurnSummaryBar
            collapsed={collapsed}
            onToggle={onToggle}
            statusLabel={statusLabel}
            metrics={metrics}
            toolCount={toolCount}
            elapsedMs={elapsedMs}
            usage={turn.usage}
            processBlocks={processBlocks}
          />
        )}
        {processBlocks.length === 0 && statusLabel && (
          <div className="turn-status-label">{statusLabel}</div>
        )}
        {finalBlock && (
          <div data-block-id={finalBlock.id}>
            <BlockView block={finalBlock} isLive={false} />
          </div>
        )}
        <ArtifactGroup
          artifacts={finalArtifacts}
          onOpen={setPreviewPath}
          onOpenFolder={(directory) => void openFileInSystem(directory)}
        />
        {errors.map((b) => <BlockView key={b.id} block={b} isLive={false} />)}
        {processBlocks.length === 0 && turn.usage && <UsageLine usage={turn.usage} />}
        <PlanConfirmBar turn={turn} />
      </div>
    );
  }

  // 执行中：已结束的内部 LLM 回合直接进入顶部摘要折叠栏；当前回合
  // 最多显示一条思考、一条最新工具调用和当前说明正文。
  if (!streaming) {
    return (
      <div className="turn assistant-turn" ref={turnRef}>
        <div className="assistant-header">
          <span className="assistant-avatar" aria-hidden="true">
            <Logo className="assistant-avatar-icon" />
          </span>
          <span className="assistant-name">FloodMind</span>
        </div>
        <div className="turn-status-label">已中断</div>
        <ProcessSequence blocks={processBlocks} />
        {pendingPerms.map((b) => <BlockView key={b.id} block={b} isLive={false} />)}
        {errors.map((b) => <BlockView key={b.id} block={b} isLive={false} />)}
      </div>
    );
  }

  const liveElapsedMs = turn.startedAt != null ? Math.max(0, Date.now() - turn.startedAt) : null;
  const liveBlocks = turn.blocks.filter(
    (b) =>
      b.kind === "thinking" ||
      b.kind === "tool" ||
      b.kind === "context" ||
      b.kind === "text"
  );
  const hasRoundMetadata = turn.activeRound !== undefined;
  const historicalBlocks = hasRoundMetadata
    ? liveBlocks.filter((block) => block.round !== turn.activeRound)
    : [];
  const currentBlocks = hasRoundMetadata
    ? liveBlocks.filter((block) => block.round === turn.activeRound)
    : liveBlocks;
  const currentThinking = [...currentBlocks].reverse().find(
    (block): block is Extract<Block, { kind: "thinking" }> => block.kind === "thinking",
  );
  const currentTool = [...currentBlocks].reverse().find(
    (block): block is Extract<Block, { kind: "tool" }> => block.kind === "tool",
  );
  const currentText = currentBlocks.filter(
    (block): block is Extract<Block, { kind: "text" }> => block.kind === "text",
  );
  const hasCurrentActivity = currentThinking || currentTool || currentText.length > 0;
  const liveCollapsed = override !== undefined ? override : true;
  const toggleLiveFold = () => setOverride(collapseKey, !liveCollapsed);

  return (
    <div className="turn assistant-turn" ref={turnRef}>
      <div className="assistant-header">
        <span className="assistant-avatar" aria-hidden="true">
          <Logo className="assistant-avatar-icon" />
        </span>
        <span className="assistant-name">FloodMind</span>
      </div>
      <TurnSummaryBar
        live
        collapsed={liveCollapsed}
        onToggle={toggleLiveFold}
        metrics={metrics}
        toolCount={toolCount}
        elapsedMs={liveElapsedMs}
        usage={turn.usage}
        processBlocks={historicalBlocks}
      />
      <div className="turn-current-round">
        {currentThinking ? (
          <BlockView block={currentThinking} isLive />
        ) : !hasCurrentActivity ? (
          <ThinkingStatusRow />
        ) : null}
        {currentTool && <BlockView block={currentTool} isLive={currentTool.status === "running"} />}
        {currentText.map((block) => (
          <div key={block.id} data-block-id={block.id}>
            <BlockView block={block} isLive />
          </div>
        ))}
      </div>
      {pendingPerms.map((b) => <BlockView key={b.id} block={b} isLive={false} />)}
      {errors.map((b) => <BlockView key={b.id} block={b} isLive={false} />)}
    </div>
  );
}

/** Historical process blocks keep their native renderers inside the top fold. */
function ProcessSequence({ blocks }: { blocks: Block[] }) {
  return (
    <>
      {blocks.map((block) => (
        <div key={block.id} data-block-id={block.id}>
          <BlockView block={block} isLive={false} />
        </div>
      ))}
    </>
  );
}

function ThinkingStatusRow() {
  return (
    <div className="blk blk-thinking" role="status" aria-label="正在思考">
      <div className="blk-chip live-placeholder">
        <span className="caret" aria-hidden="true">▸</span>
        <span className="live-label">正在思考<span className="live-dots" /></span>
      </div>
    </div>
  );
}

function TurnSummaryBar({
  collapsed,
  onToggle,
  statusLabel,
  live = false,
  metrics,
  toolCount,
  elapsedMs,
  usage,
  processBlocks,
}: {
  collapsed?: boolean;
  onToggle?: () => void;
  statusLabel?: string;
  live?: boolean;
  metrics: TurnMetrics;
  toolCount: number;
  elapsedMs: number | null;
  usage: { prompt: number; completion: number; total: number } | null;
  processBlocks: Block[];
}) {
  const panelId = useId();
  const parts: string[] = [];
  if (metrics.showDuration && elapsedMs != null) {
    parts.push(`${live || statusLabel ? "已工作" : "耗时"} ${formatDuration(elapsedMs)}`);
  }
  if (metrics.showToolCount && toolCount > 0) parts.push(`${toolCount} 次工具调用`);
  if (metrics.showTokens && usage) {
    parts.push(`${formatTokens(usage.prompt)} 输入 tokens`);
    parts.push(`${formatTokens(usage.completion)} 输出 tokens`);
  }
  if (parts.length === 0) parts.push("执行过程");
  if (statusLabel) parts.push(`- ${statusLabel}`);
  const summary = parts.join(" | ");

  const label = (
    <span className="turn-fold-label" aria-hidden="true">
      {parts.map((part, i) => (
        <span key={`${part}:${i}`} className="turn-fold-metric">
          {i > 0 && <span className="turn-fold-separator" />}
          <span>{part}</span>
        </span>
      ))}
      {(live ? processBlocks.length > 0 : true) && (
        <span className="turn-fold-chevron" aria-hidden="true">⌄</span>
      )}
    </span>
  );

  if (live && processBlocks.length === 0) {
    return (
      <div className="turn-fold is-live" role="status" aria-label={summary}>
        <div className="turn-fold-header">{label}</div>
        <div className="turn-fold-rule" aria-hidden="true" />
      </div>
    );
  }

  const isCollapsed = collapsed ?? true;
  const action = isCollapsed ? "展开" : "收起";
  return (
    <div className={`turn-fold${live ? " is-live" : ""}${isCollapsed ? "" : " is-open"}`}>
      <button
        type="button"
        className="turn-fold-header"
        onClick={onToggle}
        aria-expanded={!isCollapsed}
        aria-controls={panelId}
        aria-label={`${action}执行过程：${summary}`}
        title={`${action}执行过程：${summary}`}
      >
        {label}
      </button>
      <div className="turn-fold-rule" aria-hidden="true" />
      <div
        id={panelId}
        className={`turn-fold-clip${isCollapsed ? "" : " is-open"}`}
        aria-hidden={isCollapsed}
        inert={isCollapsed ? true : undefined}
      >
        <div className="turn-fold-body-wrap">
          <div className="turn-fold-body">
            {!isCollapsed && <ProcessSequence blocks={processBlocks} />}
          </div>
        </div>
      </div>
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
