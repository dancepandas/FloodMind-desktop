import { useCallback, useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useChatStore } from "../state/chat-store";
import { useWorkspaceStore } from "../state/workspace-store";
import { useConfigStore, type PermissionMode, type WorkMode } from "../state/config-store";
import { useUiStore } from "../state/ui-store";
import { useAttachmentStore, type ImageItem } from "../state/attachment-store";
import { useBackgroundTaskStore, runningCount } from "../state/background-task-store";
import { fileToDataUrl, isImageName, mimeForName, pathToDataUrl } from "../lib/image-thumb";
import { getClipboardFilePaths } from "../lib/clipboard";
import { partitionPaths, registerExternalPaths } from "../lib/external-paths";
import { looksLikeFsPath, toFileRefPath } from "../lib/file-refs";

// Re-export the path helpers so existing imports (incl. tests) keep working.
export { looksLikeFsPath, toFileRefPath } from "../lib/file-refs";
import FilePickerModal from "./FilePickerModal";
import ComposerFilePicker from "./ComposerFilePicker";
import SlashPicker, { type SlashItem } from "./SlashPicker";
import ModelPicker from "./ModelPicker";
import ContextRing from "./ContextRing";

const PERMISSION_MODE_LABELS: Record<PermissionMode, string> = {
  "always-trust": "完全信任",
  "trust-once": "首次询问",
  "always-ask": "每次都问",
};

/** 点击授权 pill 时循环的顺序：首次询问 → 每次都问 → 完全信任（需确认）→ 回到首次询问。 */
const PERMISSION_CYCLE: PermissionMode[] = ["trust-once", "always-ask", "always-trust"];

