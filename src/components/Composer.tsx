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
    <div className="composer-wrap">
      <form className="composer" onSubmit={submit}>
        <span className="prompt">›</span>
        <input
          value={text}
          placeholder={streaming ? "正在生成…" : "给 FloodMind 一个任务…"}
          onChange={(e) => setText(e.target.value)}
          disabled={streaming}
          autoFocus
        />
        <button className="send" type="submit" disabled={streaming || !text.trim()}>
          发送 ↵
        </button>
      </form>
      <div className="composer-hint">
        <kbd>Enter</kbd> 发送 · 工作区内的文件会被直接读写
      </div>
    </div>
  );
}
