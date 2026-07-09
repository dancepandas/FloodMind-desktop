import { open } from "@tauri-apps/plugin-dialog";

/** Open the native folder picker; returns the chosen absolute path or null. */
export async function openFolderPicker(): Promise<string | null> {
  const selected = await open({ directory: true, multiple: false });
  if (!selected) return null;
  // multiple:false → string | null
  return typeof selected === "string" ? selected : null;
}
