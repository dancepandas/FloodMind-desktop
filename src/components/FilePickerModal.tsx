import { useEffect, useRef, useState } from "react";
import { FileOutlineIcon, FolderClosedIcon, FolderOpenIcon } from "./FileTreeIcons";
import { useWorkspaceStore, type FileEntry } from "../state/workspace-store";

type TreeNode = {
  id: string;
  name: string;
  type: "file" | "dir";
  children?: TreeNode[] | null;
  checked: boolean;
  indeterminate: boolean;
};

function buildTree(files: FileEntry[]): TreeNode[] {
  return files.map((f) => ({
    id: f.path,
    name: f.name,
    type: f.type,
    children: f.type === "dir" ? [] : null,
    checked: false,
    indeterminate: false,
  }));
}

interface FilePickerModalProps {
  onClose: () => void;
  onConfirm: (paths: string[]) => void;
}

export default function FilePickerModal({ onClose, onConfirm }: FilePickerModalProps) {
  const current = useWorkspaceStore((s) => s.current);
  const listFiles = useWorkspaceStore((s) => s.listFiles);
  const [nodes, setNodes] = useState<TreeNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!current) return;
    listFiles(".").then((files) => {
      setNodes(buildTree(files));
      setLoading(false);
    });
  }, [current, listFiles]);

  async function toggleDir(path: string) {
    const isExpanded = expanded.has(path);
    if (isExpanded) {
      setExpanded((prev) => {
        const next = new Set(prev);
        next.delete(path);
        return next;
      });
      return;
    }

    // Find the node and load children if empty.
    const target = findNode(nodes, path);
    if (target && target.type === "dir" && target.children && target.children.length === 0) {
      const files = await listFiles(path);
      setNodes((prev) => replaceChildren(prev, path, buildTree(files)));
    }
    setExpanded((prev) => new Set(prev).add(path));
  }

  function toggleFile(path: string) {
    setNodes((prev) => toggleNode(prev, path));
  }

  const selected = collectChecked(nodes);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card file-picker" onClick={(e) => e.stopPropagation()}>
        <div className="modal-title">引用工作区文件</div>
        {!current && <div className="cat-empty">请先打开一个工作区</div>}
        {current && loading && <div className="cat-empty">加载中…</div>}
        {current && !loading && (
          <>
            <div className="file-picker-tree">
              {nodes.length === 0 && <div className="cat-empty">工作区为空</div>}
              {nodes.map((n) => (
                <NodeRow
                  key={n.id}
                  node={n}
                  depth={0}
                  expanded={expanded}
                  onToggleDir={toggleDir}
                  onToggleFile={toggleFile}
                />
              ))}
            </div>
            <div className="file-picker-footer">
              <span className="file-picker-count">已选择 {selected.length} 个文件</span>
              <div className="modal-actions">
                <button className="btn-secondary" onClick={onClose} type="button">
                  取消
                </button>
                <button
                  className="btn-primary"
                  onClick={() => onConfirm(selected)}
                  disabled={selected.length === 0}
                  type="button"
                >
                  确认
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function NodeRow({
  node,
  depth,
  expanded,
  onToggleDir,
  onToggleFile,
}: {
  node: TreeNode;
  depth: number;
  expanded: Set<string>;
  onToggleDir: (path: string) => void;
  onToggleFile: (path: string) => void;
}) {
  const isExpanded = expanded.has(node.id);
  const icon =
    node.type === "dir" ? (
      isExpanded ? (
        <FolderOpenIcon size={16} />
      ) : (
        <FolderClosedIcon size={16} />
      )
    ) : (
      <FileOutlineIcon size={16} />
    );

  return (
    <div>
      <div
        className="file-picker-row"
        style={{ paddingLeft: `${12 + depth * 16}px` }}
        onClick={() => (node.type === "dir" ? onToggleDir(node.id) : onToggleFile(node.id))}
        role={node.type === "file" ? "button" : undefined}
        tabIndex={node.type === "file" ? 0 : undefined}
      >
        <input
          type="checkbox"
          checked={node.checked}
          ref={(el) => {
            if (el) el.indeterminate = node.indeterminate;
          }}
          onChange={() => onToggleFile(node.id)}
          onClick={(e) => e.stopPropagation()}
          disabled={node.type === "dir"}
          aria-label={node.name}
        />
        <span className="file-picker-icon">{icon}</span>
        <span className="file-picker-name">{node.name}</span>
      </div>
      {node.type === "dir" && isExpanded && node.children && (
        <div>
          {node.children.map((child) => (
            <NodeRow
              key={child.id}
              node={child}
              depth={depth + 1}
              expanded={expanded}
              onToggleDir={onToggleDir}
              onToggleFile={onToggleFile}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function findNode(nodes: TreeNode[], path: string): TreeNode | null {
  for (const n of nodes) {
    if (n.id === path) return n;
    if (n.children) {
      const found = findNode(n.children, path);
      if (found) return found;
    }
  }
  return null;
}

function replaceChildren(nodes: TreeNode[], path: string, children: TreeNode[]): TreeNode[] {
  return nodes.map((n) => {
    if (n.id === path) return { ...n, children };
    if (n.children) return { ...n, children: replaceChildren(n.children, path, children) };
    return n;
  });
}

function toggleNode(nodes: TreeNode[], path: string): TreeNode[] {
  return nodes.map((n) => {
    if (n.id === path && n.type === "file") {
      return { ...n, checked: !n.checked };
    }
    if (n.children) {
      const nextChildren = toggleNode(n.children, path);
      const checkedCount = nextChildren.filter((c) => c.checked).length;
      const allChecked = checkedCount === nextChildren.length && nextChildren.length > 0;
      const someChecked = checkedCount > 0;
      return {
        ...n,
        children: nextChildren,
        checked: allChecked,
        indeterminate: someChecked && !allChecked,
      };
    }
    return n;
  });
}

function collectChecked(nodes: TreeNode[]): string[] {
  const out: string[] = [];
  for (const n of nodes) {
    if (n.type === "file" && n.checked) out.push(n.id);
    if (n.children) out.push(...collectChecked(n.children));
  }
  return out;
}
