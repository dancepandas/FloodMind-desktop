import { create } from "zustand";

export type View = "chat" | "skills" | "mcp" | "settings" | "tasks";

interface UiState {
  view: View;
  selectedTaskId: string | null;
  planPanelOpen: boolean;
  setView: (v: View) => void;
  setSelectedTaskId: (id: string | null) => void;
  setPlanPanelOpen: (open: boolean) => void;
  togglePlanPanel: () => void;
}

export const useUiStore = create<UiState>((set) => ({
  view: "chat",
  selectedTaskId: null,
  planPanelOpen: false,
  setView: (view) => set({ view }),
  setSelectedTaskId: (selectedTaskId) => set({ selectedTaskId }),
  setPlanPanelOpen: (planPanelOpen) => set({ planPanelOpen }),
  togglePlanPanel: () => set((s) => ({ planPanelOpen: !s.planPanelOpen })),
}));
