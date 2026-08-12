import { useEffect, useRef, useState } from "react";
import Logo from "./Logo";
import BlockView from "./BlockView";
import ArtifactGroup from "./ArtifactGroup";
import WelcomeView from "./WelcomeView";
import { useChatStore, type ArtifactBlock, type Block, type Msg } from "../state/chat-store";
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
      {turns.map((m, i) => (
        <TurnView key={m.id} turn={m} isLast={i === turns.length - 1} streaming={streaming} />
      ))}
      <div ref={endRef} />
    </div>
  );
}

function TurnView({ turn, isLast, streaming }: { turn: Msg; isLast: boolean; streaming: boolean }) {
  // All hooks must run unconditionally on every render (rules of hooks), so the
  // user-turn early return below happens AFTER this useState. The state is only
  // read on the assistant branch.
  // 执行中点击状态行展开的项（thinking/tool）；新项到来时展示的始终是最新项。
  const [expandedKind, setExpandedKind] = useState<"thinking" | "tool" | null>(null);
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
  const finalArtifacts = turn.done
    ? turn.blocks.filter(
        (b): b is ArtifactBlock => b.kind === "artifact" && b.final !== false
      )
    : [];
  const errors = turn.blocks.filter((b) => b.kind === "error");
  const pendingPerms = turn.blocks.filter(
    (b) => b.kind === "permission" && b.approved === undefined
  );

  // 完成态：执行状态与详情彻底消失——不渲染思维链/工具/数量/历史入口，只留
  // 最终答案 + 产物 + 必须感知的信息（错误/未决权限/已停止）。
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
        <ArtifactGroup
          artifacts={finalArtifacts}
          onOpen={setPreviewPath}
          onOpenFolder={(directory) => void openFileInSystem(directory)}
        />
        {errors.map((b) => <BlockView key={b.id} block={b} isLive={false} />)}
        {pendingPerms.map((b) => <BlockView key={b.id} block={b} isLive={false} />)}
        {turn.usage && <UsageLine usage={turn.usage} />}
        <PlanConfirmBar turn={turn} />
      </div>
    );
  }

  // 执行中：最多两条动态状态行（思考中/调用工具），默认无过程详情；点击某行
  // 展开当前最新一项（工具行 = 工具名 + 定长参数），新项到来自动替换。
  const processBlocks = turn.blocks.filter(
    (b) => b.kind === "thinking" || b.kind === "tool" || b.kind === "permission"
  );
  const lastThinking = processBlocks.filter((b) => b.kind === "thinking").pop();
  const lastTool = processBlocks.filter((b) => b.kind === "tool").pop();
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
          {lastThinking && (
            <button
              className="blk-chip live-status"
              onClick={() => setExpandedKind(expandedKind === "thinking" ? null : "thinking")}
              type="button"
              aria-expanded={expandedKind === "thinking"}
            >
              <span className="caret">{expandedKind === "thinking" ? "▾" : "▸"}</span>
              <span className="live-label">思考中<span className="live-dots" /></span>
            </button>
          )}
          {lastTool && (
            <button
              className="blk-chip live-status"
              onClick={() => setExpandedKind(expandedKind === "tool" ? null : "tool")}
              type="button"
              aria-expanded={expandedKind === "tool"}
            >
              <span className="caret">{expandedKind === "tool" ? "▾" : "▸"}</span>
              <span className="live-label">调用工具<span className="live-dots" /></span>
            </button>
          )}
          {expandedKind === "thinking" && lastThinking && (
            <div className="thinking-body">{lastThinking.content}</div>
          )}
          {expandedKind === "tool" && lastTool && (
            <div className="tool-detail live-tool-detail">
              <strong>{lastTool.tool_name}</strong>
              {lastTool.input ? `：${truncateParam(lastTool.input)}` : ""}
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
