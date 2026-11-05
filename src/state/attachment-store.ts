import { create } from "zustand";

export type ImageSource = "workspace" | "file" | "clipboard";

export interface ImageItem {
  id: string;
  name: string;
  mime: string;
  /** data: URL or blob: URL for display (CSP allows both). */
  thumb: string;
  source: ImageSource;
  /** workspace-relative path (source=workspace). */
  rel?: string;
  /** absolute path (source=file, drag-drop). */
  absPath?: string;
  /** base64 without prefix (source=clipboard). */
  data?: string;
}

/** Wire descriptor sent to /api/chat (matches sidecar normalize_attachment). */
export type ImageAttachmentWire =
  | { source: "workspace"; name: string; mime: string }
  | { source: "file"; path: string; mime: string }
  | { source: "clipboard"; data: string; mime: string };

interface AttachmentState {
  pending: string[];            // workspace file references (@ non-image)
  images: ImageItem[];          // image attachments (visual channel)
  add: (paths: string[]) => void;
  remove: (path: string) => void;
  clear: () => void;
  addImages: (items: ImageItem[]) => void;
  removeImage: (id: string) => void;
  clearImages: () => void;
  toWire: () => ImageAttachmentWire[];
}

export const useAttachmentStore = create<AttachmentState>((set, get) => ({
  pending: [],
  images: [],
  add: (paths) => set((s) => ({ pending: Array.from(new Set([...s.pending, ...paths])) })),
  remove: (path) => set((s) => ({ pending: s.pending.filter((p) => p !== path) })),
  clear: () => set({ pending: [], images: [] }),
  addImages: (items) => set((s) => ({ images: [...s.images, ...items] })),
  removeImage: (id) => set((s) => ({ images: s.images.filter((i) => i.id !== id) })),
  clearImages: () => set((s) => ({ images: [] })),
  toWire: () =>
    get().images.map((i) => {
      if (i.source === "workspace") return { source: "workspace", name: i.rel ?? i.name, mime: i.mime };
      if (i.source === "file") return { source: "file", path: i.absPath ?? "", mime: i.mime };
      return { source: "clipboard", data: i.data ?? "", mime: i.mime };
    }),
}));
