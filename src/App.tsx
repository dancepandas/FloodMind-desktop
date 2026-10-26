import { useEffect, useRef, useState } from "react";
import Composer from "./components/Composer";
import Conversation from "./components/Conversation";
import DropZone from "./components/DropZone";
import Lightbox from "./components/Lightbox";
import McpView from "./components/McpView";
import * as Dialog from "@radix-ui/react-dialog";
import ContextPanel from "./components/ContextPanel";
import ScheduledTasksView from "./components/ScheduledTasksView";
import ExperienceView from "./components/ExperienceView";
import SettingsView from "./components/SettingsView";
import Sidebar from "./components/Sidebar";
import SkillsView from "./components/SkillsView";
import TopBar from "./components/TopBar";
import WelcomeSplash from "./components/WelcomeSplash";
import { WelcomeStarters } from "./components/WelcomeView";
import { useUiStore } from "./state/ui-store";
import { useWorkspaceStore } from "./state/workspace-store";
import { useConversationStore } from "./state/conversation-store";
import { useChatStore } from "./state/chat-store";
import { useConfigStore } from "./state/config-store";
import { useBackgroundTaskStore } from "./state/background-task-store";
import { useResizableWidth } from "./lib/use-resizable-width";
import { initLogCapture } from "./lib/log-capture";

initLogCapture();

