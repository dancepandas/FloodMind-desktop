import { useChatStore } from "../state/chat-store";
import { useConfigStore } from "../state/config-store";
import { formatTokens } from "../lib/format-tokens";

const SIZE = 16;
const STROKE = 2;
const R = (SIZE - STROKE) / 2;
const CIRCUMFERENCE = 2 * Math.PI * R;

/** Small SVG progress ring that fills clockwise as context usage grows.
 *  Appears next to the send button; transparent when empty, gradually
 *  darkens to black as the prompt-token count approaches the model's
 *  context window.  Hover to see the actual numbers. */
export default function ContextRing() {
  const contextSize = useConfigStore((s) => s.model?.contextSize);
  const turns = useChatStore((s) => s.turns);

  // Prompt tokens from the latest done turn (the full prompt sent, incl.
  // history, is what the SDK reports as usage.prompt).  While streaming,
  // use the live (accumulated) turn instead.
  const last = turns[turns.length - 1];
  const prompt =
    last?.role === "assistant" ? (last.usage?.prompt ?? 0) : 0;

  const max = contextSize && contextSize > 0 ? contextSize : 256_000;
  const pct = Math.min(prompt / max, 1);

  const dashOffset = CIRCUMFERENCE * (1 - pct);

  return (
    <span
      className="context-ring-wrap"
      title={`上下文用量：${formatTokens(prompt)} / ${formatTokens(max)} (${(pct * 100).toFixed(0)}%)`}
      role="meter"
      aria-valuenow={prompt}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-label={`上下文 ${Math.round(pct * 100)}%`}
    >
      <svg
        className="context-ring"
        width={SIZE}
        height={SIZE}
        viewBox={`0 0 ${SIZE} ${SIZE}`}
        aria-hidden="true"
      >
        {/* background track — always visible, very faint */}
        <circle
          cx={SIZE / 2}
          cy={SIZE / 2}
          r={R}
          fill="none"
          stroke="var(--border)"
          strokeWidth={STROKE}
        />
        {/* fill arc — stroke colour darkens from transparent → black as usage grows */}
        <circle
          cx={SIZE / 2}
          cy={SIZE / 2}
          r={R}
          fill="none"
          stroke={`rgba(0,0,0,${0.08 + pct * 0.92})`}
          strokeWidth={STROKE}
          strokeLinecap="round"
          strokeDasharray={`${CIRCUMFERENCE} ${CIRCUMFERENCE}`}
          strokeDashoffset={dashOffset}
          transform={`rotate(-90 ${SIZE / 2} ${SIZE / 2})`}
          style={{ transition: "stroke-dashoffset 0.35s ease, stroke 0.35s ease" }}
        />
      </svg>
    </span>
  );
}
