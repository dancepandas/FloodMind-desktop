import { create } from "zustand";
import { getBaseUrl } from "../lib/sidecar-client";
import { openFolderPicker } from "../lib/tauri-bridge";

export interface WorkspaceSummary {
  path: string;
  name: string;
}
export interface FileEntry {
  name: string;
  type: "file" | "dir";
  path: string;
}

interface WorkspaceState {
  current: WorkspaceSummary | null;
  recent: WorkspaceSummary[];
  filesRoot: string;
  load: () => Promise<void>;
  pickAndOpen: () => Promise<boolean>;
  openPath: (path: string) => Promise<void>;
  listFiles: (relPath?: string) => Promise<FileEntry[]>;
}

async function postOpen(path: string): Promise<boolean> {
  const baseUrl = await getBaseUrl();
  const res = await fetch(`${baseUrl}/api/workspace/open`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path }),
  });
  return res.ok;
}

export const useWorkspaceStore = create<WorkspaceState>((set, get) => ({
  current: null,
  recent: [],
  filesRoot: "",

  async load() {
    try {
      const baseUrl = await getBaseUrl();
      const res = await fetch(`${baseUrl}/api/workspace`);
      if (!res.ok) return;
      const data = await res.json();
      set({ current: data.current, recent: data.recent || [] });
    } catch {
      /* sidecar not ready yet; the health badge polls and UI retries on focus */
    }
  },

  async pickAndOpen() {
    const path = await openFolderPicker();
    if (!path) return false;
    const ok = await postOpen(path);
    if (ok) await get().load();
    return ok;
  },

  async openPath(path) {
    const ok = await postOpen(path);
    if (ok) await get().load();
  },

  async listFiles(relPath = ".") {
    try {
      const b = await getBaseUrl();
      const r = await fetch(`${b}/api/workspace/files?path=${encodeURIComponent(relPath)}`);
      if (!r.ok) return [];
      const data = await r.json();
      if (relPath === ".") set({ filesRoot: data.root || "" });
      return data.entries || [];
    } catch {
      return [];
    }
  },
}));
