import { useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useChatStore } from "../state/chat-store";
import { useWorkspaceStore } from "../state/workspace-store";
import { useConfigStore, type PermissionMode } from "../state/config-store";
import { useUiStore } from "../state/ui-store";
import { useAttachmentStore, type ImageItem } from "../state/attachment-store";
import { fileToDataUrl, isImageName, mimeForName, pathToDataUrl } from "../lib/image-thumb";
import FilePickerModal from "./FilePickerModal";
import ComposerFilePicker from "./ComposerFilePicker";
import SlashPicker, { type SlashItem } from "./SlashPicker";

const PERMISSION_MODE_LABELS: Record<PermissionMode, string> = {
  "always-trust": "完全信任",
  "trust-once": "首次询问",
  "always-ask": "每次都问",
};

/** 10MB client-side cap for pasted images. The sidecar remains the authority. */
const PASTE_MAX_BYTES = 10 * 1024 * 1024;

/**
 * Pure helper: given a `clipboardData.items`-like list, return the ImageItems
 * to insert. Extracted from onPaste so it is unit-testable in jsdom (jsdom's
 * DataTransfer/clipboard support is partial). Items that are not image files,
 * lack a backing File, or exceed the 10MB cap are dropped.
 */
export async function collectPastedImages(
  items: { kind: string; type: string; getAsFile: () => File | null }[],
): Promise<ImageItem[]> {
  const imageItems = items.filter(
    (it) => it.kind === "file" && it.type.startsWith("image/"),
  );
  const next: ImageItem[] = [];
  for (const it of imageItems) {
    const file = it.getAsFile();
    if (!file) continue;
    if (file.size > PASTE_MAX_BYTES) continue;
    const dataUrl = await fileToDataUrl(file);
    const name = file.name || `pasted-${Date.now()}.png`;
    next.push({
      id: `paste-${Date.now()}-${name}`,
      name,
      mime: file.type || mimeForName(name),
      thumb: dataUrl,
      source: "clipboard",
      data: dataUrl.slice(dataUrl.indexOf(",") + 1),
    });
  }
  return next;
}

