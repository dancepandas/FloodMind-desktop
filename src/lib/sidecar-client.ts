import { invoke } from "@tauri-apps/api/core";

export async function getBaseUrl(): Promise<string> {
  return invoke<string>("get_sidecar_base_url");
}

export async function checkHealth(baseUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/api/health`);
    if (!res.ok) return false;
    const body = await res.json();
    return body?.status === "ok";
  } catch {
    return false;
  }
}
