import { useEffect, useMemo, useState } from "react";
import { useScheduledTaskStore, type SchedTask } from "../state/scheduled-task-store";
import { useUiStore } from "../state/ui-store";
import { useWorkspaceStore } from "../state/workspace-store";
import { reduceEvent, type AssistantTurn, type Block } from "../state/chat-store";
import BlockView from "./BlockView";
import TaskEditModal from "./TaskEditModal";

function emptyTurn(): AssistantTurn {
  return { role: "assistant", blocks: [], usage: null, done: false };
}

/** Replay a run's stored events through reduceEvent → blocks (reuses chat rendering). */
function replay(events: unknown[]): Block[] {
  let turn = emptyTurn();
  for (const ev of events as any[]) turn = reduceEvent(turn, ev) as AssistantTurn;
  return turn.blocks;
}

export default function ScheduledTasksView() {
  const selectedTaskId = useUiStore((s) => s.selectedTaskId);
  const setView = useUiStore((s) => s.setView);
  const currentPath = useWorkspaceStore((s) => s.current?.path);
  const tasks = useScheduledTaskStore((s) => s.tasks);
  const runs = useScheduledTaskStore((s) => s.runs);
  const currentRun = useScheduledTaskStore((s) => s.currentRun);
  const loadRuns = useScheduledTaskStore((s) => s.loadRuns);
  const loadRun = useScheduledTaskStore((s) => s.loadRun);
  const runNow = useScheduledTaskStore((s) => s.runNow);
  const update = useScheduledTaskStore((s) => s.update);
  const [editing, setEditing] = useState<SchedTask | null>(null);

  const task = useMemo(() => tasks.find((t) => t.id === selectedTaskId) ?? null, [tasks, selectedTaskId]);

  useEffect(() => {
    if (selectedTaskId) loadRuns(selectedTaskId);
  }, [selectedTaskId, task?.status]);

  const blocks = useMemo(
    () => (currentRun ? replay(currentRun.events) : []),
    [currentRun]
  );

  return (
    <div className="tasks-view">
      <div className="tasks-header">
        <button className="btn-secondary" onClick={() => setView("chat")} type="button">← 返回对话</button>
        <span className="tasks-note">任务在 app 开启时自动执行；关闭期间错过的会在下次开启时补跑。</span>
      </div>

      {!task && <div className="empty-hint"><div className="big">选择左侧一个定时任务</div></div>}

      {task && (
        <>
          <div className="task-detail-head">
            <div className="task-detail-command">{task.command}</div>
            <div className="task-detail-meta">
              {task.repeat === "daily" ? `每日 ${task.run_time}` : `一次性 ${task.scheduled_at}`}
              {" · 状态 "}<strong>{task.status}</strong>
              {task.last_error && <span className="task-err"> · {task.last_error}</span>}
            </div>
            <div className="task-detail-actions">
              <button onClick={() => runNow(task.id)} type="button" className="btn-primary">立即运行</button>
              <button onClick={() => setEditing(task)} type="button" className="btn-secondary">编辑</button>
              <button onClick={() => update(task.id, { enabled: !task.enabled })} type="button" className="btn-secondary">
                {task.enabled ? "停用" : "启用"}
              </button>
            </div>
          </div>

          <div className="task-runs">
            <div className="sidebar-label">运行历史</div>
            {runs.length === 0 && <div className="tree-empty">还没有运行记录</div>}
            {runs.map((r) => (
              <button
                key={r.run_id}
                className={currentRun?.run_id === r.run_id ? "sidebar-item active" : "sidebar-item"}
                onClick={() => loadRun(task.id, r.run_id)}
                type="button"
              >
                <span className={"task-dot task-" + r.status} />
                <span className="item-name">{r.started_at} · {r.status}</span>
              </button>
            ))}
          </div>

          {currentRun && (
            <div className="task-run-transcript">
              <div className="sidebar-label">执行过程</div>
              {blocks.length === 0 && <div className="tree-empty">（无内容）</div>}
              {blocks.map((b) => <BlockView key={(b as any).id} block={b as Block} isLive={false} />)}
              {currentRun.artifacts.length > 0 && (
                <div className="task-artifacts">
                  <div className="sidebar-label">产物</div>
                  {currentRun.artifacts.map((a) => (
                    <div key={a.path} className="task-artifact">{a.name}</div>
                  ))}
                </div>
              )}
            </div>
          )}
        </>
      )}

      {editing && currentPath && (
        <TaskEditModal workspace={currentPath} editing={editing} onClose={() => setEditing(null)} />
      )}
    </div>
  );
}
