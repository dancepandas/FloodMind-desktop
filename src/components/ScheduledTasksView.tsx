import { useEffect, useMemo, useState } from "react";
import { useScheduledTaskStore, type SchedTask } from "../state/scheduled-task-store";
import { useUiStore } from "../state/ui-store";
import { useWorkspaceStore } from "../state/workspace-store";
import { reduceEvent, type AssistantTurn, type Block } from "../state/chat-store";
import BlockView from "./BlockView";
import PageHeader from "./PageHeader";
import TaskEditModal from "./TaskEditModal";
import "../styles/catalog.css";

function emptyTurn(): AssistantTurn {
  return { id: "replay", role: "assistant", blocks: [], usage: null, done: false };
}

/** Replay a run's stored events through reduceEvent → blocks (reuses chat rendering). */
function replay(events: unknown[]): Block[] {
  let turn = emptyTurn();
  for (const ev of events as any[]) turn = reduceEvent(turn, ev) as AssistantTurn;
  return turn.blocks;
}

export default function ScheduledTasksView() {
  const selectedTaskId = useUiStore((s) => s.selectedTaskId);
  const setSelectedTaskId = useUiStore((s) => s.setSelectedTaskId);
  const currentPath = useWorkspaceStore((s) => s.current?.path);
  const tasks = useScheduledTaskStore((s) => s.tasks);
  const runs = useScheduledTaskStore((s) => s.runs);
  const currentRun = useScheduledTaskStore((s) => s.currentRun);
  const load = useScheduledTaskStore((s) => s.load);
  const loadRuns = useScheduledTaskStore((s) => s.loadRuns);
  const loadRun = useScheduledTaskStore((s) => s.loadRun);
  const runNow = useScheduledTaskStore((s) => s.runNow);
  const update = useScheduledTaskStore((s) => s.update);
  const [modalOpen, setModalOpen] = useState(false);
  const [editingTask, setEditingTask] = useState<SchedTask | null>(null);

  const task = useMemo(() => tasks.find((t) => t.id === selectedTaskId) ?? null, [tasks, selectedTaskId]);

  useEffect(() => {
    if (currentPath) load(currentPath);
  }, [currentPath, load]);

  useEffect(() => {
    if (selectedTaskId) loadRuns(selectedTaskId);
  }, [selectedTaskId, task?.status]);

  const blocks = useMemo(
    () => (currentRun ? replay(currentRun.events) : []),
    [currentRun]
  );

  function openCreate() {
    setEditingTask(null);
    setModalOpen(true);
  }

  function openEdit(task: SchedTask) {
    setEditingTask(task);
    setModalOpen(true);
  }

  function closeModal() {
    setModalOpen(false);
    setEditingTask(null);
    if (currentPath) load(currentPath);
  }

  return (
    <div className="tasks-view catalog-page" role="region" aria-label="定时任务" tabIndex={0}>
      <PageHeader variant="hero" title="自动化">
        <button className="btn-secondary" onClick={openCreate} type="button">＋ 新建定时任务</button>
      </PageHeader>

      <div className="tasks-layout">
        <span className="tasks-note">任务在 app 开启时自动执行；关闭期间错过的会在下次开启时补跑。</span>
        <ul className="tasks-list catalog-grid" aria-label="定时任务列表">
          {tasks.length === 0 && (
            <li className="tree-empty">暂无定时任务，点击上方按钮创建</li>
          )}

          {tasks.map((t) => (
            <li key={t.id}>
              <button
                className={selectedTaskId === t.id ? "task-card active" : "task-card"}
                onClick={() => setSelectedTaskId(t.id)}
                type="button"
                aria-pressed={selectedTaskId === t.id}
                aria-controls="scheduled-task-detail"
              >
                <span className="task-card-status">
                  <span className={"task-dot task-" + t.status} aria-hidden="true" />
                  {t.status} · {t.enabled ? "已启用" : "已停用"}
                </span>
                <span className="task-card-command">{t.command}</span>
                <span className="task-card-schedule">
                  {t.repeat === "daily" ? `每日 ${t.run_time}` : `一次性 ${t.scheduled_at}`}
                </span>
                {t.next_run_at && <span className="task-card-next">下次运行 {t.next_run_at}</span>}
              </button>
            </li>
          ))}
        </ul>

        {tasks.length > 0 && (
          <div className="tasks-detail" id="scheduled-task-detail" role="region" aria-label="定时任务详情">
            {!task && (
            <div className="empty-hint">
              <div className="big">选择一个定时任务查看详情</div>
            </div>
          )}

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
                  <button onClick={() => openEdit(task)} type="button" className="btn-secondary">编辑</button>
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
          </div>
        )}
      </div>

      {modalOpen && currentPath && (
        <TaskEditModal workspace={currentPath} editing={editingTask} onClose={closeModal} />
      )}
    </div>
  );
}
