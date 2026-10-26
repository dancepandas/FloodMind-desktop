import { getBaseUrl } from "./sidecar-client";

export interface PreviewDirEntry {
  name: string;
  type: "file" | "dir";
  path: string;
}

/** /api/workspace/file response — a file to preview, or a directory listing. */
export type PreviewData =
  | { kind: "file"; content: string; mime: string; previewable: boolean; path: string }
  | { kind: "dir"; path: string; entries: PreviewDirEntry[] };

export async function fetchFilePreview(relPath: string): Promise<PreviewData> {
  const base = await getBaseUrl();
  const r = await fetch(
    `${base}/api/workspace/file?path=${encodeURIComponent(relPath)}`,
  );
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}
