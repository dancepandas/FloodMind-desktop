import { create } from "zustand";
import { getBaseUrl } from "../lib/sidecar-client";

export interface SchedTask {
  id: string;
  session_id: string;
  command: string;
  repeat: "none" | "daily";
  enabled: boolean;
  run_time: string;
  scheduled_at: string;
  timezone: string;
  next_run_at: string;
  status: string;
  last_status: string;
  last_run_at: string;
  last_finished_at: string;
  last_result: string;
  last_error: string;
  artifacts: { kind: string; name: string; path: string }[];
  attempt_count: number;
  created_at: string;
  updated_at: string;
}
export interface RunSummary {
  run_id: string;
  started_at: string;
  finished_at: string;
  status: string;
}
export interface RunDetail extends RunSummary {
  task_id: string;
  events: unknown[];
  artifacts: { kind: string; name: string; path: string }[];
}

export interface TaskCreateBody {
  workspace: string;
  command: string;
  repeat: "none" | "daily";
  run_time?: string;
  scheduled_at?: string;
  timezone?: string;
  enabled?: boolean;
}

interface State {
  tasks: SchedTask[];
  runs: RunSummary[];
  currentRun: RunDetail | null;
  load: (workspace: string) => Promise<SchedTask[]>;
  create: (body: TaskCreateBody) => Promise<SchedTask | null>;
  update: (id: string, patch: Record<string, unknown>) => Promise<SchedTask | null>;
  runNow: (id: string) => Promise<string | null>;
  loadRuns: (id: string) => Promise<RunSummary[]>;
  loadRun: (id: string, runId: string) => Promise<RunDetail | null>;
}

async function getJson(url: string, init?: RequestInit): Promise<any | null> {
  try {
    const b = await getBaseUrl();
    const r = await fetch(`${b}${url}`, init);
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

export const useScheduledTaskStore = create<State>((set) => ({
  tasks: [],
  runs: [],
  currentRun: null,

  async load(workspace) {
    const data = await getJson(`/api/scheduled-tasks?workspace=${encodeURIComponent(workspace)}`);
    const tasks: SchedTask[] = (data && data.tasks) || [];
    set({ tasks });
    return tasks;
  },

  create(body) {
    return getJson("/api/scheduled-tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  },

  async update(id, patch) {
    const v = await getJson(`/api/scheduled-tasks/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    return v?.task ?? null;
  },

  async runNow(id) {
    const v = await getJson(`/api/scheduled-tasks/${encodeURIComponent(id)}/run`, { method: "POST" });
    return v?.run_id ?? null;
  },

  async loadRuns(id) {
    const data = await getJson(`/api/scheduled-tasks/${encodeURIComponent(id)}/runs`);
    const runs: RunSummary[] = (data && data.runs) || [];
    set({ runs });
    return runs;
  },

  async loadRun(id, runId) {
    const run = await getJson(`/api/scheduled-tasks/${encodeURIComponent(id)}/runs/${encodeURIComponent(runId)}`);
    set({ currentRun: run });
    return run;
  },
}));
