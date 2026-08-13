import { invoke } from "@tauri-apps/api/core";

export async function getBaseUrl(): Promise<string> {
  // Dev/screenshot override: when running the web build in a plain browser
  // (no Tauri shell), `invoke` is unavailable — use the env-provided sidecar
  // URL so Playwright can screenshot a data-backed UI. Production (Tauri)
  // has no such env and keeps going through invoke.
  const override = (import.meta as any).env?.VITE_SIDECAR_URL as string | undefined;
  if (override) return override;
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
