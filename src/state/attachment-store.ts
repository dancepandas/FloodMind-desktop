import { create } from "zustand";

interface AttachmentState {
  pending: string[];
  add: (paths: string[]) => void;
  remove: (path: string) => void;
  clear: () => void;
}

export const useAttachmentStore = create<AttachmentState>((set) => ({
  pending: [],
  add: (paths) => set((s) => ({ pending: Array.from(new Set([...s.pending, ...paths])) })),
  remove: (path) => set((s) => ({ pending: s.pending.filter((p) => p !== path) })),
  clear: () => set({ pending: [] }),
}));
