import Logo from "./Logo";
import { requestComposerDraft } from "./composer/draft-event";
import "../styles/composer.css";

const STARTERS = [
  { title: "整理一份文档", hint: "提炼重点，形成清晰摘要", draft: "请帮我整理这份文档，提炼核心观点、关键结论和待办事项。" },
  { title: "分析一组数据", hint: "发现变化，解释背后原因", draft: "请帮我分析这组数据，检查数据质量、找出主要趋势，并给出结论。" },
  { title: "推进一个计划", hint: "拆解目标，明确下一步", draft: "请帮我把这个目标拆解成可执行的计划，列出步骤、优先级和需要准备的材料。" },
];

export function WelcomeStarters() {
  return (
    <div className="fm-welcome-starters" aria-label="任务灵感">
      {STARTERS.map((starter) => (
        <button key={starter.title} type="button" title={`${starter.hint}；填入草稿后再发送`} onClick={() => requestComposerDraft(starter.draft)}>
          {starter.title}
        </button>
      ))}
    </div>
  );
}

export default function WelcomeView() {
  return (
    <section className="fm-welcome" aria-labelledby="welcome-title">
      <div className="fm-welcome-brand"><Logo className="fm-welcome-logo" /><span>FloodMind</span></div>
      <h1 id="welcome-title">今天，想完成什么？</h1>
    </section>
  );
}
