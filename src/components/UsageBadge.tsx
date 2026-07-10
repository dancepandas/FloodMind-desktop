import { useChatStore } from "../state/chat-store";

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

  const fmt = (n: number) => new Intl.NumberFormat("en-US").format(n);
  return (
    <span className="usage-pill" title="当前回合 token 统计">
      {fmt(usage.total)} <span className="usage-unit">tokens</span>
    </span>
  );
}
