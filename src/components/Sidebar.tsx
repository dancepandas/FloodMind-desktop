import { useEffect, useState } from "react";
import { FolderClosedIcon } from "./FileTreeIcons";
import { useChatStore } from "../state/chat-store";
import { useConversationStore } from "../state/conversation-store";
import { useUiStore, type View } from "../state/ui-store";
import { useWorkspaceStore, type FileEntry } from "../state/workspace-store";
import { useScheduledTaskStore } from "../state/scheduled-task-store";
import Logo from "./Logo";
import WorkspaceFileTree from "./WorkspaceFileTree";
import TaskEditModal from "./TaskEditModal";

function FolderIcon() {
  return (
    <span className="folder-icon">
      <FolderClosedIcon size={16} />
    </span>
  );
}

const NAV: { view: View; label: string; icon?: string }[] = [
  { view: "skills", label: "技能" },
  { view: "mcp", label: "连接器" },
  { view: "settings", label: "设置" },
];

export default function Sidebar() {
  const current = useWorkspaceStore((s) => s.current);
  const load = useWorkspaceStore((s) => s.load);
  const pickAndOpen = useWorkspaceStore((s) => s.pickAndOpen);
  const listFiles = useWorkspaceStore((s) => s.listFiles);
  const streaming = useChatStore((s) => s.streaming);
  const conversationId = useChatStore((s) => s.conversationId);
  const startNew = useChatStore((s) => s.startNew);
  const loadConversation = useChatStore((s) => s.loadConversation);
  const convList = useConversationStore((s) => s.list);
  const loadList = useConversationStore((s) => s.loadList);
  const removeConv = useConversationStore((s) => s.remove);
  const view = useUiStore((s) => s.view);
  const setView = useUiStore((s) => s.setView);

  const tasks = useScheduledTaskStore((s) => s.tasks);
  const loadTasks = useScheduledTaskStore((s) => s.load);
  const setSelectedTaskId = useUiStore((s) => s.setSelectedTaskId);

  const [rootFiles, setRootFiles] = useState<FileEntry[] | null>(null);
  const [taskModalOpen, setTaskModalOpen] = useState(false);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (current) {
      listFiles(".").then(setRootFiles);
    } else {
      setRootFiles(null);
    }
  }, [current?.path]);

  useEffect(() => {
    if (current) loadTasks(current.path);
  }, [current?.path]);

  return (
    <aside className="sidebar">
      <div className="sidebar-brand">
        <Logo className="sidebar-logo" />
        FloodMind
      </div>

      <button
        className="new-thread"
        onClick={() => current && startNew(current.path)}
        type="button"
        disabled={streaming || !current}
        title={current ? undefined : "请先打开一个工作区"}
      >
        <span>＋</span>
        新会话
      </button>

      {current && convList.length > 0 && (
        <div className="sidebar-section">
          <div className="sidebar-label">会话</div>
          <div className="sidebar-scroll-list">
            {convList.map((c) => (
              <div
                key={c.id}
                className={c.id === conversationId ? "sidebar-item conv-item active" : "sidebar-item conv-item"}
              >
                <button
                  className="conv-open"
                  onClick={() => loadConversation(c.id)}
                  disabled={streaming}
                  title={c.title}
                  type="button"
                >
                  <span className="item-name">{c.title}</span>
                </button>
                <button
                  className="conv-del"
                  onClick={() => {
                    const wasActive = c.id === conversationId;
                    removeConv(c.id).then(() => {
                      if (!current) return;
                      // Spec: deleting the active conversation activates another
                      // (here: a fresh one); otherwise just refresh the list.
                      if (wasActive) startNew(current.path);
                      else loadList(current.path);
                    });
                  }}
                  title="删除会话"
                  type="button"
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {current && (
        <div className="sidebar-section">
          <div className="sidebar-label">
            自动化
            <button className="label-add" onClick={() => setTaskModalOpen(true)} type="button" title="新建定时任务">＋</button>
          </div>
          <div className="sidebar-scroll-list">
            {tasks.length === 0 && <div className="tree-empty">暂无定时任务</div>}
            {tasks.map((t) => (
              <button
                key={t.id}
                className="sidebar-item task-item"
                onClick={() => { setSelectedTaskId(t.id); setView("tasks"); }}
                title={t.command}
                type="button"
              >
                <span className={"task-dot task-" + t.status} aria-hidden="true" />
                <span className="item-name">{t.command}</span>
              </button>
            ))}
          </div>
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
          <FolderIcon />
          <span className="item-name">{current ? current.name : "打开工作区…"}</span>
        </button>

        {/* react-arborist file tree (workspace button is the root) */}
        {current && rootFiles && rootFiles.length > 0 && (
          <WorkspaceFileTree rootFiles={rootFiles} />
        )}
        {current && rootFiles && rootFiles.length === 0 && (
          <div className="sidebar-tree">
            <div className="tree-empty">工作区为空</div>
          </div>
        )}
      </div>

      <div className="sidebar-spacer" />
      <div className="sidebar-section sidebar-nav">
        <div className="sidebar-label">配置</div>
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

      {taskModalOpen && current && (
        <TaskEditModal workspace={current.path} editing={null} onClose={() => setTaskModalOpen(false)} />
      )}
    </aside>
  );
}
