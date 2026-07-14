import { getBaseUrl } from "./sidecar-client";

export async function fetchFilePreview(
  relPath: string,
): Promise<{ content: string; mime: string; previewable: boolean; path: string }> {
  const base = await getBaseUrl();
  const r = await fetch(
    `${base}/api/workspace/file?path=${encodeURIComponent(relPath)}`,
  );
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}
