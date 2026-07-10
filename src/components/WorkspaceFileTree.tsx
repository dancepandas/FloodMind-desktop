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

function buildRoot(files: FileEntry[]): TreeNode[] {
  return files.map((f) => ({ id: f.path, name: f.name, type: f.type, children: f.type === "dir" ? [] : null }));
}

function Node({ node, style }: { node: NodeApi<TreeNode>; style: React.CSSProperties }) {
  const data = node.data;
  const isDir = data.type === "dir";
  return (
    <div className={`tree-node ${isDir ? "" : "tree-leaf"}`} style={style} tabIndex={0}>
      <span className="tree-node-icon">
        <FileIcon fileName={data.name} isFolder={isDir} isExpanded={isDir && node.isOpen} size={16} />
      </span>
      <span className="tree-node-name">{data.name}</span>
    </div>
  );
}

export default function WorkspaceFileTree({ rootFiles }: { rootFiles: FileEntry[] }) {
  const listFiles = useWorkspaceStore((s) => s.listFiles);
  const treeRef = useRef<TreeApi<TreeNode>>(null);
  const [data, setData] = useState<TreeNode[]>(() => buildRoot(rootFiles));

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
      height={Math.max(200, Math.min(420, data.length * 28))}
      indent={16}
      rowHeight={28}
      disableDrag
      disableDrop
      disableEdit
      padding={0}
    >
      {Node}
    </Tree>
  );
}

function replace(targetId: string, nodes: TreeNode[], children: TreeNode[]): TreeNode[] {
  return nodes.map((n) => {
    if (n.id === targetId) return { ...n, children };
    if (n.children) return { ...n, children: replace(targetId, n.children, children) };
    return n;
  });
}
