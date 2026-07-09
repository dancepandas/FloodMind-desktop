import { useChatStore } from "../state/chat-store";

export default function PlanPanel() {
  const title = useChatStore((s) => s.planTitle);
  const steps = useChatStore((s) => s.planSteps);
  if (!title && steps.length === 0) return null;
  return (
    <section className="rail-section">
      <h3>{title || "任务计划"}</h3>
      <ol className="plan-list">
        {steps.map((s, i) => (
          <li key={s.key || i} className={`plan-step plan-step-${s.status}`}>
            <span className={`dot dot-${s.status}`} />
            <span className="plan-title">{s.title || s.key}</span>
            {s.outcome && <span className="muted"> — {s.outcome}</span>}
          </li>
        ))}
      </ol>
    </section>
  );
}