const WORK_MODE_ORDER: WorkMode[] = ["craft", "ask", "plan"];
const WORK_MODE_LABELS: Record<WorkMode, string> = {
  craft: "执行",
  ask: "问答",
  plan: "计划",
};
const WORK_MODE_TOOLTIPS: Record<WorkMode, string> = {
  craft: "执行模式：直接使用工具完成任务",
  ask: "问答模式：只回答，不调用任何工具",
  plan: "计划模式：先制定计划，确认后执行",
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
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [slashOpen, setSlashOpen] = useState(false);
  const [slashQuery, setSlashQuery] = useState("");
  const [filePickerOpen, setFilePickerOpen] = useState(false);
  const [trustToggleOpen, setTrustToggleOpen] = useState(false);
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
  const savePermissions = useConfigStore((s) => s.savePermissions);
  const workMode = useConfigStore((s) => s.workMode);
  const saveWorkMode = useConfigStore((s) => s.saveWorkMode);
  const modelName = useConfigStore((s) => s.model?.model ?? null);
  const supportsVision = useConfigStore((s) => !!s.model?.supportsVision);
  const switchActive = useConfigStore((s) => s.switchActive);
  const setView = useUiStore((s) => s.setView);
  const showToast = useUiStore((s) => s.showToast);
  const setPreviewPath = useUiStore((s) => s.setPreviewPath);
  const openLightbox = useUiStore((s) => s.openLightbox);
  const attachments = useAttachmentStore((s) => s.pending);
  const bgRunning = useBackgroundTaskStore((s) => runningCount(s.tasks));
  const setBgPanelOpen = useBackgroundTaskStore((s) => s.setPanelOpen);
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

    // File refs are now passed as structured `attachments` on the user turn
    // (see doSend below → chat-store.send's fileRefs param). chat-store
    // appends the [引用文件] block to the wire text so the LLM still sees the
    // same prompt. We only need a placeholder here so doSend doesn't bail
    // when the user attaches files/images without typing any text.
    if (slashItem) {
      const instruction =
        slashItem.kind === "skill"
          ? `请使用 ${slashItem.name} skill`
          : `请使用 ${slashItem.name} MCP工具`;
      parts.push(instruction);
    }

    if (!trimmed && parts.length === 0) {
      if (attachments.length > 0) return "请处理以下文件：";
      if (images.length > 0) return "请看附图：";
      return "";
    }
    if (!trimmed) return parts.join("\n\n");
    if (parts.length === 0) return trimmed;
    return `${trimmed}\n\n${parts.join("\n\n")}`;
  }

  function doSend() {
    const msg = buildMessage();
    if (!msg) return;
    const wire = useAttachmentStore.getState().toWire();
    // File refs go in as structured `attachments` on the user turn (rendered
    // as clickable chips in the bubble) AND are appended to the wire text by
    // chat-store so the LLM still sees the [引用文件] prompt.
    const pendingPaths = useAttachmentStore.getState().pending;
    const fileRefs = pendingPaths.map((p) => ({
      path: p,
      name: p.split(/[\\/]/).pop() || p,
    }));
    const imageSnap = images.map((i) => ({ name: i.name, thumb: i.thumb }));
    send(
      msg,
      wire.length ? wire : undefined,
      imageSnap.length ? imageSnap : undefined,
      fileRefs.length ? fileRefs : undefined,
      workMode,
    );
    setText("");
    setSlashItem(null);
    clearAttachments();
    if (textareaRef.current) textareaRef.current.style.height = "auto";
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    doSend();
  }

  /** 授权 pill 点击：循环切换模式；切到「完全信任」先弹确认框。 */
  function onTogglePermission() {
    const idx = PERMISSION_CYCLE.indexOf(permissionMode);
    const next = PERMISSION_CYCLE[(idx + 1) % PERMISSION_CYCLE.length];
    if (next === "always-trust") {
      setTrustToggleOpen(true);
      return;
    }
    savePermissions(next);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey && !slashOpen) {
      e.preventDefault();
      doSend();
    }
  }

  async function onPaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    const items = Array.from(e.clipboardData?.items ?? []);
    const imageItems = items.filter((it) => it.kind === "file" && it.type.startsWith("image/"));
    const types = e.clipboardData?.types ?? [];
    const plain = (() => {
      try {
        return e.clipboardData?.getData("text/plain") ?? "";
      } catch {
        return "";
      }
    })();
    // A file copied in Explorer renders as its path text in a webview textarea;
    // turn path-looking text (and any File.path the platform exposes) into file
    // references rather than dumping the path into the message.
    const refs: string[] = [];
    if (plain) {
      for (const line of plain.split(/\r?\n/)) {
        if (looksLikeFsPath(line)) refs.push(line.trim());
      }
    }
    for (const it of items) {
      if (it.kind !== "file" || it.type.startsWith("image/")) continue;
      const f = it.getAsFile() as (File & { path?: string }) | null;
      if (f?.path) refs.push(f.path);
    }
    // A text paste that MIXES a path with prose is not a file paste — let the
    // browser insert the whole text (the path stays as text) instead of
    // silently dropping the prose. Only pure-path text counts as a file paste.
    const nonEmptyPlainLines = plain.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (nonEmptyPlainLines.length > 0 && !nonEmptyPlainLines.every((l) => looksLikeFsPath(l))) return;
    const hasRefs = refs.length > 0;
    const hasText = plain.trim().length > 0;
    // Browser should handle: pure prose, or only non-file rich content (HTML).
    // Returning here means a normal text paste is never delayed or swallowed.
    const browserHandles = hasText || (types.length > 0 && !types.includes("Files"));
    if (!hasRefs && imageItems.length === 0 && browserHandles) return;
    if (streaming) return; // single-turn: pastes only attach to the initiating send
    e.preventDefault();
    // Copying files puts CF_HDROP on the clipboard: the WebView exposes a "Files"
    // type (or nothing) with no usable File.path, so ask Rust for the complete
    // list and merge it — a multi-file copy isn't truncated to whatever paths
    // WebView2 happened to render as text.
    const looksLikeFilePaste =
      imageItems.length === 0 && (types.includes("Files") || types.length === 0);
    let paths = Array.from(new Set(refs));
    if (looksLikeFilePaste) {
      const clipPaths = await getClipboardFilePaths();
      if (clipPaths.length) paths = Array.from(new Set([...paths, ...clipPaths]));
    }
    if (paths.length) await attachPaths(paths);
    if (imageItems.length === 0) return;
    if (!supportsVision) {
      // Only toast when the paste was purely images (a mixed paste already
      // added the file refs above).
      if (!hasRefs) showToast("当前模型不支持图片输入，请在设置中切换视觉模型后再附加图片");
      return;
    }
    const next = await collectPastedImages(items as unknown as Parameters<typeof collectPastedImages>[0]);
    if (next.length) addImages(next);
  }

  /**
   * Attach absolute file paths dropped/pasted into the composer. Paths OUTSIDE
   * the workspace are registered (per-workspace) so the agent's later Read of
   * them triggers the permission ASK instead of a hard "不在允许目录内" — the
   * read-time authorization flow. Internal paths become workspace-relative refs;
   * external stay absolute. Images route to the visual channel (needs a vision
   * model); other files become file references.
   */
  const attachPaths = useCallback(
    async (absPaths: string[]) => {
      if (!absPaths.length) return;
      const { outside } = partitionPaths(absPaths, current?.path);
      if (outside.length) {
        // Register BEFORE the chips appear, so a fast Enter can never send a
        // message referencing a file the agent can't read (the registration
        // keys to the current workspace and takes effect on the next stream's
        // _set_workspace). Local 127.0.0.1 fetch — typically a few ms. A
        // failure only means the file may still be unreadable; never fails the
        // drop/paste itself.
        await registerExternalPaths(outside).catch(() =>
          showToast("外部文件授权注册失败：该文件可能无法读取"),
        );
      }
      const imgs = absPaths.filter((p) => isImageName(p));
      const files = absPaths.filter((p) => !isImageName(p));
      if (imgs.length > 0) {
        if (!supportsVision) {
          showToast("当前模型不支持图片输入，请在设置中切换视觉模型后再附加图片");
        } else {
          const next: ImageItem[] = [];
          for (const p of imgs) {
            try {
              const thumb = await pathToDataUrl(p);
              next.push({
                id: `attach-${Date.now()}-${p}`,
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
      if (files.length > 0) {
        addAttachments(files.map((p) => toFileRefPath(p, current?.path)));
      }
    },
    [current, supportsVision, addImages, addAttachments, showToast],
  );

  // Window-level drag-drop (Tauri 2 native event). Only the webview receives
  // DOM drag events from outside; Tauri's onDragDropEvent covers OS-level drops
  // uniformly. Images route to the visual channel (needs a vision model); any
  // other file becomes a file reference — the drag-over highlight shows for any
  // file payload.
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
        const paths = payload.paths ?? [];
        if (payload.type === "enter" || payload.type === "over") {
          if (paths.length > 0) setDragOver(true);
          return;
        }
        setDragOver(false);
        if (payload.type !== "drop") return;
        await attachPaths(paths);
      });
      if (!active && unlisten) unlisten();
    })();
    return () => {
      active = false;
      if (unlisten) unlisten();
    };
  }, [streaming, attachPaths]);

  return (
    <div className="composer-wrap">
      <form className={dragOver ? "composer drag-over" : "composer"} onSubmit={submit}>
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
        {(attachments.length > 0 || images.length > 0) && (
          <div className="composer-attach-row">
            {attachments.map((p) => (
              <span key={p} className="attachment-pill" title={p}>
                <button
                  type="button"
                  className="attachment-preview"
                  onClick={() => setPreviewPath(p)}
                  aria-label={`预览 ${p}`}
                >
                  <span className="attachment-icon" aria-hidden="true">📄</span>
                  <span className="attachment-name">{p.split(/[\\/]/).pop() || p}</span>
                  {looksLikeFsPath(p) && (
                    <span className="attachment-badge-external">外部</span>
                  )}
                </button>
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
            {images.map((im) => (
              <span key={im.id} className="image-chip" title={im.name}>
                <button
                  type="button"
                  className="image-thumb-btn"
                  onClick={() => openLightbox({ src: im.thumb, name: im.name })}
                  aria-label={`预览 ${im.name}`}
                >
                  <img className="image-thumb" src={im.thumb} alt={im.name} />
                </button>
                <button
                  type="button"
                  className="attachment-remove image-remove"
                  onClick={() => removeImage(im.id)}
                  aria-label={`移除 ${im.name}`}
                >
                  ✕
                </button>
              </span>
            ))}
          </div>
        )}
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
            <div className="model-pill-wrap">
              <button
                className="ctx-pill model"
                type="button"
                onClick={() => setModelPickerOpen((v) => !v)}
                // ModelPicker closes on any mousedown OUTSIDE its container (a
                // document-level listener). Because mousedown fires before click,
                // the same pointer that opens the picker would otherwise be seen
                // as an "outside" mousedown and re-close it (open-then-close).
                // Stopping propagation on the trigger's mousedown keeps it from
                // reaching that listener. (T5 review note, option a.)
                onMouseDown={(e) => e.stopPropagation()}
                disabled={streaming}
                title={modelName ?? "未配置模型"}
                aria-haspopup="listbox"
                aria-expanded={modelPickerOpen}
              >
                {modelName ?? "未配置模型"} ▾
              </button>
              {modelPickerOpen && (
                <ModelPicker
                  onPick={async (p, m) => {
                    // Per-conversation binding: chat-store holds the active conv
                    // id as `conversationId` (string | null). switchActive uses
                    // it to PUT /api/conversations/:id/model; null = global only.
                    const convId = useChatStore.getState().conversationId ?? undefined;
                    const ok = await switchActive(p, m, convId);
                    setModelPickerOpen(false);
                    if (!ok) showToast("模型切换失败，已恢复");
                  }}
                  onClose={() => setModelPickerOpen(false)}
                />
              )}
            </div>
          </div>
          <div className="composer-actions">
            <ContextRing />
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
        {bgRunning > 0 && (
          <button
            type="button"
            className="bg-shell-pill"
            onClick={() => setBgPanelOpen(true)}
            title="查看后台任务"
            aria-label={`${bgRunning} 个后台任务运行中`}
          >
            <span className="bg-shell-dot" aria-hidden="true" />
            shell{bgRunning > 1 ? ` (${bgRunning})` : ""}
          </button>
        )}
        <div className="mode-seg" role="group" aria-label="工作模式">
          {WORK_MODE_ORDER.map((m) => (
            <button
              key={m}
              type="button"
              className={`mode-seg-btn${workMode === m ? " active" : ""}`}
              onClick={() => saveWorkMode(m)}
              title={WORK_MODE_TOOLTIPS[m]}
              aria-pressed={workMode === m}
              disabled={streaming}
            >
              {WORK_MODE_LABELS[m]}
            </button>
          ))}
        </div>
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
            onClick={onTogglePermission}
            title="点击切换授权模式（首次询问 → 每次都问 → 完全信任）"
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

      {trustToggleOpen && (
        <div className="modal-overlay" onClick={() => setTrustToggleOpen(false)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="modal-title" style={{ color: "var(--red)" }}>⚠️ 切换到「完全信任」模式？</div>
            <div style={{ fontSize: "13px", lineHeight: "1.6", color: "var(--fg-secondary)" }}>
              <p><strong>此模式非常危险：</strong>所有工具调用（含 Bash、文件写删、网络请求）将自动执行，<strong>不再弹出任何授权提示</strong>。智能体可能因误导/恶意/错误指令直接执行危险操作。</p>
              <p><strong>确定要切换吗？</strong></p>
            </div>
            <div className="modal-actions">
              <button
                className="btn-secondary"
                type="button"
                onClick={() => setTrustToggleOpen(false)}
              >
                取消
              </button>
              <button
                className="btn-primary"
                type="button"
                style={{ background: "var(--red)" }}
                onClick={() => {
                  setTrustToggleOpen(false);
                  savePermissions("always-trust");
                }}
              >
                确认切换
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
