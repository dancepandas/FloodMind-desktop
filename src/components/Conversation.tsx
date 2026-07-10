import { useEffect, useRef } from "react";
import Logo from "./Logo";
import BlockView from "./BlockView";
import { useChatStore, type Block, type Msg } from "../state/chat-store";

export default function Conversation() {
  const turns = useChatStore((s) => s.turns);
  const streaming = useChatStore((s) => s.streaming);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [turns, streaming]);

  if (turns.length === 0) {
    return (
      <div className="conversation">
        <div className="empty-hint">
          <Logo className="empty-logo" />
          <div className="big">开始工作</div>
          <div className="sub">给 FloodMind 一个任务，它会直接读写工作区文件</div>
        </div>
      </div>
    );
  }

  return (
    <div className="conversation">
      {turns.map((m, i) => (
        <TurnView key={i} turn={m} isLast={i === turns.length - 1} streaming={streaming} />
      ))}
      <div ref={endRef} />
    </div>
  );
}

function TurnView({ turn, isLast, streaming }: { turn: Msg; isLast: boolean; streaming: boolean }) {
  if (turn.role === "user") {
    return (
      <div className="turn user-turn">
        <div className="msg-user">{turn.content}</div>
      </div>
    );
  }

  // During execution, only show the latest cycle (from the last thinking block
  // onward). Everything before that is fully hidden — the user sees a single
  // live step, not a growing list of collapsed chips.
  let startIdx = 0;
  if (isLast && streaming && !turn.done && turn.blocks.length > 1) {
    for (let i = turn.blocks.length - 1; i >= 0; i--) {
      if (turn.blocks[i].kind === "thinking") {
        startIdx = i;
        break;
      }
    }
  }
  const visible = startIdx > 0 ? turn.blocks.slice(startIdx) : turn.blocks;
  const hiddenCount = startIdx;
  const liveIdx = isLast && streaming && !turn.done ? visible.length - 1 : -1;

  return (
    <div className="turn assistant-turn">
      <div className="assistant-header">
        <span className="assistant-avatar" aria-hidden="true">F</span>
        <span className="assistant-name">FloodMind</span>
      </div>

      {hiddenCount > 0 && (
        <div className="steps-collapsed">已收起 {hiddenCount} 个步骤</div>
      )}

      {turn.blocks.length === 0 && !turn.done && <div className="thinking-body">…</div>}

      {visible.map((b: Block, j: number) => (
        <BlockView key={b.id} block={b} isLive={j === liveIdx} />
      ))}

      {turn.usage && (
        <div className="usage-line">
          ↑ {turn.usage.prompt} ↓ {turn.usage.completion} · {turn.usage.total} tok
        </div>
      )}
    </div>
  );
}
