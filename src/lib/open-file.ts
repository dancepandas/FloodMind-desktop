import { invoke } from "@tauri-apps/api/core";

export async function openFileInSystem(absPath: string): Promise<void> {
  await invoke("open_path", { path: absPath });
}
