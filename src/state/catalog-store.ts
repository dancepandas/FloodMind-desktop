import { create } from "zustand";
import { getBaseUrl } from "../lib/sidecar-client";

export interface SkillSummary {
  name: string;
  description: string;
  category?: string;
  version?: string;
  source?: string;
  disabled?: boolean;
}
export interface SkillDetail extends SkillSummary {
  prompt?: string;
  provides_tools?: string[];
}
export interface McpServer {
  name: string;
  transport?: string;
  tools?: number;
  connected?: boolean;
}
export interface McpServerDetail {
  name: string;
  transport?: string;
  tools?: string[];
  connected?: boolean;
}

interface CatalogState {
  skills: SkillSummary[];
  skillDetail: SkillDetail | null;
  skillDetailLoading: boolean;
  mcpServers: McpServer[];
  mcpDetail: McpServerDetail | null;
  mcpDetailLoading: boolean;
  loadSkills: () => Promise<void>;
  loadSkill: (name: string) => Promise<void>;
  loadMcp: () => Promise<void>;
  loadMcpServer: (name: string) => Promise<void>;
}

// Request tokens guard against the stale-detail race: if the user selects A then
// B, an A response arriving after B is ignored.
let _skillReq = 0;
let _mcpReq = 0;

export const useCatalogStore = create<CatalogState>((set) => ({
  skills: [],
  skillDetail: null,
  skillDetailLoading: false,
  mcpServers: [],
  mcpDetail: null,
  mcpDetailLoading: false,

  async loadSkills() {
    try {
      const b = await getBaseUrl();
      const r = await fetch(`${b}/api/skills`);
      if (!r.ok) return;
      const data = await r.json();
      set({ skills: data.skills || [] });
    } catch {
      /* sidecar not ready */
    }
  },

  async loadSkill(name) {
    const req = ++_skillReq;
    set({ skillDetail: null, skillDetailLoading: true });
    try {
      const b = await getBaseUrl();
      const r = await fetch(`${b}/api/skills/${encodeURIComponent(name)}`);
      if (req !== _skillReq) return; // superseded by a newer selection
      if (!r.ok) return;
      set({ skillDetail: await r.json() });
    } catch {
      /* ignore */
    } finally {
      if (req === _skillReq) set({ skillDetailLoading: false });
    }
  },

  async loadMcp() {
    try {
      const b = await getBaseUrl();
      const r = await fetch(`${b}/api/mcp`);
      if (!r.ok) return;
      const data = await r.json();
      set({ mcpServers: data.servers || [] });
    } catch {
      /* sidecar not ready */
    }
  },

  async loadMcpServer(name) {
    const req = ++_mcpReq;
    set({ mcpDetail: null, mcpDetailLoading: true });
    try {
      const b = await getBaseUrl();
      const r = await fetch(`${b}/api/mcp/${encodeURIComponent(name)}`);
      if (req !== _mcpReq) return; // superseded
      if (!r.ok) return;
      set({ mcpDetail: await r.json() });
    } catch {
      /* ignore */
    } finally {
      if (req === _mcpReq) set({ mcpDetailLoading: false });
    }
  },
}));
