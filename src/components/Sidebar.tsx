import { useEffect } from "react";
import { useChatStore } from "../state/chat-store";
import { useWorkspaceStore } from "../state/workspace-store";
import Logo from "./Logo";

export default function Sidebar() {
  const current = useWorkspaceStore((s) => s.current);
  const recent = useWorkspaceStore((s) => s.recent);
  const load = useWorkspaceStore((s) => s.load);
  const pickAndOpen = useWorkspaceStore((s) => s.pickAndOpen);
  const openPath = useWorkspaceStore((s) => s.openPath);
  const reset = useChatStore((s) => s.reset);

  useEffect(() => {
    load();
  }, [load]);

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

      <div className="sidebar-section">
        <div className="sidebar-label">工作区</div>
        <button
          className={current ? "sidebar-item active" : "sidebar-item"}
          onClick={pickAndOpen}
          title={current?.path}
          type="button"
        >
          <span className="folder-icon">📁</span>
          <span className="item-name">{current ? current.name : "打开工作区…"}</span>
        </button>
      </div>

      {switchable.length > 0 && (
        <div className="sidebar-section">
          <div className="sidebar-label">最近</div>
          {switchable.map((r) => (
            <button
              key={r.path}
              className="sidebar-item"
              onClick={() => openPath(r.path)}
              title={r.path}
              type="button"
            >
              <span className="folder-icon">📁</span>
              <span className="item-name">{r.name}</span>
            </button>
          ))}
        </div>
      )}
    </aside>
  );
}
