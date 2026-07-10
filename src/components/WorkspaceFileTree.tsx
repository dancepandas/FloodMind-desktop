import { useCallback, useEffect, useRef, useState } from "react";
import { Tree, type NodeApi, type TreeApi } from "react-arborist";
import { FileIcon } from "react-material-vscode-icons";
import { useWorkspaceStore, type FileEntry } from "../state/workspace-store";

type TreeNode = {
  id: string;
  name: string;
  type: "file" | "dir";
  children?: TreeNode[] | null;
};

/** Build a single root node for the workspace, pre-expanded, so the tree
 *  has clear hierarchy: workspace root -> files and folders. */
function buildTree(name: string, files: FileEntry[]): TreeNode[] {
  return [
    {
      id: ".",
      name,
      type: "dir",
      children: files.map((f) => ({
        id: f.path,
        name: f.name,
        type: f.type,
        children: f.type === "dir" ? [] : null,
      })),
    },
  ];
}

function Node({ node, style }: { node: NodeApi<TreeNode>; style: React.CSSProperties }) {
  const data = node.data;
  const isDir = data.type === "dir";
  const isRoot = node.isRoot;
  return (
    <div
      className={`tree-node ${isDir ? "" : "tree-leaf"} ${isRoot ? "tree-root-node" : ""}`}
      style={style}
      tabIndex={0}
    >
      <span className="tree-node-icon">
        <FileIcon fileName={data.name} isFolder={isDir} isExpanded={isDir && node.isOpen} size={16} />
      </span>
      <span className="tree-node-name">{data.name}</span>
    </div>
  );
}

export default function WorkspaceFileTree({
  rootFiles,
  workspaceName,
}: {
  rootFiles: FileEntry[];
  workspaceName: string;
}) {
  const listFiles = useWorkspaceStore((s) => s.listFiles);
  const treeRef = useRef<TreeApi<TreeNode>>(null);
  const [data, setData] = useState<TreeNode[]>(() => buildTree(workspaceName, rootFiles));

  useEffect(() => {
    setData(buildTree(workspaceName, rootFiles));
  }, [rootFiles, workspaceName]);

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

  // Tree rows × rowHeight gives the content height; cap tight so the bottom nav
  // (Skills/MCP/Settings) is never pushed off-screen.
  const rows = data.reduce((n, d) => n + 1 + (d.children?.length ?? 0), 0);
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
        initialOpenState={{ ".": true }}
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
