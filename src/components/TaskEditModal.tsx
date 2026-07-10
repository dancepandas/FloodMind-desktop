import { useState } from "react";
import { useScheduledTaskStore, type SchedTask } from "../state/scheduled-task-store";

interface Props {
  workspace: string;
  editing: SchedTask | null;   // null = create mode
  onClose: () => void;
}

export default function TaskEditModal({ workspace, editing, onClose }: Props) {
  const create = useScheduledTaskStore((s) => s.create);
  const update = useScheduledTaskStore((s) => s.update);
  const [command, setCommand] = useState(editing?.command ?? "");
  const [repeat, setRepeat] = useState<"none" | "daily">(editing?.repeat ?? "none");
  const [runTime, setRunTime] = useState(editing?.run_time ?? "09:00");
  const [scheduledAt, setScheduledAt] = useState(
    editing?.scheduled_at ?? new Date(Date.now() + 3600_000).toISOString().slice(0, 16)
  );
  const [enabled, setEnabled] = useState(editing?.enabled ?? true);
  const [error, setError] = useState("");

  async function save() {
    if (!command.trim()) return setError("请填写任务描述");
    if (repeat === "daily" && !runTime) return setError("每日任务需要运行时间");
    if (repeat === "none" && !scheduledAt) return setError("一次性任务需要执行时间");
    const result = editing
      ? await update(editing.id, { command, repeat, run_time: runTime, scheduled_at: scheduledAt, enabled })
      : await create({ workspace, command, repeat, enabled, ...(repeat === "daily" ? { run_time: runTime } : { scheduled_at: scheduledAt }) });
    if (!result) {
      setError("保存失败，请检查网络或输入");
      return;
    }
    onClose();
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-title">{editing ? "编辑定时任务" : "新建定时任务"}</div>
        <label className="modal-label">任务描述（给 FloodMind 的指令）</label>
        <textarea className="modal-textarea" rows={4} value={command}
          onChange={(e) => setCommand(e.target.value)} placeholder="例如：生成上周销售周报" />
        <div className="modal-row">
          <label><input type="radio" checked={repeat === "none"} onChange={() => setRepeat("none")} /> 一次性</label>
          <label><input type="radio" checked={repeat === "daily"} onChange={() => setRepeat("daily")} /> 每日</label>
        </div>
        {repeat === "daily" ? (
          <label className="modal-label">运行时间
            <input type="time" value={runTime} onChange={(e) => setRunTime(e.target.value)} />
          </label>
        ) : (
          <label className="modal-label">执行时间
            <input type="datetime-local" value={scheduledAt} onChange={(e) => setScheduledAt(e.target.value)} />
          </label>
        )}
        <label className="modal-row">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> 启用
        </label>
        {error && <div className="modal-error">{error}</div>}
        <div className="modal-actions">
          <button className="btn-secondary" onClick={onClose} type="button">取消</button>
          <button className="btn-primary" onClick={save} type="button">保存</button>
        </div>
      </div>
    </div>
  );
}