export default function Composer() {
  const [text, setText] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerQuery, setPickerQuery] = useState("");
  const [slashOpen, setSlashOpen] = useState(false);
  const [slashQuery, setSlashQuery] = useState("");
  const [filePickerOpen, setFilePickerOpen] = useState(false);
  const [slashItem, setSlashItem] = useState<SlashItem | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const streaming = useChatStore((s) => s.streaming);
  const send = useChatStore((s) => s.send);
  const pause = useChatStore((s) => s.pause);
  const current = useWorkspaceStore((s) => s.current);
  const recent = useWorkspaceStore((s) => s.recent);
  const openPath = useWorkspaceStore((s) => s.openPath);
  const pickAndOpen = useWorkspaceStore((s) => s.pickAndOpen);
  const permissionMode = useConfigStore((s) => s.permissionMode);
  const modelName = useConfigStore((s) => s.model?.model ?? null);
  const supportsVision = useConfigStore((s) => !!s.model?.supportsVision);
  const setView = useUiStore((s) => s.setView);
  const showToast = useUiStore((s) => s.showToast);
  const attachments = useAttachmentStore((s) => s.pending);
  const addAttachments = useAttachmentStore((s) => s.add);
  const removeAttachment = useAttachmentStore((s) => s.remove);
  const clearAttachments = useAttachmentStore((s) => s.clear);
  const images = useAttachmentStore((s) => s.images);
  const addImages = useAttachmentStore((s) => s.addImages);
  const removeImage = useAttachmentStore((s) => s.removeImage);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  function resize() {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }

  function findTriggerIndex(value: string, char: string, allowAfter = ""): number {
    let i = value.length;
    while (i >= 0) {
      i = value.lastIndexOf(char, i);
      if (i < 0) return -1;
      if (i === 0) return i;
      const prev = value[i - 1];
      if (/\s/.test(prev) || allowAfter.includes(prev)) return i;
      i--;
    }
    return -1;
  }

  function handleChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    const v = e.target.value;
    const caret = e.target.selectionStart ?? v.length;
    setText(v);
    resize();

    const beforeCaret = v.slice(0, caret);
    const at = findTriggerIndex(beforeCaret, "@", "/");
    const slash = findTriggerIndex(beforeCaret, "/");

    // When slash picker is open, typing @ anywhere switches to the file picker.
    if (slashOpen && beforeCaret.includes("@")) {
      const lastAt = beforeCaret.lastIndexOf("@");
      setPickerOpen(true);
      setPickerQuery(beforeCaret.slice(lastAt + 1));
      setSlashOpen(false);
    } else if (at >= 0 && (slash < 0 || at > slash)) {
      setPickerOpen(true);
      setPickerQuery(beforeCaret.slice(at + 1));
      setSlashOpen(false);
    } else if (slash >= 0) {
      setSlashOpen(true);
      setSlashQuery(beforeCaret.slice(slash + 1));
      setPickerOpen(false);
    } else {
      setPickerOpen(false);
      setSlashOpen(false);
    }
  }

  async function insertFile(name: string) {
    const at = findTriggerIndex(text, "@");
    if (at < 0) return;
    const before = text.slice(0, at);
    const after = text.slice(at + 1 + pickerQuery.length);
    setText(before + after);
    setPickerOpen(false);
    resize();
    textareaRef.current?.focus();

    // Bifurcate @ selections by file type and model vision support.
    // Image files on a vision model → visual channel (thumb via the sidecar
    // /api/attachment/thumb). Image files on a NON-vision model are BLOCKED
    // (not downgraded to a text reference): silently turning an image the user
    // expected the model to SEE into a mere filename invited the model to
    // hallucinate "我看了这张图". Surface a toast so the user knows why.
    // Non-image files always go through the text-reference path.
    if (isImageName(name)) {
      if (!supportsVision) {
        showToast("当前模型不支持图片输入，请在设置中切换视觉模型后再附加图片");
        return;
      }
      try {
        const thumb = await pathToDataUrl(name);
        addImages([
          {
            id: `ws-${Date.now()}-${name}`,
            name: name.split(/[\\/]/).pop() || name,
            mime: mimeForName(name),
            thumb,
            source: "workspace",
            rel: name,
          },
        ]);
      } catch {
        /* skip unreadable — no chip, no pending entry */
      }
    } else {
      addAttachments([name]);
    }
  }

  function insertSlash(item: SlashItem) {
    const slash = findTriggerIndex(text, "/");
    if (slash < 0) return;
    const before = text.slice(0, slash);
    const after = text.slice(slash + 1 + slashQuery.length);
    setText(before + after);
    setSlashItem(item);
    setSlashOpen(false);
    resize();
    textareaRef.current?.focus();
  }

  function buildMessage(): string {
    const trimmed = text.trim();
    const parts: string[] = [];

    if (attachments.length > 0) {
      const refs = attachments.map((p) => `- ${p}`).join("\n");
      if (!trimmed && !slashItem) return `请处理以下文件：\n${refs}`;
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
    const wire = useAttachmentStore.getState().toWire();
    const imageSnap = images.map((i) => ({ name: i.name, thumb: i.thumb }));
    send(msg, wire.length ? wire : undefined, imageSnap.length ? imageSnap : undefined);
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
    if (e.key === "Enter" && !e.shiftKey && !slashOpen) {
      e.preventDefault();
      doSend();
    }
  }

  async function onPaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    const items = Array.from(e.clipboardData?.items ?? []);
    const hasImage = items.some((it) => it.kind === "file" && it.type.startsWith("image/"));
    if (!hasImage) return; // plain-text paste — let the browser handle it.
    // Single-turn: only the initiating send carries images. While streaming,
    // paste is text-only — bail before touching the image chip store.
    if (streaming) return;
    if (!supportsVision) {
      // Don't silently swallow an image paste on a non-vision model — tell the
      // user why nothing was attached, so they don't think the model saw it.
      showToast("当前模型不支持图片输入，请在设置中切换视觉模型后再附加图片");
      return;
    }
    e.preventDefault();
    const next = await collectPastedImages(items as unknown as Parameters<typeof collectPastedImages>[0]);
    if (next.length) addImages(next);
  }

  // Window-level drag-drop (Tauri 2 native event). Only the webview receives
  // DOM drag events from outside; Tauri's onDragDropEvent covers OS-level drops
  // uniformly. Drag-over highlight is only shown when the payload contains an
  // image, and drops are ignored entirely when the active model lacks vision.
  useEffect(() => {
    const win = getCurrentWindow();
    let unlisten: (() => void) | undefined;
    let active = true;
    (async () => {
      unlisten = await win.onDragDropEvent(async (ev) => {
        const payload = ev.payload as { type: string; paths?: string[] };
        // Single-turn: drops while streaming would attach to the wrong (next)
        // turn, so ignore them — text appends remain allowed via the textarea.
        if (streaming) return;
        if (!supportsVision) {
          // Tell the user why their image drop did nothing (only for image
          // drops; non-image drops are also ignored but aren't worth a toast).
          if ((payload.paths ?? []).some((p) => isImageName(p))) {
            showToast("当前模型不支持图片输入，请在设置中切换视觉模型后再附加图片");
          }
          return;
        }
        if (payload.type === "enter" || payload.type === "over") {
          if ((payload.paths ?? []).some((p) => isImageName(p))) setDragOver(true);
        } else {
          setDragOver(false);
          if (payload.type === "drop") {
            const imgs = (payload.paths ?? []).filter((p) => isImageName(p));
            const next: ImageItem[] = [];
            for (const p of imgs) {
              try {
                const thumb = await pathToDataUrl(p);
                next.push({
                  id: `drop-${Date.now()}-${p}`,
                  name: p.split(/[\\/]/).pop() || p,
                  mime: mimeForName(p),
                  thumb,
                  source: "file",
                  absPath: p,
                });
              } catch {
                /* skip unreadable */
              }
            }
            if (next.length) addImages(next);
          }
        }
      });
      if (!active && unlisten) unlisten();
    })();
    return () => {
      active = false;
      if (unlisten) unlisten();
    };
  }, [supportsVision, streaming, addImages]);

  return (
    <div className="composer-wrap">
      <form className={dragOver ? "composer drag-over" : "composer"} onSubmit={submit}>
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
        {images.length > 0 && (
          <div className="composer-attachments">
            {images.map((im) => (
              <span key={im.id} className="image-chip" title={im.name}>
                <img className="image-thumb" src={im.thumb} alt={im.name} />
                <span className="attachment-name">{im.name}</span>
                <button
                  type="button"
                  className="attachment-remove"
                  onClick={() => removeImage(im.id)}
                  aria-label={`移除 ${im.name}`}
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
                onClick={() => {
                  setSlashItem(null);
                  textareaRef.current?.focus();
                }}
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
            inputRef={textareaRef}
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
          placeholder={
            streaming
              ? "追加指令到当前任务…"
              : "描述水文任务…用 @ 引用文件，用 / 选择 Skill 与 MCP 工具"
          }
          onChange={handleChange}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          autoFocus
          aria-label="任务输入"
        />
        <div className="composer-bottom">
          <div className="composer-context">
            <button
              className="ctx-pill"
              type="button"
              disabled={!current || streaming || !supportsVision}
              onClick={() => setFilePickerOpen(true)}
              title={
                !supportsVision
                  ? "当前模型不支持图片输入，请在设置中切换视觉模型"
                  : current
                    ? "引用工作区文件"
                    : "请先打开一个工作区"
              }
              aria-label="引用工作区文件"
            >
              ＋
            </button>
            <span className="ctx-pill model" title={modelName ?? "未配置模型"}>
              {modelName ?? "未配置模型"}
            </span>
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
        <div className="composer-meta-right">
          <button
            type="button"
            className="permission-mode-pill"
            onClick={() => setView("settings")}
            title="点击打开权限设置"
          >
            授权：{PERMISSION_MODE_LABELS[permissionMode]}
          </button>
          <span>Enter 发送，Shift+Enter 换行</span>
        </div>
      </div>

      {filePickerOpen && (
        <FilePickerModal
          onClose={() => setFilePickerOpen(false)}
          onConfirm={async (paths) => {
            // Task 10: the ＋ modal is only reachable when supportsVision is
            // true (the affordance is disabled otherwise), so every image in
            // the selection can be routed to the visual channel. Non-image
            // files keep the text-reference semantics they always had. On
            // thumb fetch failure we degrade the path to a text reference so
            // the user's selection is never silently dropped.
            for (const p of paths) {
              if (isImageName(p)) {
                if (!supportsVision) {
                  // Defense: the ＋ affordance is disabled on non-vision models,
                  // so this is unreachable in normal use — but if an image ever
                  // reaches here, block it (don't text-ref) + toast, matching
                  // the inline @ path.
                  showToast("当前模型不支持图片输入，请在设置中切换视觉模型后再附加图片");
                  continue;
                }
                try {
                  const thumb = await pathToDataUrl(p);
                  addImages([
                    {
                      id: `ws-${Date.now()}-${p}`,
                      name: p.split(/[\\/]/).pop() || p,
                      mime: mimeForName(p),
                      thumb,
                      source: "workspace",
                      rel: p,
                    },
                  ]);
                } catch {
                  addAttachments([p]);
                }
              } else {
                addAttachments([p]);
              }
            }
            setFilePickerOpen(false);
          }}
        />
      )}
    </div>
  );
}
