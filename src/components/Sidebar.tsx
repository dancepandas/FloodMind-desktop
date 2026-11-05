import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useChatStore } from "../state/chat-store";
import { useConversationStore, type ConvSummary } from "../state/conversation-store";
import { useUiStore, type View } from "../state/ui-store";
import { useWorkspaceStore, type WorkspaceSummary } from "../state/workspace-store";
import { getBaseUrl } from "../lib/sidecar-client";
import { relativeTime } from "../lib/relative-time";
import Logo from "./Logo";

function NavIcon({ children }: { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

const PlusIcon = () => (
  <NavIcon>
    <line x1="12" y1="5" x2="12" y2="19" />
    <line x1="5" y1="12" x2="19" y2="12" />
  </NavIcon>
);

const FolderIcon = ({ add = false }: { add?: boolean }) => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M20 20H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2Z" />
    {add && <path d="M12 10v7m-3.5-3.5h7" />}
  </svg>
);

const ZapIcon = () => (
  <NavIcon>
    <polygon points="13 2 3 14 12 14 11 22 21 10 12 10" />
  </NavIcon>
);

const LinkIcon = () => (
  <NavIcon>
    <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
    <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
  </NavIcon>
);

const ClockIcon = () => (
  <NavIcon>
    <circle cx="12" cy="12" r="10" />
    <polyline points="12 6 12 12 16 14" />
  </NavIcon>
);

const SlidersIcon = () => (
  <NavIcon>
    <path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M2 14h4M10 10h4M18 16h4" />
  </NavIcon>
);

const BookIcon = () => (
  <NavIcon>
    <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
    <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
  </NavIcon>
);

interface SearchHit {
  conv_id: string;
  title: string;
  snippet: string;
}

function SidebarSearch({ workspace, onOpen, onGoChat }: { workspace: string; onOpen: (id: string) => void; onGoChat: () => void }) {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    if (!query.trim() || !workspace) { setHits([]); return; }
    setSearching(true);
    const t = setTimeout(async () => {
      try {
        const base = await getBaseUrl();
        const r = await fetch(`${base}/api/conversations/search?workspace=${encodeURIComponent(workspace)}&q=${encodeURIComponent(query)}`);
        if (r.ok) setHits((await r.json()).hits ?? []);
      } catch { setHits([]); } finally { setSearching(false); }
    }, 250);
    return () => clearTimeout(t);
  }, [query, workspace]);

  const open = (id: string) => { onOpen(id); onGoChat(); setQuery(""); setHits([]); };

  return (
    <div className="sidebar-search">
      <input
        type="search"
        placeholder="搜索会话…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      {query.trim() && hits.length > 0 && (
        <div className="sidebar-search-results">
          {hits.map((h) => (
            <button className="sidebar-search-hit" key={h.conv_id} onClick={() => open(h.conv_id)} type="button">
              <span className="hit-title">{h.title}</span>
              <span className="hit-snippet">{h.snippet}</span>
            </button>
          ))}
        </div>
      )}
      {query.trim() && !searching && hits.length === 0 && workspace && (
        <div className="sidebar-search-results"><div className="sidebar-search-empty">无匹配会话</div></div>
      )}
    </div>
  );
}

/* 三段式：主导航钉顶（新建任务 + 自动化/Skills），会话区居中，
   次级入口（MCP/经验）钉底，设置独占 footer。 */
const NAV_PRIMARY: { view: View; label: string; icon: ReactNode }[] = [
  { view: "tasks", label: "自动化", icon: <ClockIcon /> },
  { view: "skills", label: "Skills", icon: <ZapIcon /> },
];

const NAV_SECONDARY: { view: View; label: string; icon: ReactNode }[] = [
  { view: "mcp", label: "MCP", icon: <LinkIcon /> },
  { view: "experience", label: "经验", icon: <BookIcon /> },
];

function getWorkspaceConversations(
  byWorkspace: Record<string, ConvSummary[]>,
  path: string
): ConvSummary[] {
  return byWorkspace[path] ?? [];
}

