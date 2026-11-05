import { useMemo } from "react";
import { useChatStore } from "../state/chat-store";
import { conversationArtifacts, findLatestPlan } from "../lib/context-data";
import { runningCount, useBackgroundTaskStore } from "../state/background-task-store";
import { useUiStore } from "../state/ui-store";
import HealthBadge from "./HealthBadge";
import UsageBadge from "./UsageBadge";

import "../styles/context-panel.css";

export default function TopBar({ onToggleSidebar }: { onToggleSidebar?: () => void }) {
  const turns = useChatStore((s) => s.turns);
  const title = useChatStore((s) => s.title);
  const reset = useChatStore((s) => s.reset);
  const inspectorOpen = useUiStore((s) => s.inspectorOpen);
  const inspectorTab = useUiStore((s) => s.inspectorTab);
  const openInspector = useUiStore((s) => s.openInspector);
  const resetInspector = useUiStore((s) => s.resetInspector);
  const planOpen = inspectorOpen && inspectorTab === "plan";
  const tasks = useBackgroundTaskStore((s) => s.tasks);
  const artifactCount = useMemo(() => conversationArtifacts(turns).length, [turns]);
  const togglePlan = useUiStore((s) => s.togglePlanPanel);

  const plan = useMemo(() => findLatestPlan(turns), [turns]);

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
        aria-label="执行计划"
        aria-pressed={planOpen}
      >
        <span className={`sdot ${failed ? "sdot-down" : done === total ? "sdot-up" : "sdot-checking"}`} />
        计划 {done}/{total}
      </button>
    );
  }, [plan, planOpen, togglePlan]);

  return (
    <header className="topbar">
      {onToggleSidebar && <button type="button" className="topbar-sidebar-toggle" aria-label="展开导航" onClick={onToggleSidebar}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16" /></svg></button>}
      <div className="topbar-title" title={title}>{title}</div>
      <div className="topbar-actions">
        <button type="button" className="topbar-context-button" aria-label="查看产物" aria-pressed={inspectorOpen && inspectorTab === "artifacts"} onClick={() => openInspector("artifacts")}>产物{artifactCount > 0 && <span>{artifactCount}</span>}</button>
        {planPill}
        <button type="button" className="topbar-context-button" aria-label="查看后台任务" aria-pressed={inspectorOpen && inspectorTab === "tasks"} onClick={() => openInspector("tasks")}>后台任务{runningCount(tasks) > 0 && <span>{runningCount(tasks)}</span>}</button>
        <HealthBadge />
        <UsageBadge />
        <button className="icon-btn" onClick={() => { resetInspector(); reset(); }} title="新会话" aria-label="新会话" type="button">
          ✕
        </button>
      </div>
    </header>
  );
}
