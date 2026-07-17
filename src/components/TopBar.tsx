import { useMemo } from "react";
import { useChatStore, deriveStatusText, type Block, type Msg } from "../state/chat-store";
import { useUiStore } from "../state/ui-store";
import HealthBadge from "./HealthBadge";
import UsageBadge from "./UsageBadge";

function findLatestPlan(turns: Msg[]) {
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i];
    if (t.role !== "assistant") continue;
    const plan = t.blocks.find((b): b is Extract<Block, { kind: "plan" }> => b.kind === "plan");
    if (plan) return plan;
  }
  return null;
}

export default function TopBar() {
  const turns = useChatStore((s) => s.turns);
  const streaming = useChatStore((s) => s.streaming);
  const title = useChatStore((s) => s.title);
  const reset = useChatStore((s) => s.reset);
  const planOpen = useUiStore((s) => s.planPanelOpen);
  const togglePlan = useUiStore((s) => s.togglePlanPanel);

  const plan = useMemo(() => findLatestPlan(turns), [turns]);

  const lastAssistant = useMemo(() => {
    for (let i = turns.length - 1; i >= 0; i--) {
      const t = turns[i];
      if (t.role === "assistant") return t;
    }
    return undefined;
  }, [turns]);
  const liveBlock = lastAssistant?.blocks.at(-1);
  const statusText = streaming ? deriveStatusText(liveBlock) : "";

  const planPill = useMemo(() => {
    if (!plan) return null;
    const total = plan.steps.length;
    const done = plan.steps.filter((s) =>
      ["completed", "ok", "done", "finished"].includes((s.status || "").toLowerCase())
    ).length;
    const failed = plan.steps.some((s) =>
      ["error", "failed", "err"].includes((s.status || "").toLowerCase())
    );
    return (
      <button
        className={`topbar-plan-pill${planOpen ? " active" : ""}`}
        onClick={togglePlan}
        type="button"
        title="切换执行计划面板"
      >
        <span className={`sdot ${failed ? "sdot-down" : done === total ? "sdot-up" : "sdot-checking"}`} />
        计划 {done}/{total}
      </button>
    );
  }, [plan, planOpen, togglePlan]);

  return (
    <header className="topbar">
      <div className="topbar-title" title={title}>{title}</div>
      <div className="topbar-actions">
        {statusText && <span className="topbar-status-pill">{statusText}</span>}
        {planPill}
        <HealthBadge />
        <UsageBadge />
        <button className="icon-btn" onClick={reset} title="新会话" type="button">
          ✕
        </button>
      </div>
    </header>
  );
}
