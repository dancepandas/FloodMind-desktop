import { create } from "zustand";
import { getBaseUrl } from "../lib/sidecar-client";

export interface SkillSummary {
  name: string;
  description: string;
  category?: string;
  version?: string;
  source?: string;
  builtin?: boolean;
  disabled?: boolean;
}
export interface SkillDetail extends SkillSummary {
  prompt?: string;
  provides_tools?: string[];
  scripts?: string[];
  references?: string[];
  assets?: string[];
  is_knowledge_only?: boolean;
}
export interface SkillForm {
  name?: string;
  description: string;
  category: string;
  version: string;
  prompt: string;
}
export interface McpServer {
  name: string;
  transport?: string;
  tools?: number;
  connected?: boolean;
  /** Most-recent tool-call outcome. null = no call yet; a connected wrapper can
   *  still fail when the backend it proxies is down. */
  health_ok?: boolean | null;
  health_error?: string | null;
}
export interface McpServerDetail {
  name: string;
  transport?: string;
  tools?: string[];
  connected?: boolean;
  health_ok?: boolean | null;
  health_error?: string | null;
}
export interface McpServerForm {
  name?: string;
  transport: "stdio" | "sse";
  command?: string;
  args: string[];
  env: Record<string, string>;
  url?: string;
}

interface CatalogState {
  skills: SkillSummary[];
  skillDetail: SkillDetail | null;
  skillDetailLoading: boolean;
  skillSaving: boolean;
  skillError: string | null;
  mcpServers: McpServer[];
  mcpDetail: McpServerDetail | null;
  mcpDetailLoading: boolean;
  mcpSaving: boolean;
  mcpError: string | null;
  mcpTesting: boolean;
  loadSkills: () => Promise<void>;
  loadSkill: (name: string) => Promise<void>;
  loadMcp: () => Promise<void>;
  loadMcpServer: (name: string) => Promise<void>;
  setSkillDisabled: (name: string, disabled: boolean) => Promise<void>;
  createSkill: (skill: SkillForm) => Promise<void>;
  updateSkill: (name: string, skill: SkillForm) => Promise<void>;
  deleteSkill: (name: string) => Promise<void>;
  createMcpServer: (server: McpServerForm) => Promise<void>;
  updateMcpServer: (name: string, server: McpServerForm) => Promise<void>;
  deleteMcpServer: (name: string) => Promise<void>;
  testMcpServer: (name: string) => Promise<{ ok: boolean; error?: string }>;
}

let _skillReq = 0;
let _mcpReq = 0;

async function _post(path: string, body: unknown) {
  const b = await getBaseUrl();
  const r = await fetch(`${b}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const err = await r.text().catch(() => "request failed");
    throw new Error(err);
  }
  return r;
}

async function _put(path: string, body: unknown) {
  const b = await getBaseUrl();
  const r = await fetch(`${b}${path}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const err = await r.text().catch(() => "request failed");
    throw new Error(err);
  }
  return r;
}

async function _delete(path: string) {
  const b = await getBaseUrl();
  const r = await fetch(`${b}${path}`, { method: "DELETE" });
  if (!r.ok) {
    const err = await r.text().catch(() => "request failed");
    throw new Error(err);
  }
  return r;
}

export const useCatalogStore = create<CatalogState>((set, get) => ({
  skills: [],
  skillDetail: null,
  skillDetailLoading: false,
  skillSaving: false,
  skillError: null,
  mcpServers: [],
  mcpDetail: null,
  mcpDetailLoading: false,
  mcpSaving: false,
  mcpError: null,
  mcpTesting: false,

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
      if (req !== _skillReq) return;
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
      if (req !== _mcpReq) return;
      if (!r.ok) return;
      set({ mcpDetail: await r.json() });
    } catch {
      /* ignore */
    } finally {
      if (req === _mcpReq) set({ mcpDetailLoading: false });
    }
  },

  async setSkillDisabled(name, disabled) {
    set({ skillSaving: true, skillError: null });
    try {
      await _post(`/api/skills/${encodeURIComponent(name)}/disabled`, { disabled });
      await get().loadSkills();
      if (get().skillDetail?.name === name) await get().loadSkill(name);
    } catch (e) {
      set({ skillError: e instanceof Error ? e.message : "failed" });
      throw e;
    } finally {
      set({ skillSaving: false });
    }
  },

  async createSkill(skill) {
    set({ skillSaving: true, skillError: null });
    try {
      await _post("/api/skills", skill);
      await get().loadSkills();
    } catch (e) {
      set({ skillError: e instanceof Error ? e.message : "failed" });
      throw e;
    } finally {
      set({ skillSaving: false });
    }
  },

  async updateSkill(name, skill) {
    set({ skillSaving: true, skillError: null });
    try {
      await _put(`/api/skills/${encodeURIComponent(name)}`, skill);
      await get().loadSkills();
      if (get().skillDetail?.name === name) await get().loadSkill(name);
    } catch (e) {
      set({ skillError: e instanceof Error ? e.message : "failed" });
      throw e;
    } finally {
      set({ skillSaving: false });
    }
  },

  async deleteSkill(name) {
    set({ skillSaving: true, skillError: null });
    try {
      await _delete(`/api/skills/${encodeURIComponent(name)}`);
      await get().loadSkills();
      if (get().skillDetail?.name === name) set({ skillDetail: null });
    } catch (e) {
      set({ skillError: e instanceof Error ? e.message : "failed" });
      throw e;
    } finally {
      set({ skillSaving: false });
    }
  },

  async createMcpServer(server) {
    set({ mcpSaving: true, mcpError: null });
    try {
      await _post("/api/mcp", server);
      await get().loadMcp();
    } catch (e) {
      set({ mcpError: e instanceof Error ? e.message : "failed" });
      throw e;
    } finally {
      set({ mcpSaving: false });
    }
  },

  async updateMcpServer(name, server) {
    set({ mcpSaving: true, mcpError: null });
    try {
      await _put(`/api/mcp/${encodeURIComponent(name)}`, server);
      await get().loadMcp();
      if (get().mcpDetail?.name === name) await get().loadMcpServer(name);
    } catch (e) {
      set({ mcpError: e instanceof Error ? e.message : "failed" });
      throw e;
    } finally {
      set({ mcpSaving: false });
    }
  },

  async deleteMcpServer(name) {
    set({ mcpSaving: true, mcpError: null });
    try {
      await _delete(`/api/mcp/${encodeURIComponent(name)}`);
      await get().loadMcp();
      if (get().mcpDetail?.name === name) set({ mcpDetail: null });
    } catch (e) {
      set({ mcpError: e instanceof Error ? e.message : "failed" });
      throw e;
    } finally {
      set({ mcpSaving: false });
    }
  },

  async testMcpServer(name) {
    set({ mcpTesting: true });
    try {
      const b = await getBaseUrl();
      const r = await fetch(`${b}/api/mcp/${encodeURIComponent(name)}/test`, { method: "POST" });
      if (!r.ok) {
        const err = await r.text().catch(() => r.statusText || "request failed");
        throw new Error(err);
      }
      const data = await r.json();
      return { ok: !!data.ok, error: data.error };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : "failed" };
    } finally {
      set({ mcpTesting: false });
    }
  },
}));
