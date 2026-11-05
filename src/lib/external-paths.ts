import { getBaseUrl } from "./sidecar-client";

export interface PartitionedPaths {
  inside: string[];
  outside: string[];
}

function normalize(p?: string): string {
  if (!p) return "";
  return p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

/**
 * Pure: split absolute paths into workspace-internal vs external. Mirrors
 * `toFileRefPath`'s normalization (forward slashes, trailing slash stripped,
 * lowercased) so the partition agrees with how refs are relativized.
 */
export function partitionPaths(paths: string[], wsRoot?: string): PartitionedPaths {
  const root = normalize(wsRoot);
  const inside: string[] = [];
  const outside: string[] = [];
  for (const p of paths) {
    const norm = normalize(p);
    if (root && (norm === root || norm.startsWith(root + "/"))) inside.push(p);
    else outside.push(p);
  }
  return { inside, outside };
}

export async function listExternalPaths(): Promise<string[]> {
  const b = await getBaseUrl();
  const r = await fetch(`${b}/api/external-paths`);
  if (!r.ok) throw new Error(`list external paths failed: ${r.status}`);
  const body = await r.json();
  return Array.isArray(body?.paths) ? body.paths : [];
}

export async function registerExternalPaths(paths: string[]): Promise<string[]> {
  const b = await getBaseUrl();
  const r = await fetch(`${b}/api/external-paths`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ paths }),
  });
  if (!r.ok) throw new Error(`register external paths failed: ${r.status}`);
  const body = await r.json();
  return Array.isArray(body?.paths) ? body.paths : [];
}

export async function removeExternalPath(path: string): Promise<string[]> {
  const b = await getBaseUrl();
  const r = await fetch(`${b}/api/external-paths`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path }),
  });
  if (!r.ok) throw new Error(`remove external path failed: ${r.status}`);
  const body = await r.json();
  return Array.isArray(body?.paths) ? body.paths : [];
}
