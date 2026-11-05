import { invoke } from "@tauri-apps/api/core";

/**
 * Read Explorer-copied file paths (CF_HDROP) via the Rust command. Never throws
 * — a file paste is best-effort and must never break a normal text paste.
 */
export async function getClipboardFilePaths(): Promise<string[]> {
  try {
    const out = await invoke<string[]>("get_clipboard_file_paths");
    return Array.isArray(out) ? out.filter((p): p is string => typeof p === "string") : [];
  } catch {
    return [];
  }
}
