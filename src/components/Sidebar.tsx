import { useEffect, useState } from "react";
import { useChatStore } from "../state/chat-store";
import { useUiStore, type View } from "../state/ui-store";
import { useWorkspaceStore, type FileEntry } from "../state/workspace-store";
import Logo from "./Logo";

const NAV: { view: View; label: string }[] = [
  { view: "skills", label: "Skills" },
  { view: "mcp", label: "MCP" },
  { view: "settings", label: "设置" },
];

/* ── lazy file tree ──────────────────────────────────────── */
function TreeEntry({ entry }: { entry: FileEntry }) {
  const listFiles = useWorkspaceStore((s) => s.listFiles);
  const [expanded, setExpanded] = useState(false);
  const [children, setChildren] = useState<FileEntry[] | null>(null);
  const isDir = entry.type === "dir";

  async function toggle() {
    if (!isDir) return;
    if (!expanded) {
      if (!children) {
        const c = await listFiles(entry.path);
        setChildren(c);
      }
      setExpanded(true);
    } else {
      setExpanded(false);
    }
  }

  return (
    <li>
      <button className="tree-entry" onClick={toggle} title={entry.path} type="button">
        <span className="tree-caret">{isDir ? (expanded ? "▾" : "▸") : " "}</span>
        <span className="tree-name">{isDir ? `${entry.name}/` : entry.name}</span>
      </button>
      {isDir && expanded && children && children.length > 0 && (
        <ul className="tree-children">
          {children.map((c) => (
            <TreeEntry key={c.path} entry={c} />
          ))}
        </ul>
      )}
      {isDir && expanded && children && children.length === 0 && (
        <div className="tree-empty">（空）</div>
      )}
    </li>
  );
}

/* ── Sidebar ──────────────────────────────────────────────── */
export default function Sidebar() {
  const current = useWorkspaceStore((s) => s.current);
  const recent = useWorkspaceStore((s) => s.recent);
  const load = useWorkspaceStore((s) => s.load);
  const pickAndOpen = useWorkspaceStore((s) => s.pickAndOpen);
  const openPath = useWorkspaceStore((s) => s.openPath);
  const listFiles = useWorkspaceStore((s) => s.listFiles);
  const reset = useChatStore((s) => s.reset);
  const streaming = useChatStore((s) => s.streaming);
  const view = useUiStore((s) => s.view);
  const setView = useUiStore((s) => s.setView);

  // root entries for the workspace file tree
  const [rootFiles, setRootFiles] = useState<FileEntry[] | null>(null);

  useEffect(() => {
    load();
  }, [load]);

  // reload the file tree whenever the workspace changes
  useEffect(() => {
    if (current) {
      listFiles(".").then(setRootFiles);
    } else {
      setRootFiles(null);
    }
  }, [current?.path]);

  const switchable = recent.filter((r) => !current || r.path !== current.path);

  return (
    <aside className="sidebar">
      <div className="sidebar-brand">
        <Logo className="sidebar-logo" />
        FloodMind
      </div>

      <button className="new-thread" onClick={reset} type="button">
        <span>＋</span>
        新会话
      </button>

      {/* 最近 — above 工作区 per user preference */}
      {switchable.length > 0 && (
        <div className="sidebar-section">
          <div className="sidebar-label">最近</div>
          {switchable.map((r) => (
            <button
              key={r.path}
              className="sidebar-item"
              onClick={() => openPath(r.path)}
              title={streaming ? "生成中，请稍候再切换工作区" : r.path}
              type="button"
              disabled={streaming}
            >
              <span className="folder-icon">📁</span>
              <span className="item-name">{r.name}</span>
            </button>
          ))}
        </div>
      )}

      <div className="sidebar-section">
        <div className="sidebar-label">工作区</div>
        <button
          className={current ? "sidebar-item active" : "sidebar-item"}
          onClick={pickAndOpen}
          title={streaming ? "生成中，请稍候再切换工作区" : current?.path}
          type="button"
          disabled={streaming}
        >
          <span className="folder-icon">📁</span>
          <span className="item-name">{current ? current.name : "打开工作区…"}</span>
        </button>

        {/* file tree under the workspace */}
        {current && rootFiles && rootFiles.length > 0 && (
          <ul className="tree-root">
            {rootFiles.map((f) => (
              <TreeEntry key={f.path} entry={f} />
            ))}
          </ul>
        )}
        {current && rootFiles && rootFiles.length === 0 && (
          <div className="tree-empty">工作区为空</div>
        )}
      </div>

      <div className="sidebar-spacer" />
      <div className="sidebar-section sidebar-nav">
        {NAV.map((n) => (
          <button
            key={n.view}
            className={view === n.view ? "sidebar-item active" : "sidebar-item"}
            onClick={() => setView(n.view)}
            type="button"
          >
            <span className="item-name">{n.label}</span>
          </button>
        ))}
      </div>
    </aside>
  );
}
