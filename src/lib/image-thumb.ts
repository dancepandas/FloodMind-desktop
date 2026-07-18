import { getBaseUrl } from "./sidecar-client";

const IMAGE_EXTS = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"];
export const isImageName = (name: string): boolean =>
  IMAGE_EXTS.some((e) => name.toLowerCase().endsWith(e));

export function mimeForName(name: string): string {
  const n = name.toLowerCase();
  if (n.endsWith(".jpg") || n.endsWith(".jpeg")) return "image/jpeg";
  if (n.endsWith(".png")) return "image/png";
  if (n.endsWith(".gif")) return "image/gif";
  if (n.endsWith(".webp")) return "image/webp";
  if (n.endsWith(".bmp")) return "image/bmp";
  return "image/png";
}

/** Clipboard File → data URL (bytes already in hand, no round-trip). */
export function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

/** Workspace-relative or absolute image path → data URL via sidecar thumb endpoint. */
export async function pathToDataUrl(path: string): Promise<string> {
  const b = await getBaseUrl();
  const r = await fetch(`${b}/api/attachment/thumb?path=${encodeURIComponent(path)}`);
  if (!r.ok) throw new Error(`缩略图获取失败 (${r.status})`);
  const { content, mime } = await r.json();
  return `data:${mime};base64,${content}`;
}
