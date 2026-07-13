import { useEffect, useMemo, useRef } from "react";
import { useChatStore, type AssistantTurn, type Block } from "../state/chat-store";
import { useUiStore } from "../state/ui-store";
import { scrollToBlock } from "../lib/scroll-to-block";

function statusDotClass(status: string): string {
  const s = (status || "").toLowerCase();
  if (["completed", "ok", "success", "done", "finished"].includes(s)) return "sdot-up";
  if (["error", "failed", "err"].includes(s)) return "sdot-down";
  return "sdot-checking";
}

export default function PlanPanel() {
  const turns = useChatStore((s) => s.turns);
  const open = useUiStore((s) => s.planPanelOpen);
  const setOpen = useUiStore((s) => s.setPlanPanelOpen);
  const autoOpened = useRef<Set<string>>(new Set());

  const currentPlan = useMemo(() => {
    for (let i = turns.length - 1; i >= 0; i--) {
      const t = turns[i];
      if (t.role !== "assistant") continue;
      const plan = t.blocks.find((b): b is Extract<Block, { kind: "plan" }> => b.kind === "plan");
      if (plan) return { plan, turn: t as AssistantTurn };
    }
    return null;
  }, [turns]);

  // Auto-open the panel when a new plan block appears.
  useEffect(() => {
    if (currentPlan && !open && !autoOpened.current.has(currentPlan.plan.id)) {
      setOpen(true);
      autoOpened.current.add(currentPlan.plan.id);
    }
  }, [currentPlan, open, setOpen]);

  if (!open) return null;

  if (!currentPlan) {
    return (
      <aside className="plan-panel">
        <div className="plan-panel-header">
          <span className="plan-panel-title">执行计划</span>
          <button
            className="plan-panel-close"
            onClick={() => setOpen(false)}
            type="button"
            aria-label="收起"
          >
            ›
          </button>
        </div>
        <div className="plan-panel-empty">当前没有执行计划</div>
      </aside>
    );
  }

  const { plan } = currentPlan;
  const done = plan.steps.filter((s) =>
    ["completed", "ok", "done", "finished"].includes((s.status || "").toLowerCase())
  ).length;
  const failed = plan.steps.filter((s) =>
    ["error", "failed", "err"].includes((s.status || "").toLowerCase())
  ).length;
  const total = plan.steps.length;
  const pct = total ? Math.round((done / total) * 100) : 0;

  return (
    <aside className="plan-panel">
      <div className="plan-panel-header">
        <span className="plan-panel-title">执行计划</span>
        <button
          className="plan-panel-close"
          onClick={() => setOpen(false)}
          type="button"
          aria-label="收起"
        >
          ›
        </button>
      </div>

      {plan.title && <div className="plan-panel-subtitle">{plan.title}</div>}

      <div className="plan-panel-progress">
        <div className="plan-progress-bar">
          <div className="plan-progress-fill" style={{ width: `${pct}%` }} />
        </div>
        <div className="plan-progress-text">
          {done}/{total} 步{failed > 0 ? ` · ${failed} 失败` : ""}
        </div>
      </div>

      <div className="plan-panel-steps">
        {plan.steps.map((s, i) => (
          <button
            key={s.key || i}
            className="plan-panel-step"
            type="button"
            onClick={() => scrollToBlock(plan.id)}
            title="定位到聊天流中的计划"
          >
            <span className={`sdot ${statusDotClass(s.status)}`} />
            <span className="plan-step-title">{s.title || s.key}</span>
            {s.outcome && <span className="plan-step-outcome">{s.outcome}</span>}
          </button>
        ))}
      </div>
    </aside>
  );
}
