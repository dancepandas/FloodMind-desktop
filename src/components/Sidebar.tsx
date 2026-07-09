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
  // Switching workspace rebuilds the agent's memory; refuse while a stream is
  // live so we never rebind out from under a running turn. (New Session aborts
  // the stream itself, so it stays enabled.)
  const streaming = useChatStore((s) => s.streaming);

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
          title={streaming ? "生成中，请稍候再切换工作区" : current?.path}
          type="button"
          disabled={streaming}
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
    </aside>
  );
}