export default function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const current = useWorkspaceStore((s) => s.current);
  const recent = useWorkspaceStore((s) => s.recent);
  const openPath = useWorkspaceStore((s) => s.openPath);
  const pickAndOpen = useWorkspaceStore((s) => s.pickAndOpen);
  const removeWorkspace = useWorkspaceStore((s) => s.remove);

  const streaming = useChatStore((s) => s.streaming);
  const conversationId = useChatStore((s) => s.conversationId);
  const startNew = useChatStore((s) => s.startNew);
  const loadConversation = useChatStore((s) => s.loadConversation);

  const byWorkspace = useConversationStore((s) => s.byWorkspace);
  const loadWorkspaceConversations = useConversationStore((s) => s.loadWorkspaceConversations);
  const removeConv = useConversationStore((s) => s.remove);

  const view = useUiStore((s) => s.view);
  const setView = useUiStore((s) => s.setView);

  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(current ? [current.path] : []));

  // Reveal the active workspace on mount and when switching workspaces, without
  // forcing it open again after the user deliberately collapses it.
  const currentWorkspacePath = current?.path;
  useEffect(() => {
    if (!currentWorkspacePath) return;
    setExpanded((previous) => previous.has(currentWorkspacePath)
      ? previous
      : new Set([...previous, currentWorkspacePath]));
  }, [currentWorkspacePath]);

  const workspaces = useMemo<WorkspaceSummary[]>(() => {
    const out: WorkspaceSummary[] = current ? [current] : [];
    for (const ws of recent) {
      if (current && ws.path === current.path) continue;
      out.push(ws);
    }
    return out;
  }, [current, recent]);

  const navigate = (nextView: View) => {
    setView(nextView);
    onNavigate?.();
  };

  const handleNewTask = () => {
    if (current) startNew(current.path);
    navigate("chat");
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
    navigate("chat");
    const next = new Set(expanded);
    next.add(ws.path);
    setExpanded(next);
    if (!byWorkspace[ws.path]) {
      loadWorkspaceConversations(ws.path);
    }
  };

  const handleConversationClick = (c: ConvSummary) => {
    onNavigate?.();
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

  const handleDeleteWorkspace = (ws: WorkspaceSummary) => {
    if (!window.confirm(
      `确定从列表移除工作区「${ws.name}」？\n（不会删除磁盘上的文件夹，仅从侧边栏移除。）`
    )) return;
    const wasCurrent = current?.path === ws.path;
    removeWorkspace(ws.path).then(() => {
      setExpanded((prev) => {
        const next = new Set(prev);
        next.delete(ws.path);
        return next;
      });
      useConversationStore.setState((s) => {
        if (!s.byWorkspace[ws.path]) return {};
        const byWorkspace = { ...s.byWorkspace };
        delete byWorkspace[ws.path];
        return { byWorkspace };
      });
      if (wasCurrent) {
        useChatStore.getState().reset();
      }
    });
  };

  return (
    <aside className="sidebar">
      <div className="sidebar-brand">
        <Logo className="sidebar-logo" />
        FloodMind
      </div>

      <nav className="sidebar-nav-list sidebar-primary" aria-label="主导航">
        <button
          className="sidebar-item sidebar-new-task"
          onClick={handleNewTask}
          disabled={!current || streaming}
          title={!current ? "请先打开一个工作区" : "新建任务"}
          type="button"
        >
          <span className="nav-icon" aria-hidden="true"><PlusIcon /></span>
          <span className="item-name">新建任务</span>
        </button>
        {NAV_PRIMARY.map((item) => (
          <button
            key={item.view}
            className={`sidebar-item${view === item.view ? " active" : ""}`}
            onClick={() => navigate(item.view)}
            type="button"
          >
            <span className="nav-icon" aria-hidden="true">{item.icon}</span>
            <span className="item-name">{item.label}</span>
          </button>
        ))}
      </nav>

      <SidebarSearch workspace={current?.path ?? ""} onOpen={loadConversation} onGoChat={() => navigate("chat")} />

      <div className="sidebar-scroll">
        <div className="sidebar-section">
        <div className="sidebar-workspace-header">
          会话
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
                    <svg
                      className="workspace-chevron-icon"
                      viewBox="0 0 16 16"
                      width="16"
                      height="16"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      <path d="m6 4 4 4-4 4" />
                    </svg>
                  </button>
                  <button
                    className={current?.path === ws.path ? "sidebar-item active" : "sidebar-item"}
                    onClick={() => handleWorkspaceClick(ws)}
                    disabled={streaming}
                    title={ws.path}
                    type="button"
                  >
                    <span className="workspace-folder"><FolderIcon /></span>
                    <span className="item-name">{ws.name}</span>
                  </button>
                  <button
                    className="workspace-del"
                    onClick={() => handleDeleteWorkspace(ws)}
                    disabled={streaming}
                    title={`从列表移除「${ws.name}」`}
                    type="button"
                  >
                    ✕
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
                        <span className="conv-time">{relativeTime(c.updated_at)}</span>
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
            className="sidebar-item workspace-open"
            onClick={async () => {
              await pickAndOpen();
              if (useWorkspaceStore.getState().current) navigate("chat");
            }}
            disabled={streaming}
            title={streaming ? "生成中，请稍候再切换工作区" : "打开其他工作区"}
            type="button"
          >
            <span className="workspace-folder"><FolderIcon add /></span>
            <span className="item-name">打开其他工作区…</span>
          </button>
        </div>
        </div>
      </div>
      <nav className="sidebar-nav-list sidebar-secondary" aria-label="更多">
        {NAV_SECONDARY.map((item) => (
          <button
            key={item.view}
            className={`sidebar-item${view === item.view ? " active" : ""}`}
            onClick={() => navigate(item.view)}
            type="button"
          >
            <span className="nav-icon" aria-hidden="true">{item.icon}</span>
            <span className="item-name">{item.label}</span>
          </button>
        ))}
      </nav>
      <footer className="sidebar-footer">
        <button className={`sidebar-item${view === "settings" ? " active" : ""}`} onClick={() => navigate("settings")} type="button">
          <span className="nav-icon" aria-hidden="true"><SlidersIcon /></span>
          <span className="item-name">设置</span>
        </button>
      </footer>
    </aside>
  );
}
