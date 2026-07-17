import { invoke } from "@tauri-apps/api/core";

export async function openFileInSystem(absPath: string): Promise<void> {
  await invoke("open_path", { path: absPath });
}

/** Open a URL (http/https/mailto) with the OS default handler. Reuses the
 *  `open_path` command, whose `open::that` routes mailto: to the mail client. */
export async function openUrl(url: string): Promise<void> {
  await invoke("open_path", { path: url });
}
