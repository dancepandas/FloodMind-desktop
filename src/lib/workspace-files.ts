import { getBaseUrl } from "./sidecar-client";

export async function uploadFilesToWorkspace(files: File[]): Promise<string[]> {
  const b = await getBaseUrl();

  const payload = await Promise.all(
    files.map(
      (file) =>
        new Promise<{ path: string; content: string }>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => {
            const dataUrl = reader.result as string;
            const base64 = dataUrl.split(",")[1] || "";
            resolve({ path: file.name, content: base64 });
          };
          reader.onerror = reject;
          reader.readAsDataURL(file);
        })
    )
  );

  const r = await fetch(`${b}/api/workspace/files`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ files: payload }),
  });
  if (!r.ok) {
    const err = await r.text().catch(() => "upload failed");
    throw new Error(err);
  }
  const data = await r.json();
  return (data.files || []) as string[];
}