export default function App() {
  const view = useUiStore((s) => s.view);
  const inspectorOpen = useUiStore((s) => s.inspectorOpen);
  const empty = useChatStore((s) => s.turns.length === 0);
  const toast = useUiStore((s) => s.toast);
  const currentPath = useWorkspaceStore((s) => s.current?.path);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [compact, setCompact] = useState(() => window.innerWidth < 900);
  const [navigationOpen, setNavigationOpen] = useState(false);
  const navigationTrigger = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const resize = () => setCompact(window.innerWidth < 900);
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);
  const toggleSidebar = () => {
    if (compact) {
      if (!navigationOpen) navigationTrigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setNavigationOpen((open) => !open);
    } else {
      setSidebarOpen((open) => !open);
    }
  };
  const loadBgTasks = useBackgroundTaskStore((s) => s.load);

  // 聊天视图下每 3s 轮询后台任务：store 初始为空，若只在「已有任务」时才轮询
  // 就永远发现不了任务——所以只要在聊天视图就持续轮询，有后台任务跑时输入框
  // 下方的 shell 指示器才能及时出现。
  useEffect(() => {
    if (view !== "chat") return;
    loadBgTasks();
    const id = setInterval(() => loadBgTasks(), 3000);
    return () => clearInterval(id);
  }, [view, loadBgTasks]);

  // One-time first-launch welcome splash. Show only until the user dismisses it
  // (flag persisted in localStorage). null = still deciding, to avoid a flash
  // of the splash on every launch before the check resolves.
  const [showWelcome, setShowWelcome] = useState<boolean | null>(null);

  const sidebarResize = useResizableWidth({
    storageKey: "floodmind.sidebar.width",
    defaultWidth: 244,
    minWidth: 180,
    maxWidth: 400,
    edge: "right",
  });

  const rightResize = useResizableWidth({
    storageKey: "floodmind.rightPanel.width",
    defaultWidth: 320,
    minWidth: 240,
    maxWidth: 600,
    edge: "left",
  });

  useEffect(() => {
    if (!currentPath) return;
    let stale = false;
    // On workspace change: load its conversations and ensure one is active+loaded.
    (async () => {
      const items = await useConversationStore.getState().loadList(currentPath);
      if (stale) return;             // workspace switched while loading — abandon
      const active = items.find((i) => i.active);
      if (active) {
        await useChatStore.getState().loadConversation(active.id);
      } else if (items.length > 0) {
        await useChatStore.getState().loadConversation(items[0].id);
      } else {
        await useChatStore.getState().startNew(currentPath);
      }
    })();
    return () => { stale = true; };
  }, [currentPath]);

  // Load the model config once on startup so the composer model pill and any
  // other model-aware UI reflect the saved settings without opening Settings.
  useEffect(() => {
    try {
      setShowWelcome(!localStorage.getItem("floodmind.welcome.seen"));
    } catch {
      setShowWelcome(false); // localStorage unavailable — skip the splash.
    }
    useWorkspaceStore.getState().load();
    useConfigStore.getState().load();
    // Load the persisted permission mode too, so the composer's "授权：…"
    // pill matches the mode actually in effect from app start.
    useConfigStore.getState().loadPermissions();
  }, []);

  const enterApp = () => {
    try {
      localStorage.setItem("floodmind.welcome.seen", "1");
    } catch {
      /* ignore — best-effort persistence */
    }
    setShowWelcome(false);
  };

  return (
    <div className="app">
      {showWelcome && <WelcomeSplash onEnter={enterApp} />}
      {toast && (
        <div className="toast" role="status" aria-live="polite">
          {toast.message}
        </div>
      )}
      <Lightbox />
      {!compact && sidebarOpen && (
        <div className="sidebar-wrap" style={{ width: sidebarResize.width }} data-resizable="right">
          <Sidebar />
          <div className="resize-handle resize-handle-right" role="separator" aria-label="调整导航宽度" aria-orientation="vertical" aria-valuemin={180} aria-valuemax={400} aria-valuenow={sidebarResize.width} tabIndex={0} onKeyDown={sidebarResize.onKeyDown} onMouseDown={sidebarResize.startResize} />
        </div>
      )}
      {compact && (
        <Dialog.Root open={navigationOpen} onOpenChange={setNavigationOpen}>
          <Dialog.Portal>
            <Dialog.Overlay className="navigation-overlay" />
            <Dialog.Content className="navigation-dialog" aria-describedby={undefined} onCloseAutoFocus={(event) => {
              event.preventDefault();
              const trigger = navigationTrigger.current;
              if (trigger?.isConnected) trigger.focus();
              else document.querySelector<HTMLButtonElement>(view === "chat" ? ".topbar-sidebar-toggle" : ".navigation-toggle")?.focus();
            }}>
              <Dialog.Title className="sr-only">工作区导航</Dialog.Title>
              <Sidebar onNavigate={() => setNavigationOpen(false)} />
              <Dialog.Close className="sr-only">关闭导航</Dialog.Close>
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>
      )}
      <button className="navigation-toggle" onClick={toggleSidebar} type="button" aria-label="切换导航" aria-expanded={compact ? navigationOpen : sidebarOpen}>☰</button>
      <div className="main">
        {view === "chat" && (
          <>
            <TopBar onToggleSidebar={toggleSidebar} />
            <div className="chat-layout">
              <DropZone>
                <div className={`chat-stage${empty ? " chat-stage-empty" : ""}`}>
                  <Conversation />
                  <Composer />
                  {empty && <WelcomeStarters />}
                </div>
              </DropZone>
              <div className="chat-right" hidden={!inspectorOpen} style={{ width: rightResize.width, display: inspectorOpen ? undefined : "none" }} data-resizable="left">
                <div className="resize-handle resize-handle-left" role="separator" aria-label="调整工作面板宽度" aria-orientation="vertical" aria-valuemin={240} aria-valuemax={600} aria-valuenow={rightResize.width} tabIndex={0} onKeyDown={rightResize.onKeyDown} onMouseDown={rightResize.startResize} />
                <ContextPanel />
              </div>
            </div>
          </>
        )}
        {view === "tasks" && <ScheduledTasksView />}
        {view === "skills" && <SkillsView />}
        {view === "mcp" && <McpView />}
        {view === "experience" && <ExperienceView />}
        {view === "settings" && <SettingsView />}
      </div>
    </div>
  );
}
