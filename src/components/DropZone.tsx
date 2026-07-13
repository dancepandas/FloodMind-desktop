import { useState } from "react";
import { useWorkspaceStore } from "../state/workspace-store";
import { useAttachmentStore } from "../state/attachment-store";
import { uploadFilesToWorkspace } from "../lib/workspace-files";

export default function DropZone({ children }: { children: React.ReactNode }) {
  const current = useWorkspaceStore((s) => s.current);
  const addAttachments = useAttachmentStore((s) => s.add);
  const [dragOver, setDragOver] = useState(false);

  function handleDragOver(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(true);
  }

  function handleDragLeave(e: React.DragEvent) {
    e.preventDefault();
    // Only clear if leaving the container itself, not a child.
    if (!e.currentTarget.contains(e.relatedTarget as Node)) {
      setDragOver(false);
    }
  }

  async function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    if (!current) return;
    const files = Array.from(e.dataTransfer.files).filter((f) => !f.name.startsWith("."));
    if (files.length === 0) return;
    try {
      const paths = await uploadFilesToWorkspace(files);
      if (paths.length > 0) addAttachments(paths);
    } catch (err) {
      // Best-effort: log and ignore. A future improvement could surface a toast.
      console.error("[drop] upload failed:", err);
    }
  }

  return (
    <div
      className={`drop-zone${dragOver ? " drag-over" : ""}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      aria-label="拖放文件到工作区"
    >
      {children}
    </div>
  );
}
