import { useRef, useState } from "react";
import { useChatStore } from "../state/chat-store";
import { useWorkspaceStore } from "../state/workspace-store";
import { useAttachmentStore } from "../state/attachment-store";
import FilePickerModal from "./FilePickerModal";

export default function Composer() {
  const [text, setText] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const streaming = useChatStore((s) => s.streaming);
  const send = useChatStore((s) => s.send);
  const pause = useChatStore((s) => s.pause);
  const current = useWorkspaceStore((s) => s.current);
  const attachments = useAttachmentStore((s) => s.pending);
  const addAttachments = useAttachmentStore((s) => s.add);
  const removeAttachment = useAttachmentStore((s) => s.remove);
  const clearAttachments = useAttachmentStore((s) => s.clear);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  function resize() {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }

  function buildMessage(): string {
    const trimmed = text.trim();
    if (attachments.length === 0) return trimmed;
    const refs = attachments.map((p) => `- ${p}`).join("\n");
    if (!trimmed) return `请处理以下文件：\n${refs}`;
    return `${trimmed}\n\n[引用文件]\n${refs}`;
  }

  function doSend() {
    const msg = buildMessage();
    if (!msg) return;
    send(msg);
    setText("");
    clearAttachments();
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
        {attachments.length > 0 && (
          <div className="composer-attachments">
            {attachments.map((p) => (
              <span key={p} className="attachment-pill" title={p}>
                <span className="attachment-name">{p}</span>
                <button
                  type="button"
                  className="attachment-remove"
                  onClick={() => removeAttachment(p)}
                  aria-label={`移除 ${p}`}
                >
                  ✕
                </button>
              </span>
            ))}
          </div>
        )}
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
              disabled={!current || streaming}
              onClick={() => setPickerOpen(true)}
              title={current ? "引用工作区文件" : "请先打开一个工作区"}
              aria-label="引用工作区文件"
            >
              ＋
            </button>
            <span className="ctx-pill model">deepseek-v4-flash</span>
          </div>
          <button
            className="send"
            type="submit"
            disabled={!buildMessage().trim()}
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

      {pickerOpen && (
        <FilePickerModal
          onClose={() => setPickerOpen(false)}
          onConfirm={(paths) => {
            addAttachments(paths);
            setPickerOpen(false);
          }}
        />
      )}
    </div>
  );
}
