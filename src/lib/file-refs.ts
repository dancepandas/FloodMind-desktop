/**
 * Helpers for turning absolute filesystem paths into chat file references.
 * Shared by the Composer (paste/drop) and chat-store (wire `[引用文件]` block).
 */

/**
 * True when `text` looks like an absolute filesystem path (Windows drive letter
 * or UNC). A file copied in Explorer pastes as its path into the webview's
 * textarea — we turn that into a file reference instead of raw text.
 */
export function looksLikeFsPath(text: string): boolean {
  const t = text.trim();
  return /^[A-Za-z]:[\\/][^\\/:*?"<>|]/.test(t) || /^\\\\[^\\]+[\\/]/.test(t);
}

/**
 * Convert an absolute path into the reference form the chat expects: relative
 * to the workspace when it lives inside it (matching the @ picker), else the
 * absolute path as-is (external file).
 */
export function toFileRefPath(absPath: string, wsRoot?: string): string {
  if (!wsRoot) return absPath;
  const root = wsRoot.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  const p = absPath.replace(/\\/g, "/");
  const lower = p.toLowerCase();
  if (lower === root) return absPath;
  if (lower.startsWith(root + "/")) return p.slice(root.length).replace(/^\/+/, "");
  return absPath;
}
