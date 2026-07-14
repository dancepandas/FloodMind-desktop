import Logo from "./Logo";

const SCENARIOS = [
  { label: "文档处理", prompt: "帮我整理一份文档" },
  { label: "数据分析", prompt: "分析当前工作区里的数据文件" },
  { label: "生成 PPT", prompt: "根据工作区内容生成一份 PPT" },
  { label: "写代码", prompt: "帮我写一段代码" },
];

export interface WelcomeViewProps {
  onSend: (text: string) => void;
}

export default function WelcomeView({ onSend }: WelcomeViewProps) {
  return (
    <div className="welcome-view">
      <Logo className="welcome-logo" />
      <h1 className="welcome-title">FloodMind</h1>
      <p className="welcome-sub">你的智能工作助手，直接读写工作区文件完成任务</p>
      <div className="welcome-scenarios">
        {["日常办公", "代码开发", "设计创意"].map((s) => (
          <span key={s} className="welcome-chip">{s}</span>
        ))}
      </div>
      <div className="welcome-actions">
        {SCENARIOS.map((a) => (
          <button
            key={a.label}
            className="welcome-action"
            onClick={() => onSend(a.prompt)}
            type="button"
          >
            {a.label}
          </button>
        ))}
      </div>
    </div>
  );
}
