import { useEffect, useState } from "react";
import { useWorkspaceStore, type FileEntry } from "../state/workspace-store";

export interface ComposerFilePickerProps {
  query: string;
  onSelect: (path: string) => void;
  onClose: () => void;
}

export default function ComposerFilePicker({
  query,
  onSelect,
  onClose,
}: ComposerFilePickerProps) {
  const current = useWorkspaceStore((s) => s.current);
  const listFiles = useWorkspaceStore((s) => s.listFiles);
  const [files, setFiles] = useState<string[]>([]);

  useEffect(() => {
    if (!current) {
      setFiles([]);
      return;
    }
    let cancelled = false;
    listFiles(".")
      .then((entries) => {
        if (cancelled) return;
        const names = (entries || [])
          .filter((e: FileEntry) => e.type === "file")
          .map((e: FileEntry) => e.name)
          .filter((n) => n.toLowerCase().includes(query.toLowerCase()))
          .slice(0, 8);
        setFiles(names);
      })
      .catch(() => {
        if (!cancelled) setFiles([]);
      });
    return () => {
      cancelled = true;
    };
  }, [current, query, listFiles]);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  if (!current) return null;

  return (
    <div className="composer-picker" role="listbox" aria-label="文件选择">
      {files.length === 0 && (
        <div className="composer-picker-empty">无匹配文件</div>
      )}
      {files.map((f) => (
        <button
          key={f}
          className="composer-picker-row"
          onClick={() => onSelect(f)}
          type="button"
          role="option"
        >
          {f}
        </button>
      ))}
    </div>
  );
}
