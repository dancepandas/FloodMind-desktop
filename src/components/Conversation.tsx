import { useEffect, useRef, useState } from "react";
import { useChatStore, type ToolCall } from "../state/chat-store";

function stepDot(status: string): string {
  const s = (status || "").toLowerCase();
  if (["completed", "ok", "success", "done", "finished"].includes(s)) return "up";
  if (["error", "failed"].includes(s)) return "down";
  return "checking"; // running / in_progress / pending
}

function ToolLine({ t }: { t: ToolCall }) {
  const [open, setOpen] = useState(false);
  const dot = t.status === "running" || t.status === "in_progress" ? "checking" : stepDot(t.status);
  const args = (t.input || "").replace(/\s+/g, " ").trim();
  return (
    <>
      <div
        className="tool"
        onClick={() => (t.input || t.output) && setOpen((o) => !o)}
        style={{ cursor: t.input || t.output ? "pointer" : "default" }}
      >
        <span className={`sdot tdot sdot-${dot}`} />
        <span className="tname">{t.tool_name}</span>
        {args && <span className="targs">{args.length > 64 ? args.slice(0, 64) + "…" : args}</span>}
        <span className="tstat">{t.status}</span>
      </div>
      {open && (t.input || t.output) && (
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
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, thinking, tools, artifacts, streaming]);

  if (messages.length === 0) {
    return (
      <div className="conversation">
        <div className="empty-hint">
          <div className="big">FloodMind</div>
          输入一个任务开始
          <br />
          例如：生成一份本周水情简报
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
  const showExtras =
    streaming || !!thinking || tools.length > 0 || planSteps.length > 0 || artifacts.length > 0 || !!usage || !!error;

  return (
    <div className="conversation">
      {messages.map((m, i) => {
        const isLastAssistant = i === lastAssistantIdx;
        if (m.role === "user") {
          return (
            <div className="turn" key={i}>
              <div className="role-tag user">▌ 你</div>
              <div className="msg-user">{m.content}</div>
            </div>
          );
        }
        return (
          <div className="turn" key={i}>
            <div className="role-tag assistant">● FloodMind</div>

            {isLastAssistant && showExtras && thinking && <div className="thinking">{thinking}</div>}

            {isLastAssistant && showExtras && planSteps.length > 0 && (
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

            {isLastAssistant &&
              showExtras &&
              tools.map((t, j) => <ToolLine t={t} key={t.call_id || j} />)}

            <div className={"msg-assistant" + (isLastAssistant && streaming ? " msg-cursor" : "")}>
              {m.content}
            </div>

            {isLastAssistant &&
              showExtras &&
              artifacts.map((a, j) => (
                <div className="artifact" key={j}>
                  <span>+</span>
                  <span className="aname">{a.name}</span>
                </div>
              ))}

            {isLastAssistant && showExtras && error && (
              <div className="error-line">✗ {error}</div>
            )}

            {isLastAssistant && showExtras && usage && (
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
