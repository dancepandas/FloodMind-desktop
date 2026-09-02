import type { AssistantTurn } from "../state/chat-store";

/**
 * Derived turn status. A pure function of the turn's data (never persisted) —
 * the UI computes it at render time from `done` + `finishReason` + block shape.
 *
 *   running      — still streaming (done === false)
 *   completed    — finishReason === "stop" (normal completion)
 *   stopped      — finishReason ∈ {aborted, paused} (user paused / interrupted)
 *   max_tokens   — finishReason === "max_tokens" (answer truncated)
 *   failed       — finishReason ∈ {error, timeout, filtered, refused, unknown},
 *                  or the turn carries an error block
 *   interrupted  — done, no finishReason, no finalNode, no error (reloaded turn
 *                  that was mid-stream when the app closed)
 */
export type TurnStatus =
  | "running"
  | "completed"
  | "stopped"
  | "interrupted"
  | "failed"
  | "max_tokens";

const STOPPED_REASONS = new Set(["aborted", "paused"]);
const FAILED_REASONS = new Set(["error", "timeout", "filtered", "refused", "unknown"]);

export function turnStatus(turn: AssistantTurn): TurnStatus {
  if (!turn.done) return "running";
  if (turn.finishReason === "stop") return "completed";
  if (turn.finishReason === "max_tokens") return "max_tokens";
  if (turn.finishReason && STOPPED_REASONS.has(turn.finishReason)) return "stopped";
  if (turn.finishReason && FAILED_REASONS.has(turn.finishReason)) return "failed";
  if (turn.blocks.some((b) => b.kind === "error")) return "failed";
  if (turn.finalNodeId) return "completed";
  return "interrupted";
}

/** Human-readable status label for non-completed states ("" for normal turns). */
export function turnStatusLabel(turn: AssistantTurn): string {
  switch (turnStatus(turn)) {
    case "stopped":
      return "已停止";
    case "interrupted":
      return "已中断";
    case "failed":
      return "失败";
    case "max_tokens":
      return "达到最大 token";
    default:
      return "";
  }
}

/** Turn has a resolvable final answer node (data pointer, not DOM position). */
export function finalNode(turn: AssistantTurn) {
  if (!turn.finalNodeId) return null;
  return turn.blocks.find((b) => b.id === turn.finalNodeId && b.kind === "text") ?? null;
}
