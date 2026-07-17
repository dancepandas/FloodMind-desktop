import Logo from "./Logo";

export interface WelcomeSplashProps {
  onEnter: () => void;
}

/** One-time first-launch splash shown centered over the app. Dismissed by the
 *  "开始使用" button; the caller persists a flag so it never shows again. */
export default function WelcomeSplash({ onEnter }: WelcomeSplashProps) {
  return (
    <div className="welcome-splash" role="dialog" aria-label="欢迎使用 FloodMind">
      <div className="welcome-splash-card">
        <Logo className="welcome-splash-logo" />
        <h1 className="welcome-splash-title">欢迎使用 FloodMind</h1>
        <p className="welcome-splash-sub">你的全能水文智能助手</p>
        <button type="button" className="welcome-splash-btn" onClick={onEnter}>
          开始使用
        </button>
      </div>
    </div>
  );
}
