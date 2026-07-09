import HealthBadge from "./HealthBadge";
import UsageBadge from "./UsageBadge";
import WorkspaceSwitcher from "./WorkspaceSwitcher";

export default function StatusBar() {
  return (
    <div className="statusbar">
      <WorkspaceSwitcher />
      <span className="sep">/</span>
      <span className="brand">
        Flood<span className="dot">·</span>Mind
      </span>
      <span className="sep">/</span>
      <span className="pill">deepseek-v4-flash</span>
      <span className="spacer" />
      <HealthBadge />
      <UsageBadge />
    </div>
  );
}
