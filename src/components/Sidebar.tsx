import { useEffect, useMemo, useState } from "react";
import { useChatStore } from "../state/chat-store";
import { useConversationStore, type ConvSummary } from "../state/conversation-store";
import { useUiStore, type View } from "../state/ui-store";
import { useWorkspaceStore, type WorkspaceSummary } from "../state/workspace-store";
import Logo from "./Logo";

const NAV: { view: View; label: string; icon: string }[] = [
  { view: "chat", label: "新建任务", icon: "＋" },
  { view: "chat", label: "对话", icon: "◇" },
  { view: "skills", label: "技能", icon: "⚡" },
  { view: "mcp", label: "连接器", icon: "🔌" },
  { view: "tasks", label: "自动化", icon: "⏱" },
  { view: "settings", label: "设置", icon: "⚙" },
];

function getWorkspaceConversations(
  byWorkspace: Record<string, ConvSummary[]>,
  path: string
): ConvSummary[] {
  return byWorkspace[path] ?? [];
}

export default function Sidebar() {
  const current = useWorkspaceStore((s) => s.current);
  const recent = useWorkspaceStore((s) => s.recent);
  const load = useWorkspaceStore((s) => s.load);
  const openPath = useWorkspaceStore((s) => s.openPath);
  const pickAndOpen = useWorkspaceStore((s) => s.pickAndOpen);

  const streaming = useChatStore((s) => s.streaming);
  const conversationId = useChatStore((s) => s.conversationId);
  const startNew = useChatStore((s) => s.startNew);
  const loadConversation = useChatStore((s) => s.loadConversation);

  const byWorkspace = useConversationStore((s) => s.byWorkspace);
  const loadWorkspaceConversations = useConversationStore((s) => s.loadWorkspaceConversations);
  const removeConv = useConversationStore((s) => s.remove);

  const view = useUiStore((s) => s.view);
  const setView = useUiStore((s) => s.setView);

  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  useEffect(() => {
    load();
  }, [load]);

  const workspaces = useMemo<WorkspaceSummary[]>(() => {
    const out: WorkspaceSummary[] = current ? [current] : [];
    for (const ws of recent) {
      if (current && ws.path === current.path) continue;
      out.push(ws);
    }
    return out;
  }, [current, recent]);

  const handleNavClick = (item: (typeof NAV)[number]) => {
    if (item.label === "新建任务") {
      if (current) startNew(current.path);
      setView("chat");
      return;
    }
    setView(item.view);
  };

  const toggleWorkspace = (ws: WorkspaceSummary) => {
    const next = new Set(expanded);
    if (next.has(ws.path)) {
      next.delete(ws.path);
    } else {
      next.add(ws.path);
      if (!byWorkspace[ws.path]) {
        loadWorkspaceConversations(ws.path);
      }
    }
    setExpanded(next);
  };

  const handleWorkspaceClick = (ws: WorkspaceSummary) => {
    openPath(ws.path);
    setView("chat");
    const next = new Set(expanded);
    next.add(ws.path);
    setExpanded(next);
    if (!byWorkspace[ws.path]) {
      loadWorkspaceConversations(ws.path);
    }
  };

  const handleConversationClick = (c: ConvSummary) => {
    loadConversation(c.id);
    setView("chat");
  };

  const handleDeleteConversation = (c: ConvSummary, ws: WorkspaceSummary) => {
    const wasActive = c.id === conversationId;
    removeConv(c.id).then(() => {
      if (wasActive) {
        startNew(ws.path);
      } else {
        loadWorkspaceConversations(ws.path);
      }
    });
  };

  return (
    <aside className="sidebar">
      <div className="sidebar-brand">
        <Logo className="sidebar-logo" />
        FloodMind
      </div>

      <nav className="sidebar-nav-list" aria-label="主导航">
        {NAV.map((n) => {
          const isNewTask = n.label === "新建任务";
          const active = isNewTask ? false : view === n.view;
          const disabled = isNewTask && (!current || streaming);
          return (
            <button
              key={n.label}
              className={active ? "sidebar-item active" : "sidebar-item"}
              onClick={() => handleNavClick(n)}
              disabled={disabled}
              title={isNewTask && !current ? "请先打开一个工作区" : n.label}
              type="button"
            >
              <span className="nav-icon" aria-hidden="true">{n.icon}</span>
              <span className="item-name">{n.label}</span>
            </button>
          );
        })}
      </nav>

      <div className="sidebar-section">
        <div className="sidebar-workspace-header">
          工作区 ({workspaces.length})
        </div>

        <div className="workspace-list">
          {workspaces.map((ws) => {
            const isOpen = expanded.has(ws.path);
            const conversations = getWorkspaceConversations(byWorkspace, ws.path);
            return (
              <div key={ws.path} className="workspace-group">
                <div className="workspace-row">
                  <button
                    className="workspace-chevron"
                    onClick={() => toggleWorkspace(ws)}
                    aria-expanded={isOpen}
                    aria-label={isOpen ? "折叠工作区" : "展开工作区"}
                    type="button"
                    title={ws.path}
                  >
                    {isOpen ? "▾" : "▸"}
                  </button>
                  <button
                    className={current?.path === ws.path ? "sidebar-item active" : "sidebar-item"}
                    onClick={() => handleWorkspaceClick(ws)}
                    disabled={streaming}
                    title={ws.path}
                    type="button"
                  >
                    <span className="item-name">{ws.name}</span>
                  </button>
                </div>

                {isOpen && (
                  <div className="workspace-conversations">
                    {conversations.length === 0 && (
                      <div className="tree-empty">暂无会话</div>
                    )}
                    {conversations.map((c) => (
                      <div
                        key={c.id}
                        className={c.id === conversationId ? "sidebar-item conv-item active" : "sidebar-item conv-item"}
                      >
                        <button
                          className="conv-open"
                          onClick={() => handleConversationClick(c)}
                          disabled={streaming}
                          title={c.title}
                          type="button"
                        >
                          <span className="item-name">{c.title}</span>
                        </button>
                        <button
                          className="conv-del"
                          onClick={() => handleDeleteConversation(c, ws)}
                          title="删除会话"
                          type="button"
                        >
                          ✕
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}

          <button
            className="sidebar-item"
            onClick={pickAndOpen}
            disabled={streaming}
            title={streaming ? "生成中，请稍候再切换工作区" : "打开其他工作区"}
            type="button"
          >
            <span className="nav-icon" aria-hidden="true">＋</span>
            <span className="item-name">打开其他工作区…</span>
          </button>
        </div>
      </div>
    </aside>
  );
}
