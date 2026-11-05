import { useMemo } from "react";
import { useChatStore } from "../state/chat-store";
import { findLatestPlan } from "../lib/context-data";
import { scrollToBlock } from "../lib/scroll-to-block";

function statusDotClass(status: string): string {
  const s = (status || "").toLowerCase();
  if (["completed", "ok", "success", "done", "finished"].includes(s)) return "sdot-up";
  if (["error", "failed", "err"].includes(s)) return "sdot-down";
  return "sdot-checking";
}

export default function PlanPanel() {
  const turns = useChatStore((s) => s.turns);
  const plan = useMemo(() => findLatestPlan(turns), [turns]);

  if (!plan) {
    return <section className="plan-panel"><div className="plan-panel-empty">当前没有执行计划</div></section>;
  }

  const done = plan.steps.filter((s) =>
    ["completed", "ok", "done", "finished"].includes((s.status || "").toLowerCase())
  ).length;
  const failed = plan.steps.filter((s) =>
    ["error", "failed", "err"].includes((s.status || "").toLowerCase())
  ).length;
  const total = plan.steps.length;
  const pct = total ? Math.round((done / total) * 100) : 0;

  return (
    <section className="plan-panel" aria-label="执行计划">

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
    </section>
  );
}
