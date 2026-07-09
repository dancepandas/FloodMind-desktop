import { useChatStore } from "../state/chat-store";

export default function UsageBadge() {
  const usage = useChatStore((s) => s.usage);
  if (!usage) return null;
  return <span className="badge badge-info">{usage.total} tokens</span>;
}
