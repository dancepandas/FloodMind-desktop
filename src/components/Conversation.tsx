import { useEffect, useRef, useState } from "react";
import Logo from "./Logo";
import Markdown from "./Markdown";
import { useChatStore, type ToolCall } from "../state/chat-store";

function stepDot(status: string): string {
  const s = (status || "").toLowerCase();
  if (["completed", "ok", "success", "done", "finished"].includes(s)) return "up";
  if (["error", "failed"].includes(s)) return "down";
  return "checking";
}

function ToolLine({ t }: { t: ToolCall }) {
  const [open, setOpen] = useState(false);
  const dot = t.status === "running" || t.status === "in_progress" ? "checking" : stepDot(t.status);
  const args = (t.input || "").replace(/\s+/g, " ").trim();
  const hasDetail = !!(t.input || t.output);

  function toggle() {
    if (hasDetail) setOpen((o) => !o);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      toggle();
    }
  }

  return (
    <>
      <div
        className="tool"
        onClick={toggle}
        onKeyDown={onKeyDown}
        role={hasDetail ? "button" : undefined}
        tabIndex={hasDetail ? 0 : undefined}
        aria-expanded={hasDetail ? open : undefined}
        style={{ cursor: hasDetail ? "pointer" : "default" }}
      >
        <span className={`sdot tdot sdot-${dot}`} />
        <span className="tname">{t.tool_name}</span>
        {args && <span className="targs">{args.length > 64 ? args.slice(0, 64) + "…" : args}</span>}
        <span className="tstat">{t.status}</span>
      </div>
      {open && hasDetail && (
        <div className="tool-detail">
          {t.input && `→ ${t.input}\n`}
          {t.output}
        </div>
      )}
    </>
  );
}

export default function Conversation() {
  const messages = useChatStore((s) => s.messages);
  const streaming = useChatStore((s) => s.streaming);
  const thinking = useChatStore((s) => s.thinking);
  const tools = useChatStore((s) => s.tools);
  const planTitle = useChatStore((s) => s.planTitle);
  const planSteps = useChatStore((s) => s.planSteps);
  const artifacts = useChatStore((s) => s.artifacts);
  const usage = useChatStore((s) => s.usage);
  const error = useChatStore((s) => s.error);
  const permission = useChatStore((s) => s.permission);
  const dismissPermission = useChatStore((s) => s.dismissPermission);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, thinking, tools, artifacts, streaming]);

  if (messages.length === 0) {
    return (
      <div className="conversation">
        <div className="empty-hint">
          <Logo className="empty-logo" />
          <div className="big">开始工作</div>
          <div className="sub">给 FloodMind 一个任务，它会直接读写工作区文件</div>
        </div>
      </div>
    );
  }

  let lastAssistantIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "assistant") {
      lastAssistantIdx = i;
      break;
    }
  }

  return (
    <div className="conversation">
      {messages.map((m, i) => {
        const isLastAssistant = i === lastAssistantIdx;

        if (m.role === "user") {
          return (
            <div className="turn user-turn" key={i}>
              <div className="msg-user">{m.content}</div>
            </div>
          );
        }

        return (
          <div className="turn assistant-turn" key={i}>
            <div className="assistant-header">
              <span className="assistant-avatar" aria-hidden="true">F</span>
              <span className="assistant-name">FloodMind</span>
            </div>

            {isLastAssistant && thinking && (
              <div className="thinking">{thinking}</div>
            )}

            {isLastAssistant && planSteps.length > 0 && (
              <div className="plan">
                {planTitle && <div className="plan-title">{planTitle}</div>}
                {planSteps.map((s, j) => (
                  <div className="plan-step" key={s.key || j}>
                    <span className={`sdot sdot-${stepDot(s.status)}`} />
                    <span>{s.title || s.key}</span>
                    {s.outcome && <span className="label"> — {s.outcome}</span>}
                  </div>
                ))}
              </div>
            )}

            {isLastAssistant && tools.map((t, j) => (
              <ToolLine t={t} key={t.call_id || j} />
            ))}

            <div className="msg-assistant">
              <Markdown>{m.content}</Markdown>
              {isLastAssistant && streaming && <span className="stream-cursor" aria-hidden="true">▌</span>}
            </div>

            {isLastAssistant && artifacts.map((a, j) => (
              <div className="artifact" key={j}>
                <span>+</span>
                <span className="aname">{a.name}</span>
              </div>
            ))}

            {isLastAssistant && permission && (
              <div className="permission-line">
                <span>🔒 {permission.tool_name}：{permission.reason}（已自动同意）</span>
                <button
                  className="permission-dismiss"
                  onClick={dismissPermission}
                  aria-label="关闭"
                  type="button"
                >
                  ✕
                </button>
              </div>
            )}

            {isLastAssistant && error && (
              <div className="error-line">✗ {error}</div>
            )}

            {isLastAssistant && usage && (
              <div className="usage-line">
                ↑ {usage.prompt} ↓ {usage.completion} · {usage.total} tok
              </div>
            )}
          </div>
        );
      })}
      <div ref={endRef} />
    </div>
  );
}
