import { useEffect, useRef, useState } from "react";
import { useChatStore, type Block, type PlanStep } from "../state/chat-store";
import { useConfigStore } from "../state/config-store";
import { useWorkspaceStore } from "../state/workspace-store";
import { useUiStore } from "../state/ui-store";
import { scrollToBlock } from "../lib/scroll-to-block";
import Markdown from "./Markdown";
import ArtifactCard from "./ArtifactCard";

const TRUST_ONCE_WARNING_KEY = "floodmind.trustOnceWarningSeen";

function hasSeenTrustOnceWarning(path: string | null): boolean {
  // Safety gate: when we can't read localStorage (no window / SSR / test), the
  // safe default is "NOT seen yet" → show the warning, rather than silently
  // suppressing it.
  if (typeof window === "undefined") return false;
  return localStorage.getItem(`${TRUST_ONCE_WARNING_KEY}.${path ?? "__none__"}`) === "1";
}

function markTrustOnceWarningSeen(path: string | null) {
  if (typeof window === "undefined") return;
  localStorage.setItem(`${TRUST_ONCE_WARNING_KEY}.${path ?? "__none__"}`, "1");
}

/**
 * Collapse hook: a block starts at its default collapsed state, is forced
 * expanded while it's the live streaming tail, auto-collapses when it stops
 * being the tail, and remembers any manual toggle from then on.
 */
function useCollapse(defaultCollapsed: boolean, forceExpanded: boolean) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed && !forceExpanded);
  const manual = useRef(false);
  useEffect(() => {
    if (!manual.current) setCollapsed(defaultCollapsed && !forceExpanded);
  }, [defaultCollapsed, forceExpanded]);
  const toggle = () => {
    manual.current = true;
    setCollapsed((c) => !c);
  };
  return [collapsed, toggle] as const;
}

function statusDot(status: string): string {
  const s = (status || "").toLowerCase();
  if (["completed", "ok", "success", "done", "finished"].includes(s)) return "up";
  if (["error", "failed", "err"].includes(s)) return "down";
  return "checking"; // running / pending
}

function firstLine(s: string, max = 80): string {
  const line = s.split("\n").find((l) => l.trim()) || "";
  return line.length > max ? line.slice(0, max) + "…" : line;
}

/* ── Thinking ────────────────────────────────────────────── */
function ThinkingBlock({ block, isLive }: { block: Extract<Block, { kind: "thinking" }>; isLive: boolean }) {
  const [collapsed, toggle] = useCollapse(true, isLive);
  return (
    <div className="blk blk-thinking">
      <button className="blk-chip" onClick={toggle} type="button">
        <span className="caret">{collapsed ? "▸" : "▾"}</span> 思考过程
      </button>
      {!collapsed && <div className="thinking-body">{block.content}</div>}
    </div>
  );
}

/* ── Tool ────────────────────────────────────────────────── */
function ToolBlock({ block, isLive }: { block: Extract<Block, { kind: "tool" }>; isLive: boolean }) {
  const [collapsed, toggle] = useCollapse(true, isLive);
  const args = (block.input || "").replace(/\s+/g, " ").trim();
  const hasDetail = !!(block.input || block.output);
  const dot = statusDot(block.status);
  return (
    <div className="blk blk-tool">
      <div
        className="tool-row"
        role={hasDetail ? "button" : undefined}
        tabIndex={hasDetail ? 0 : undefined}
        aria-expanded={hasDetail ? !collapsed : undefined}
        onClick={() => hasDetail && toggle()}
        onKeyDown={(e) => {
          if (hasDetail && (e.key === "Enter" || e.key === " ")) {
            e.preventDefault();
            toggle();
          }
        }}
        style={{ cursor: hasDetail ? "pointer" : "default" }}
      >
        <span className={`sdot sdot-${dot}`} />
        <span className="tname">{block.tool_name}</span>
        {args && <span className="targs">{args.length > 60 ? args.slice(0, 60) + "…" : args}</span>}
        <span className="tstat">{block.status}</span>
      </div>
      {!collapsed && hasDetail && (
        <div className="tool-detail">
          {block.input && `→ ${block.input}\n`}
          {block.output}
        </div>
      )}
    </div>
  );
}

/* ── Text (intermediate summary / final full) ────────────── */
function TextBlock({
  block,
  isLive,
}: {
  block: Extract<Block, { kind: "text" }>;
  isLive: boolean;
}) {
  // Final answer: always expanded. Intermediate: collapsed unless live.
  const [collapsed, toggle] = useCollapse(!block.final, isLive);
  if (block.final) {
    return (
      <div className="blk blk-text final">
        <Markdown>{block.content}</Markdown>
        {isLive && <span className="stream-cursor" aria-hidden="true">▌</span>}
      </div>
    );
  }
  return (
    <div className="blk blk-text">
      <button className="text-summary" onClick={toggle} type="button" title="点击展开">
        {firstLine(block.content)}
      </button>
      {!collapsed && (
        <div className="text-expanded">
          <Markdown>{block.content}</Markdown>
        </div>
      )}
    </div>
  );
}

