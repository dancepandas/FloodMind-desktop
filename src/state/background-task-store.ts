import { create } from "zustand";
import { getBaseUrl } from "../lib/sidecar-client";

// v2.0.0 BackgroundTask.status 全量：starting/running/kill_requested/terminating/
// completed/failed/killed/kill_failed/orphaned/unknown。
export type BgTaskStatus =
  | "starting"
  | "running"
  | "kill_requested"
  | "terminating"
  | "completed"
  | "failed"
  | "killed"
  | "kill_failed"
  | "orphaned"
  | "unknown";

export interface BgTask {
  task_id: string;
  command: string;
  status: BgTaskStatus;
  exit_code: number | null;
  started_at: number;
  finished_at: number | null;
  tail: string;
  stdout_path: string;
}

interface BackgroundTaskState {
  tasks: BgTask[];
  panelOpen: boolean;
  loading: boolean;
  load: () => Promise<void>;
  kill: (taskId: string) => Promise<boolean>;
  setPanelOpen: (open: boolean) => void;
}

const RUNNING_STATUSES: ReadonlySet<string> = new Set([
  "starting",
  "running",
  "kill_requested",
  "terminating",
]);

/** True when the task is still in progress (shell indicator + kill affordance). */
export function isRunningStatus(status: BgTaskStatus): boolean {
  return RUNNING_STATUSES.has(status);
}

/** Number of tasks still running — the "shell (N)" indicator count. */
export function runningCount(tasks: BgTask[]): number {
  return tasks.filter((t) => isRunningStatus(t.status)).length;
}

export const useBackgroundTaskStore = create<BackgroundTaskState>((set, get) => ({
  tasks: [],
  panelOpen: false,
  loading: false,

  async load() {
    try {
      const b = await getBaseUrl();
      const r = await fetch(`${b}/api/background-tasks`);
      if (!r.ok) return;
      const data = await r.json();
      if (Array.isArray(data?.tasks)) set({ tasks: data.tasks });
    } catch {
      /* ignore — sidecar unreachable */
    }
  },

  async kill(taskId) {
    try {
      const b = await getBaseUrl();
      const r = await fetch(
        `${b}/api/background-tasks/${encodeURIComponent(taskId)}/kill`,
        { method: "POST" },
      );
      if (!r.ok) return false;
      get().load();
      return true;
    } catch {
      return false;
    }
  },

  setPanelOpen(open) {
    set({ panelOpen: open });
  },
}));
