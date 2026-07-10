import { useCallback, useEffect, useRef, useState } from "react";
import { Tree, type NodeApi, type TreeApi } from "react-arborist";
import { FileOutlineIcon, FolderClosedIcon, FolderOpenIcon } from "./FileTreeIcons";
import { useWorkspaceStore, type FileEntry } from "../state/workspace-store";

type TreeNode = {
  id: string;
  name: string;
  type: "file" | "dir";
  children?: TreeNode[] | null;
};

/** The workspace button in the sidebar already represents the root, so the
 *  tree only lists the files/folders directly under it. */
function buildTree(files: FileEntry[]): TreeNode[] {
  return files.map((f) => ({
    id: f.path,
    name: f.name,
    type: f.type,
    children: f.type === "dir" ? [] : null,
  }));
}

function Node({ node, style }: { node: NodeApi<TreeNode>; style: React.CSSProperties }) {
  const data = node.data;
  const isDir = data.type === "dir";
  const icon = isDir
    ? node.isOpen
      ? <FolderOpenIcon size={16} />
      : <FolderClosedIcon size={16} />
    : <FileOutlineIcon size={16} />;
  return (
    <div className={`tree-node ${isDir ? "" : "tree-leaf"}`} style={style} tabIndex={0}>
      <span className="tree-node-icon">{icon}</span>
      <span className="tree-node-name">{data.name}</span>
    </div>
  );
}

export default function WorkspaceFileTree({ rootFiles }: { rootFiles: FileEntry[] }) {
  const listFiles = useWorkspaceStore((s) => s.listFiles);
  const treeRef = useRef<TreeApi<TreeNode>>(null);
  const [data, setData] = useState<TreeNode[]>(() => buildTree(rootFiles));

  useEffect(() => {
    setData(buildTree(rootFiles));
  }, [rootFiles]);

  const handleToggle = useCallback(
    async (id: string) => {
      const tree = treeRef.current;
      if (!tree) return;
      const node = tree.get(id);
      if (!node || node.data.type !== "dir" || node.data.children === null) return;
      if ((node.data.children?.length ?? 0) > 0) return;
      const files = await listFiles(node.data.id);
      const children: TreeNode[] = files.map((f) => ({
        id: f.path,
        name: f.name,
        type: f.type,
        children: f.type === "dir" ? [] : null,
      }));
      setData((prev) => replace(node.data.id, prev, children));
    },
    [listFiles],
  );

  // Tight height cap so the bottom nav (Skills/MCP/Settings) is never pushed off-screen.
  const rows = data.length;
  const height = Math.max(60, Math.min(220, rows * 28));

  return (
    <div className="sidebar-tree">
      <Tree<TreeNode>
        ref={treeRef}
        data={data}
        onToggle={handleToggle}
        width="100%"
        height={height}
        indent={16}
        rowHeight={28}
        padding={0}
        disableDrag
        disableDrop
        disableEdit
      >
        {Node}
      </Tree>
    </div>
  );
}

function replace(targetId: string, nodes: TreeNode[], children: TreeNode[]): TreeNode[] {
  return nodes.map((n) => {
    if (n.id === targetId) return { ...n, children };
    if (n.children) return { ...n, children: replace(targetId, n.children, children) };
    return n;
  });
}
