import { create } from "zustand";

export type View = "chat" | "skills" | "mcp" | "settings" | "tasks";

interface UiState {
  view: View;
  selectedTaskId: string | null;
  setView: (v: View) => void;
  setSelectedTaskId: (id: string | null) => void;
}

export const useUiStore = create<UiState>((set) => ({
  view: "chat",
  selectedTaskId: null,
  setView: (view) => set({ view }),
  setSelectedTaskId: (selectedTaskId) => set({ selectedTaskId }),
}));
