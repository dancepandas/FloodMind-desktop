import { create } from "zustand";

export type View = "chat" | "skills" | "mcp" | "settings";

interface UiState {
  view: View;
  setView: (v: View) => void;
}

export const useUiStore = create<UiState>((set) => ({
  view: "chat",
  setView: (view) => set({ view }),
}));
