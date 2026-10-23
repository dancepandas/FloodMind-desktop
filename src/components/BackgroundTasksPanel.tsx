import { useBackgroundTaskStore, isRunningStatus, type BgTask } from "../state/background-task-store";

const STATUS_LABELS: Record<BgTask["status"], string> = {
  starting: "启动中",
  running: "运行中",
  kill_requested: "终止请求中",
  terminating: "终止中",
  completed: "已完成",
  failed: "失败",
  killed: "已终止",
  kill_failed: "终止失败",
  orphaned: "孤儿进程",
  unknown: "未知",
};

function fmtTime(epoch: number | null): string {
  if (!epoch) return "—";
  const d = new Date(epoch * 1000);
  return d.toLocaleTimeString("zh-CN", { hour12: false });
}

/** Right-side panel listing the session's background Bash tasks.
 *  Each running task can be manually terminated (关闭); 返回 dismisses the panel
 *  and returns to the dialog. */
export default function BackgroundTasksPanel({ embedded = false }: { embedded?: boolean }) {
  const tasks = useBackgroundTaskStore((s) => s.tasks);
  const kill = useBackgroundTaskStore((s) => s.kill);
  const setPanelOpen = useBackgroundTaskStore((s) => s.setPanelOpen);
  const load = useBackgroundTaskStore((s) => s.load);

  return (
    <aside className="bg-panel">
      {!embedded && <div className="bg-panel-header">
        <span className="bg-panel-title">后台任务</span>
        <button
          className="btn-secondary bg-panel-back"
          onClick={() => setPanelOpen(false)}
          type="button"
        >
          返回
        </button>
      </div>}
      {tasks.length === 0 && <div className="bg-panel-empty">暂无后台任务</div>}
      <div className="bg-panel-list">
        {tasks.map((t) => (
          <div key={t.task_id} className={`bg-task bg-task-${t.status}`}>
            <div className="bg-task-row">
              <span className={`task-dot task-${t.status}`} />
              <span className="bg-task-command" title={t.command}>{t.command}</span>
              {isRunningStatus(t.status) && (
                <button
                  className="bg-task-kill"
                  onClick={() => kill(t.task_id)}
                  type="button"
                  aria-label={`关闭任务 ${t.command}`}
                >
                  关闭
                </button>
              )}
            </div>
            <div className="bg-task-meta">
              {STATUS_LABELS[t.status]}
              {t.exit_code !== null && ` · 退出码 ${t.exit_code}`}
              {` · 开始 ${fmtTime(t.started_at)}`}
              {t.finished_at !== null && ` · 结束 ${fmtTime(t.finished_at)}`}
            </div>
            {t.tail && <pre className="bg-task-tail">{t.tail}</pre>}
          </div>
        ))}
      </div>
      {tasks.some((t) => isRunningStatus(t.status)) && (
        <div className="bg-panel-foot">
          <button className="btn-secondary" onClick={load} type="button">刷新</button>
        </div>
      )}
    </aside>
  );
}
