import Logo from "./Logo";

export default function WelcomeView() {
  return (
    <div className="welcome-view">
      <Logo className="welcome-logo" />
      <h1 className="welcome-title">FloodMind</h1>
      <p className="welcome-sub">你的全能水文智能助手</p>
      <p className="welcome-hint">例如：“整理本周各站降雨与径流数据”或“生成明日入库流量预报”</p>
    </div>
  );
}