/* ── Plan ────────────────────────────────────────────────── */
function PlanBlock({ block }: { block: Extract<Block, { kind: "plan" }> }) {
  const setOpen = useUiStore((s) => s.setPlanPanelOpen);
  const done = block.steps.filter((s) =>
    ["completed", "ok", "done", "finished"].includes((s.status || "").toLowerCase())
  ).length;
  return (
    <div className="blk blk-plan" data-block-id={block.id}>
      <button
        className="blk-chip plan-chip"
        onClick={() => {
          setOpen(true);
          scrollToBlock(block.id);
        }}
        type="button"
        title="查看执行计划"
      >
        <span className="plan-chip-icon" aria-hidden="true">☰</span>
        计划 · {block.steps.length} 步
        <span className="plan-progress">（{done}/{block.steps.length}）</span>
      </button>
    </div>
  );
}

/* ── Artifact / Permission / Error ───────────────────────── */
function ArtifactBlock({ block }: { block: Extract<Block, { kind: "artifact" }> }) {
  const setPreviewPath = useUiStore((s) => s.setPreviewPath);
  return (
    <ArtifactCard
      name={block.name}
      artKind={block.artKind}
      path={block.path}
      onOpen={() => setPreviewPath(block.path)}
    />
  );
}

function PermissionBlock({ block }: { block: Extract<Block, { kind: "permission" }> }) {
  const respond = useChatStore((s) => s.respondToPermission);
  const permissionMode = useConfigStore((s) => s.permissionMode);
  const workspacePath = useWorkspaceStore((s) => s.current?.path ?? null);
  const [resolved, setResolved] = useState(block.approved !== undefined);
  const [showInput, setShowInput] = useState(false);
  const [trustModalOpen, setTrustModalOpen] = useState(false);
  const approved = block.approved === true;

  if (block.approved === true && block.auto_approved) {
    return (
      <div className="blk blk-permission">
        <span className="perm-badge perm-auto">🔓 已自动批准 {block.tool_name}</span>
      </div>
    );
  }

  if (resolved) {
    return (
      <div className="blk blk-permission">
        <span className={`perm-badge ${approved ? "perm-approved" : "perm-rejected"}`}>
          {approved ? "🔓 已批准" : "🚫 已拒绝"} {block.tool_name}
        </span>
      </div>
    );
  }

  const hasInput = block.input != null && Object.keys(block.input).length > 0;

  function doApprove() {
    if (permissionMode === "trust-once" && !hasSeenTrustOnceWarning(workspacePath)) {
      setTrustModalOpen(true);
      return;
    }
    setResolved(true);
    respond(block.ask_id, true);
  }

  function confirmTrustApprove() {
    markTrustOnceWarningSeen(workspacePath);
    setTrustModalOpen(false);
    setResolved(true);
    respond(block.ask_id, true);
  }

  return (
    <>
      <div className="blk blk-permission permission-ask">
        <div className="permission-ask-header">
          <div className="permission-ask-title">
            <span className="sdot sdot-checking" />
            <span className="tname">{block.tool_name}</span>
            <span className="tstat">等待授权</span>
          </div>
          <div className="permission-ask-actions">
            <button
              type="button"
              className="btn-secondary permission-reject"
              onClick={() => {
                setResolved(true);
                respond(block.ask_id, false);
              }}
            >
              拒绝
            </button>
            <button
              type="button"
              className="save-btn permission-approve"
              onClick={doApprove}
            >
              批准
            </button>
          </div>
        </div>
        {block.reason && <div className="permission-ask-reason">{block.reason}</div>}
        {hasInput && (
          <button
            type="button"
            className="permission-input-toggle"
            onClick={() => setShowInput((s) => !s)}
          >
            {showInput ? "▾ 隐藏参数" : "▸ 查看参数"}
          </button>
        )}
        {hasInput && showInput && (
          <pre className="permission-ask-input">{JSON.stringify(block.input, null, 2)}</pre>
        )}
      </div>

      {trustModalOpen && (
        <div className="modal-overlay" onClick={() => setTrustModalOpen(false)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="modal-title">⚠️ 首次授权提醒</div>
            <div style={{ fontSize: "13px", lineHeight: "1.6", color: "var(--fg-secondary)" }}>
              <p>
                您当前处于<strong>「首次询问」</strong>模式。批准本次操作后，FloodMind 会记住这次授权。
              </p>
              <ul style={{ paddingLeft: "1.2rem", margin: "0.4rem 0" }}>
                <li>
                  之后<strong>完全相同的操作</strong>（相同工具 + 相同参数）将不再询问，直接执行。
                </li>
                <li>
                  如果后续出现相似的指令，系统可能会默认放行，存在误操作或被诱导执行的风险。
                </li>
              </ul>
              <p>
                <strong>请确认您理解并同意此风险。</strong>
              </p>
            </div>
            <div className="modal-actions">
              <button
                className="btn-secondary"
                type="button"
                onClick={() => setTrustModalOpen(false)}
              >
                取消
              </button>
              <button
                className="btn-primary"
                type="button"
                onClick={confirmTrustApprove}
              >
                我已了解，批准
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function ErrorBlock({ block }: { block: Extract<Block, { kind: "error" }> }) {
  return <div className="blk blk-error">✗ {block.content}</div>;
}

export default function BlockView({
  block,
  isLive,
}: {
  block: Block;
  isLive: boolean;
}) {
  switch (block.kind) {
    case "thinking":
      return <ThinkingBlock block={block} isLive={isLive} />;
    case "tool":
      return <ToolBlock block={block} isLive={isLive} />;
    case "text":
      return <TextBlock block={block} isLive={isLive} />;
    case "plan":
      return <PlanBlock block={block} />;
    case "artifact":
      return <ArtifactBlock block={block} />;
    case "permission":
      return <PermissionBlock block={block} />;
    case "error":
      return <ErrorBlock block={block} />;
  }
}
