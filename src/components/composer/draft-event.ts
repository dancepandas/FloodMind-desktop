/** Shared UI-only handoff: starters fill the composer, never submit a turn. */
export const COMPOSER_DRAFT_EVENT = "floodmind:composer-draft";

export function requestComposerDraft(text: string) {
  window.dispatchEvent(new CustomEvent(COMPOSER_DRAFT_EVENT, { detail: { text } }));
}
