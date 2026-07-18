import { useEffect, useState } from "react";
import Composer from "./components/Composer";
import Conversation from "./components/Conversation";
import DropZone from "./components/DropZone";
import McpView from "./components/McpView";
import PlanPanel from "./components/PlanPanel";
import PreviewPanel from "./components/PreviewPanel";
import ScheduledTasksView from "./components/ScheduledTasksView";
import SettingsView from "./components/SettingsView";
import Sidebar from "./components/Sidebar";
import SkillsView from "./components/SkillsView";
import TopBar from "./components/TopBar";
import WelcomeSplash from "./components/WelcomeSplash";
import { useUiStore } from "./state/ui-store";
import { useWorkspaceStore } from "./state/workspace-store";
import { useConversationStore } from "./state/conversation-store";
import { useChatStore } from "./state/chat-store";
import { useConfigStore } from "./state/config-store";
import { useResizableWidth } from "./lib/use-resizable-width";
import { initLogCapture } from "./lib/log-capture";

initLogCapture();

export default function App() {
  const view = useUiStore((s) => s.view);
  const previewPath = useUiStore((s) => s.previewPath);
  const closePreview = useUiStore((s) => s.closePreview);
  const planPanelOpen = useUiStore((s) => s.planPanelOpen);
  const toast = useUiStore((s) => s.toast);
  const currentPath = useWorkspaceStore((s) => s.current?.path);

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
      <div className="sidebar-wrap" style={{ width: sidebarResize.width }} data-resizable="right">
        <Sidebar />
        <div className="resize-handle resize-handle-right" onMouseDown={sidebarResize.startResize} />
      </div>
      <div className="main">
        {view === "chat" && (
          <>
            <TopBar />
            <div className="chat-layout">
              <DropZone>
                <Conversation />
                <Composer />
              </DropZone>
              {(planPanelOpen || previewPath) && (
                <div className="chat-right" style={{ width: rightResize.width }} data-resizable="left">
                  <div className="resize-handle resize-handle-left" onMouseDown={rightResize.startResize} />
                  {previewPath ? (
                    <PreviewPanel path={previewPath} onClose={closePreview} />
                  ) : (
                    <PlanPanel />
                  )}
                </div>
              )}
            </div>
          </>
        )}
        {view === "tasks" && <ScheduledTasksView />}
        {view === "skills" && <SkillsView />}
        {view === "mcp" && <McpView />}
        {view === "settings" && <SettingsView />}
      </div>
    </div>
  );
}
