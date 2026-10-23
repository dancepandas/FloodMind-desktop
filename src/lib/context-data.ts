import type { ArtifactBlock, Block, Msg } from "../state/chat-store";

/** Match the conversation's final-artifact semantics, including legacy blocks. */
export function conversationArtifacts(turns: Msg[]): ArtifactBlock[] {
  return turns.flatMap((turn) => turn.role === "assistant"
    ? turn.blocks.filter((block): block is ArtifactBlock => block.kind === "artifact" && block.final !== false)
    : []);
}

export function findLatestPlan(turns: Msg[]): Extract<Block, { kind: "plan" }> | null {
  for (let i = turns.length - 1; i >= 0; i--) {
    const turn = turns[i];
    if (turn.role !== "assistant") continue;
    const plan = [...turn.blocks].reverse().find((block): block is Extract<Block, { kind: "plan" }> => block.kind === "plan");
    if (plan) return plan;
  }
  return null;
}
