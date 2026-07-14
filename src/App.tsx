import { useEffect } from "react";
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
import { useUiStore } from "./state/ui-store";
import { useWorkspaceStore } from "./state/workspace-store";
import { useConversationStore } from "./state/conversation-store";
import { useChatStore } from "./state/chat-store";
import { useResizableWidth } from "./lib/use-resizable-width";

export default function App() {
  const view = useUiStore((s) => s.view);
  const previewPath = useUiStore((s) => s.previewPath);
  const closePreview = useUiStore((s) => s.closePreview);
  const planPanelOpen = useUiStore((s) => s.planPanelOpen);
  const currentPath = useWorkspaceStore((s) => s.current?.path);

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

  return (
    <div className="app">
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
