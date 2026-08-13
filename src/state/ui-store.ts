import { create } from "zustand";

export type View = "chat" | "skills" | "mcp" | "settings" | "tasks" | "experience" | "plugins";

export interface Toast {
  id: number;
  message: string;
}

interface UiState {
  view: View;
  selectedTaskId: string | null;
  planPanelOpen: boolean;
  previewPath: string | null;
  /** Transient user-facing message (auto-clears after a few seconds). Used for
   *  non-blocking feedback like "当前模型不支持图片输入". */
  toast: Toast | null;
  setView: (v: View) => void;
  setSelectedTaskId: (id: string | null) => void;
  setPlanPanelOpen: (open: boolean) => void;
  togglePlanPanel: () => void;
  setPreviewPath: (p: string | null) => void;
  closePreview: () => void;
  /** Lightbox image preview, independent of the file PreviewPanel. null when
   *  closed. Open via openLightbox({src, name}) from a message-bubble thumb. */
  lightboxImage: { src: string; name: string } | null;
  openLightbox: (image: { src: string; name: string }) => void;
  closeLightbox: () => void;
  showToast: (message: string) => void;
  clearToast: () => void;
}

// Module-level timer so a new toast replaces (rather than races) the previous
// one's auto-clear. Not in the store because setTimeout handles are not serializable.
let _toastTimer: ReturnType<typeof setTimeout> | null = null;
const TOAST_MS = 3500;

export const useUiStore = create<UiState>((set) => ({
  view: "chat",
  selectedTaskId: null,
  planPanelOpen: false,
  previewPath: null,
  toast: null,
  setView: (view) => set({ view }),
  setSelectedTaskId: (selectedTaskId) => set({ selectedTaskId }),
  setPlanPanelOpen: (planPanelOpen) => set({ planPanelOpen }),
  togglePlanPanel: () => set((s) => ({ planPanelOpen: !s.planPanelOpen })),
  setPreviewPath: (previewPath) => set({ previewPath }),
  closePreview: () => set({ previewPath: null }),
  lightboxImage: null,
  openLightbox: (lightboxImage) => set({ lightboxImage }),
  closeLightbox: () => set({ lightboxImage: null }),
  showToast: (message) => {
    set({ toast: { id: Date.now(), message } });
    if (_toastTimer) clearTimeout(_toastTimer);
    _toastTimer = setTimeout(() => {
      set({ toast: null });
      _toastTimer = null;
    }, TOAST_MS);
  },
  clearToast: () => {
    if (_toastTimer) {
      clearTimeout(_toastTimer);
      _toastTimer = null;
    }
    set({ toast: null });
  },
}));
