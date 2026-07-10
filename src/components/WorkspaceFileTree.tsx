import { useCallback, useEffect, useRef, useState } from "react";
import { Tree, type NodeApi, type TreeApi } from "react-arborist";
import { useWorkspaceStore, type FileEntry } from "../state/workspace-store";

type TreeNode = {
  id: string;
  name: string;
  type: "file" | "dir";
  children?: TreeNode[] | null;
};

function buildRoot(files: FileEntry[]): TreeNode[] {
  return files.map((f) => ({ id: f.path, name: f.name, type: f.type, children: f.type === "dir" ? [] : null }));
}

function Node({ node, style }: { node: NodeApi<TreeNode>; style: React.CSSProperties }) {
  const data = node.data;
  const isDir = data.type === "dir";
  return (
    <div className={`tree-node ${isDir ? "" : "tree-leaf"}`} style={style} tabIndex={0}>
      <span className="tree-node-icon">{isDir ? (node.isOpen ? "▾" : "▸") : " "}</span>
      <span className="tree-node-name">{data.name}</span>
    </div>
  );
}

export default function WorkspaceFileTree({ rootFiles }: { rootFiles: FileEntry[] }) {
  const listFiles = useWorkspaceStore((s) => s.listFiles);
  const treeRef = useRef<TreeApi<TreeNode>>(null);
  const [data, setData] = useState<TreeNode[]>(() => buildRoot(rootFiles));

  // Refresh when the root file list changes (workspace switch).
  useEffect(() => { setData(buildRoot(rootFiles)); }, [rootFiles]);

  const handleToggle = useCallback(
    async (id: string) => {
      const tree = treeRef.current;
      if (!tree) return;
      const node = tree.get(id);
      if (!node || node.data.type !== "dir" || node.data.children === null) return;
      if ((node.data.children?.length ?? 0) > 0) return;
      const files = await listFiles(node.data.id);
      const children = files.map((f) => ({
        id: f.path,
        name: f.name,
        type: f.type,
        children: f.type === "dir" ? [] : null,
      }));
      setData((prev) => replace(node.data.id, prev, children));
    },
    [listFiles],
  );

  return (
    <Tree<TreeNode>
      ref={treeRef}
      data={data}
      onToggle={handleToggle}
      width="100%"
      height={Math.max(180, Math.min(400, data.length * 24))}
      indent={14}
      rowHeight={24}
      disableDrag
      disableDrop
      disableEdit
      padding={0}
    >
      {Node}
    </Tree>
  );
}

/** Immutable replace: set `children` on the node at `targetId` within the tree. */
function replace(targetId: string, nodes: TreeNode[], children: TreeNode[]): TreeNode[] {
  return nodes.map((n) => {
    if (n.id === targetId) return { ...n, children };
    if (n.children) return { ...n, children: replace(targetId, n.children, children) };
    return n;
  });
}
