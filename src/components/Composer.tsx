import { useRef, useState } from "react";
import { useChatStore } from "../state/chat-store";
import { useWorkspaceStore } from "../state/workspace-store";
import { useUiStore } from "../state/ui-store";
import { useAttachmentStore } from "../state/attachment-store";
import FilePickerModal from "./FilePickerModal";
import ComposerFilePicker from "./ComposerFilePicker";
import SlashPicker, { type SlashItem } from "./SlashPicker";

export default function Composer() {
  const [text, setText] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerQuery, setPickerQuery] = useState("");
  const [slashOpen, setSlashOpen] = useState(false);
  const [slashQuery, setSlashQuery] = useState("");
  const [filePickerOpen, setFilePickerOpen] = useState(false);
  const [slashItem, setSlashItem] = useState<SlashItem | null>(null);
  const streaming = useChatStore((s) => s.streaming);
  const send = useChatStore((s) => s.send);
  const pause = useChatStore((s) => s.pause);
  const current = useWorkspaceStore((s) => s.current);
  const recent = useWorkspaceStore((s) => s.recent);
  const openPath = useWorkspaceStore((s) => s.openPath);
  const pickAndOpen = useWorkspaceStore((s) => s.pickAndOpen);
  const setView = useUiStore((s) => s.setView);
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

  function handleChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    const v = e.target.value;
    setText(v);
    resize();

    const at = v.lastIndexOf("@");
    const slash = v.lastIndexOf("/");
    const lastTrigger = Math.max(at, slash);

    if (lastTrigger === at && at >= 0 && !v.slice(at + 1).includes(" ")) {
      setPickerOpen(true);
      setPickerQuery(v.slice(at + 1));
      setSlashOpen(false);
    } else if (lastTrigger === slash && slash >= 0 && !v.slice(slash + 1).includes(" ")) {
      setSlashOpen(true);
      setSlashQuery(v.slice(slash + 1));
      setPickerOpen(false);
    } else {
      setPickerOpen(false);
      setSlashOpen(false);
    }
  }

  function insertFile(name: string) {
    const at = text.lastIndexOf("@");
    const before = text.slice(0, at);
    const after = text.slice(at + 1 + pickerQuery.length);
    setText(before + after);
    setPickerOpen(false);
    addAttachments([name]);
    resize();
  }

  function insertSlash(item: SlashItem) {
    const slash = text.lastIndexOf("/");
    const before = text.slice(0, slash);
    const after = text.slice(slash + 1 + slashQuery.length);
    setText(before + after);
    setSlashItem(item);
    setSlashOpen(false);
    resize();
  }

  function buildMessage(): string {
    const trimmed = text.trim();
    const parts: string[] = [];

    if (attachments.length > 0) {
      const refs = attachments.map((p) => `- ${p}`).join("\n");
      parts.push(`[引用文件]\n${refs}`);
    }

    if (slashItem) {
      const instruction =
        slashItem.kind === "skill"
          ? `请使用 ${slashItem.name} skill`
          : `请使用 ${slashItem.name} MCP工具`;
      parts.push(instruction);
    }

    if (!trimmed && parts.length === 0) return "";
    if (!trimmed) return parts.join("\n\n");
    if (parts.length === 0) return trimmed;
    return `${trimmed}\n\n${parts.join("\n\n")}`;
  }

  function doSend() {
    const msg = buildMessage();
    if (!msg) return;
    send(msg);
    setText("");
    setSlashItem(null);
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
        {slashItem && (
          <div className="composer-slash-item">
            <span className="slash-pill" data-kind={slashItem.kind}>
              <span className="slash-pill-kind">
                {slashItem.kind === "skill" ? "Skill" : "MCP"}
              </span>
              <span className="slash-pill-name">{slashItem.name}</span>
              <button
                type="button"
                className="slash-pill-remove"
                onClick={() => setSlashItem(null)}
                aria-label={`移除 ${slashItem.name}`}
              >
                ✕
              </button>
            </span>
          </div>
        )}
        {slashOpen && (
          <SlashPicker
            query={slashQuery}
            onSelect={insertSlash}
            onClose={() => setSlashOpen(false)}
          />
        )}
        {pickerOpen && (
          <ComposerFilePicker
            query={pickerQuery}
            onSelect={insertFile}
            onClose={() => setPickerOpen(false)}
          />
        )}
        <textarea
          ref={textareaRef}
          rows={1}
          value={text}
          placeholder={streaming ? "追加指令到当前任务…" : "给 FloodMind 一个任务…"}
          onChange={handleChange}
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
              onClick={() => setFilePickerOpen(true)}
              title={current ? "引用工作区文件" : "请先打开一个工作区"}
              aria-label="引用工作区文件"
            >
              ＋
            </button>
            <span className="ctx-pill model">deepseek-v4-flash</span>
          </div>
          <div className="composer-actions">
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
        </div>
      </form>
      <div className="composer-meta">
        <select
          className="workspace-select"
          value={current?.path ?? ""}
          onChange={(e) => {
            const v = e.target.value;
            if (v === "__pick__") {
              pickAndOpen();
            } else if (v) {
              openPath(v);
            }
            setView("chat");
          }}
        >
          {current ? (
            <option value={current.path}>{current.name}</option>
          ) : (
            <option value="">未选择</option>
          )}
          {recent
            .filter((w) => w.path !== current?.path)
            .map((w) => (
              <option key={w.path} value={w.path}>
                {w.name}
              </option>
            ))}
          <option value="__pick__">打开其他工作区…</option>
        </select>
        <span>Enter 发送，Shift+Enter 换行</span>
      </div>

      {filePickerOpen && (
        <FilePickerModal
          onClose={() => setFilePickerOpen(false)}
          onConfirm={(paths) => {
            addAttachments(paths);
            setFilePickerOpen(false);
          }}
        />
      )}
    </div>
  );
}
