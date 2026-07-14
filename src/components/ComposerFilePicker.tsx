import { useEffect, useState } from "react";
import { useWorkspaceStore, type FileEntry } from "../state/workspace-store";

export interface ComposerFilePickerProps {
  query: string;
  onSelect: (path: string) => void;
  onClose: () => void;
}

type FileEntryNode = FileEntry & { children?: FileEntryNode[] };

export default function ComposerFilePicker({
  query,
  onSelect,
  onClose,
}: ComposerFilePickerProps) {
  const current = useWorkspaceStore((s) => s.current);
  const listFiles = useWorkspaceStore((s) => s.listFiles);
  const [tree, setTree] = useState<FileEntryNode[]>([]);
  const [files, setFiles] = useState<string[]>([]);

  // Fetch the full workspace tree once when the picker opens or workspace changes.
  useEffect(() => {
    if (!current) {
      setTree([]);
      return;
    }
    let cancelled = false;

    async function buildTree(relPath: string): Promise<FileEntryNode[]> {
      const entries = await listFiles(relPath);
      const nodes: FileEntryNode[] = [];
      for (const e of entries || []) {
        const node: FileEntryNode = { ...e };
        if (e.type === "dir") {
          node.children = await buildTree(e.path);
        }
        nodes.push(node);
      }
      return nodes;
    }

    buildTree(".")
      .then((nodes) => {
        if (!cancelled) setTree(nodes);
      })
      .catch(() => {
        if (!cancelled) setTree([]);
      });
    return () => {
      cancelled = true;
    };
  }, [current, listFiles]);

  // Filter the cached tree locally as the query changes.
  useEffect(() => {
    function collectFiles(nodes: FileEntryNode[]): string[] {
      const paths: string[] = [];
      for (const n of nodes) {
        if (n.type === "file") paths.push(n.path);
        if (n.children) paths.push(...collectFiles(n.children));
      }
      return paths;
    }

    const allPaths = collectFiles(tree);
    const filtered = allPaths
      .filter((p) => p.toLowerCase().includes(query.toLowerCase()))
      .slice(0, 8);
    setFiles(filtered);
  }, [tree, query]);

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
