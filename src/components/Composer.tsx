import { useRef, useState } from "react";
import { useChatStore } from "../state/chat-store";
import { useWorkspaceStore } from "../state/workspace-store";

export default function Composer() {
  const [text, setText] = useState("");
  const streaming = useChatStore((s) => s.streaming);
  const send = useChatStore((s) => s.send);
  const pause = useChatStore((s) => s.pause);
  const current = useWorkspaceStore((s) => s.current);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  function resize() {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }

  function doSend() {
    if (!text.trim()) return;
    send(text);
    setText("");
    if (textareaRef.current) textareaRef.current.style.height = "auto";
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    doSend();
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      doSend();
    }
  }

  return (
    <div className="composer-wrap">
      <form className="composer" onSubmit={submit}>
        <textarea
          ref={textareaRef}
          rows={1}
          value={text}
          placeholder={streaming ? "追加指令到当前任务…" : "给 FloodMind 一个任务…"}
          onChange={(e) => {
            setText(e.target.value);
            resize();
          }}
          onKeyDown={onKeyDown}
          autoFocus
          aria-label="任务输入"
        />
        <div className="composer-bottom">
          <div className="composer-context">
            <button
              className="ctx-pill"
              type="button"
              disabled
              title="添加附件（即将上线）"
              aria-label="添加附件（即将上线）"
            >
              +
            </button>
            <span className="ctx-pill model">deepseek-v4-flash</span>
          </div>
          <button
            className="send"
            type="submit"
            disabled={!text.trim()}
            aria-label="发送"
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              width="16"
              height="16"
              aria-hidden="true"
            >
              <path d="M12 19V5M5 12l7-7 7 7" />
            </svg>
          </button>
          {streaming && (
            <button
              className="pause"
              type="button"
              onClick={() => pause()}
              title="暂停（暂停后可追加指令，再发送即恢复）"
              aria-label="暂停"
            >
              <svg
                viewBox="0 0 24 24"
                fill="currentColor"
                width="14"
                height="14"
                aria-hidden="true"
              >
                <rect x="6" y="5" width="4" height="14" rx="1" />
                <rect x="14" y="5" width="4" height="14" rx="1" />
              </svg>
            </button>
          )}
        </div>
      </form>
      <div className="composer-hint">
        <span>工作区：{current ? current.name : "未选择"}</span>
        <span>·</span>
        <span>模型：deepseek-v4-flash</span>
        <span>·</span>
        <span>Enter 发送，Shift+Enter 换行</span>
      </div>
    </div>
  );
}
