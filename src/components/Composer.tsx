import { useState } from "react";
import { useChatStore } from "../state/chat-store";

export default function Composer() {
  const [text, setText] = useState("");
  const streaming = useChatStore((s) => s.streaming);
  const send = useChatStore((s) => s.send);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    send(text);
    setText("");
  }

  return (
    <form className="composer" onSubmit={submit}>
      <input
        value={text}
        placeholder="输入消息…"
        onChange={(e) => setText(e.target.value)}
        disabled={streaming}
      />
      <button type="submit" disabled={streaming || !text.trim()}>
        发送
      </button>
    </form>
  );
}
