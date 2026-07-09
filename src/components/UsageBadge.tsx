import { useChatStore } from "../state/chat-store";

export default function UsageBadge() {
  const usage = useChatStore((s) => s.usage);
  if (!usage) return null;
  return <span className="pill">↑{usage.prompt} ↓{usage.completion} · {usage.total} tok</span>;
}
