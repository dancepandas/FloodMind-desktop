import { useEffect, useRef, useState } from "react";
import Logo from "./Logo";
import BlockView from "./BlockView";
import WelcomeView from "./WelcomeView";
import { useChatStore, deriveStatusText, type Block, type Msg } from "../state/chat-store";

export default function Conversation() {
  const turns = useChatStore((s) => s.turns);
  const streaming = useChatStore((s) => s.streaming);
  const send = useChatStore((s) => s.send);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [turns, streaming]);

  if (turns.length === 0) {
    return (
      <div className="conversation">
        <WelcomeView onSend={send} />
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

  // ── after the turn completes, only the final answer is visible ──
  const finalBlock = turn.done ? turn.blocks.find((b) => b.kind === "text" && b.final) : null;
  const hasProcess = turn.blocks.some((b) => b.kind !== "text" || !b.final);
  const [showProcess, setShowProcess] = useState(false);

  // ── status line while streaming ────────────────────────────
  let statusText = "";
  if (isLast && streaming && !turn.done && turn.blocks.length > 0) {
    const live = turn.blocks[turn.blocks.length - 1];
    statusText = deriveStatusText(live);
  }

  // ── completed turn, process hidden ──────────────────────────
  if (turn.done && hasProcess && !showProcess) {
    const artifacts = turn.blocks.filter(
      (b): b is Extract<Block, { kind: "artifact" }> => b.kind === "artifact"
    );
    return (
      <div className="turn assistant-turn">
        <div className="assistant-header">
          <span className="assistant-avatar" aria-hidden="true">
            <Logo className="assistant-avatar-icon" />
          </span>
          <span className="assistant-name">FloodMind</span>
        </div>
        {finalBlock && (
          <div data-block-id={finalBlock.id}>
            <BlockView block={finalBlock} isLive={false} />
          </div>
        )}
        {artifacts.length > 0 && (
          <div className="artifact-list" data-testid="artifact-list">
            {artifacts.map((b) => (
              <div key={b.id} data-block-id={b.id}>
                <BlockView block={b} isLive={false} />
              </div>
            ))}
          </div>
        )}
        <button className="show-process" onClick={() => setShowProcess(true)} type="button">
          展开执行过程
        </button>
        {turn.usage && <UsageLine usage={turn.usage} />}
      </div>
    );
  }

  // ── streaming / expanded-process display ────────────────────
  // During execution, only the latest cycle (from the last thinking block
  // onward) is visible — previous cycles are silently hidden.
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
  const liveIdx = isLast && streaming && !turn.done ? visible.length - 1 : -1;

  return (
    <div className="turn assistant-turn">
      <div className="assistant-header">
        <span className="assistant-avatar" aria-hidden="true">
          <Logo className="assistant-avatar-icon" />
        </span>
        <span className="assistant-name">FloodMind</span>
        {statusText && <span className="assistant-status">{statusText}</span>}
      </div>

      {turn.blocks.length === 0 && !turn.done && <div className="thinking-body">…</div>}

      {visible.map((b: Block, j: number) => (
        <div key={b.id} data-block-id={b.id}>
          <BlockView block={b} isLive={j === liveIdx} />
        </div>
      ))}

      {turn.done && hasProcess && showProcess && (
        <button className="show-process" onClick={() => setShowProcess(false)} type="button">
          收起执行过程
        </button>
      )}

      {turn.usage && <UsageLine usage={turn.usage} />}
    </div>
  );
}

function UsageLine({ usage }: { usage: { prompt: number; completion: number; total: number } }) {
  const fmt = (n: number) => new Intl.NumberFormat("en-US").format(n);
  return (
    <div className="usage-line" aria-label="token 统计">
      <span className="usage-pill">
        {fmt(usage.total)} <span className="usage-unit">tokens</span>
      </span>
    </div>
  );
}
