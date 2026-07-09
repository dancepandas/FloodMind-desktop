import { useChatStore } from "../state/chat-store";
import HealthBadge from "./HealthBadge";
import UsageBadge from "./UsageBadge";

export default function TopBar() {
  const messages = useChatStore((s) => s.messages);
  const reset = useChatStore((s) => s.reset);

  const firstUser = messages.find((m) => m.role === "user")?.content || "";
  const title = firstUser ? firstUser.slice(0, 40) + (firstUser.length > 40 ? "…" : "") : "新会话";

  return (
    <header className="topbar">
      <div className="topbar-title" title={firstUser}>{title}</div>
      <div className="topbar-actions">
        <HealthBadge />
        <UsageBadge />
        <button className="icon-btn" onClick={reset} title="新会话" type="button">
          ✕
        </button>
      </div>
    </header>
  );
}
