import { create } from "zustand";
import { getBaseUrl } from "../lib/sidecar-client";
import type { Msg } from "./chat-store";

export interface ConvSummary {
  id: string;
  title: string;
  updated_at: string;
  active: boolean;
}
export interface Conversation extends ConvSummary {
  session_id: string;
  workspace: string;
  created_at: string;
  turns: Msg[];
}

interface ConversationState {
  list: ConvSummary[];
  byWorkspace: Record<string, ConvSummary[]>;
  loadList: (workspace: string) => Promise<ConvSummary[]>;
  loadWorkspaceConversations: (workspace: string) => Promise<ConvSummary[]>;
  create: (workspace: string) => Promise<Conversation | null>;
  open: (id: string) => Promise<Conversation | null>;
  activate: (id: string) => Promise<boolean>;
  remove: (id: string) => Promise<boolean>;
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

export const useConversationStore = create<ConversationState>((set) => ({
  list: [],
  byWorkspace: {},

  async loadList(workspace) {
    const data = await getJson(`/api/conversations?workspace=${encodeURIComponent(workspace)}`);
    const items: ConvSummary[] = (data && data.conversations) || [];
    set((s) => ({ list: items, byWorkspace: { ...s.byWorkspace, [workspace]: items } }));
    return items;
  },

  async loadWorkspaceConversations(workspace) {
    const data = await getJson(`/api/conversations?workspace=${encodeURIComponent(workspace)}`);
    const items: ConvSummary[] = (data && data.conversations) || [];
    set((s) => ({ byWorkspace: { ...s.byWorkspace, [workspace]: items } }));
    return items;
  },

  create(workspace) {
    return getJson("/api/conversations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspace }),
    });
  },

  open(id) {
    return getJson(`/api/conversations/${encodeURIComponent(id)}`);
  },

  async activate(id) {
    const v = await getJson(`/api/conversations/${encodeURIComponent(id)}/activate`, { method: "POST" });
    return v !== null;
  },

  async remove(id) {
    const v = await getJson(`/api/conversations/${encodeURIComponent(id)}`, { method: "DELETE" });
    return v !== null;
  },
}));
