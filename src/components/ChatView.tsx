import { useEffect, useRef } from "react";
import { useChatStore } from "../state/chat-store";

export default function ChatView() {
  const messages = useChatStore((s) => s.messages);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  return (
    <div className="chat">
      {messages.map((m, i) => (
        <div key={i} className={`msg msg-${m.role}`}>
          <span className="msg-role">{m.role === "user" ? "你" : "FloodMind"}</span>
          <div className="msg-content">{m.content || "…"}</div>
        </div>
      ))}
      <div ref={endRef} />
    </div>
  );
}
