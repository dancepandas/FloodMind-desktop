import { useEffect, useState } from "react";
import { useWorkspaceStore } from "../state/workspace-store";
import { useAttachmentStore } from "../state/attachment-store";
import { uploadFilesToWorkspace } from "../lib/workspace-files";

export default function DropZone({ children }: { children: React.ReactNode }) {
  const current = useWorkspaceStore((s) => s.current);
  const addAttachments = useAttachmentStore((s) => s.add);
  const [dragOver, setDragOver] = useState(false);

  useEffect(() => {
    if (!current) return;

    let depth = 0;

    function handleDragEnter(e: DragEvent) {
      e.preventDefault();
      depth++;
      setDragOver(true);
    }

    function handleDragOver(e: DragEvent) {
      e.preventDefault();
    }

    function handleDragLeave(e: DragEvent) {
      e.preventDefault();
      depth--;
      if (depth <= 0) {
        depth = 0;
        setDragOver(false);
      }
    }

    async function handleDrop(e: DragEvent) {
      e.preventDefault();
      depth = 0;
      setDragOver(false);
      if (!current) return;
      const files = Array.from(e.dataTransfer?.files || []).filter((f) => !f.name.startsWith("."));
      if (files.length === 0) return;
      try {
        const paths = await uploadFilesToWorkspace(files);
        if (paths.length > 0) addAttachments(paths);
      } catch (err) {
        console.error("[drop] upload failed:", err);
      }
    }

    // Listen on window so the whole app surface accepts drops.
    window.addEventListener("dragenter", handleDragEnter);
    window.addEventListener("dragover", handleDragOver);
    window.addEventListener("dragleave", handleDragLeave);
    window.addEventListener("drop", handleDrop);

    return () => {
      window.removeEventListener("dragenter", handleDragEnter);
      window.removeEventListener("dragover", handleDragOver);
      window.removeEventListener("dragleave", handleDragLeave);
      window.removeEventListener("drop", handleDrop);
    };
  }, [current, addAttachments]);

  return (
    <div className={`drop-zone${dragOver ? " drag-over" : ""}`} aria-label="拖放文件到工作区">
      {children}
    </div>
  );
}
