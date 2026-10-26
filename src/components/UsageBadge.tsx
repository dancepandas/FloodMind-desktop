import { useChatStore } from "../state/chat-store";
import { formatTokens } from "../lib/format-tokens";

export default function UsageBadge() {
  // Usage lives on the last assistant turn now (accumulated across that turn).
  const usage = useChatStore((s) => {
    for (let i = s.turns.length - 1; i >= 0; i--) {
      const t = s.turns[i];
      if (t.role === "assistant") return t.usage;
    }
    return null;
  });
  if (!usage) return null;

  return (
    <span className="usage-pill" title="当前回合 token 统计">
      {formatTokens(usage.total)}
    </span>
  );
}
