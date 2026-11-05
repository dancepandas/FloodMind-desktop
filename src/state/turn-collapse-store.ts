import { create } from "zustand";

/**
 * Session-scoped collapse overrides for completed turn fold bars.
 *
 * Key = `${conversationId}:${turnIndex}` — the conversation id is server-stable
 * and a completed conversation's turn order is stable, so a collapse survives
 * switching away and back within the same app session (the spec's "WebUI 保持
 * 加载期间"). Deliberately in-memory: app restart resets overrides, matching
 * the spec rather than adding a disk-persistence surface for a UI preference.
 */
interface TurnCollapseState {
  overrides: Record<string, boolean>;
  setOverride: (key: string, collapsed: boolean) => void;
}

export const useTurnCollapseStore = create<TurnCollapseState>((set) => ({
  overrides: {},
  setOverride: (key, collapsed) =>
    set((s) => ({ overrides: { ...s.overrides, [key]: collapsed } })),
}));
