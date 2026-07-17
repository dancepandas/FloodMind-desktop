import type { CSSProperties } from "react";

interface ProviderIconProps {
  provider: string;
  className?: string;
  style?: CSSProperties;
}

const ICON_SRC: Record<string, string> = {
  deepseek: "/deepseek-color.svg",
  zhipu: "/zhipu-color.svg",
  moonshot: "/moonshot.svg",
  qwen: "/qwen-color.svg",
  minimax: "/minimax-color.svg",
  openai: "/openai.svg",
  ollama: "/ollama.svg",
};

export default function ProviderIcon({
  provider,
  className,
  style,
}: ProviderIconProps) {
  const src = ICON_SRC[provider];
  if (!src) {
    return (
      <svg
        className={className}
        style={style}
        viewBox="0 0 24 24"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
      >
        <title>{provider}</title>
        <rect width="24" height="24" rx="6" fill="#6B7280" />
        <circle cx="12" cy="12" r="5" stroke="white" strokeWidth="2" />
      </svg>
    );
  }

  return (
    <img
      src={src}
      alt={provider}
      className={className}
      style={style}
    />
  );
}
