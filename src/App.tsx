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

export default function App() {
  const view = useUiStore((s) => s.view);
  const previewPath = useUiStore((s) => s.previewPath);
  const closePreview = useUiStore((s) => s.closePreview);
  const currentPath = useWorkspaceStore((s) => s.current?.path);

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
      <Sidebar />
      <div className="main">
        {view === "chat" && (
          <>
            <TopBar />
            <DropZone>
              <div className="chat-stage">
                <Conversation />
                <PlanPanel />
                {previewPath && <PreviewPanel path={previewPath} onClose={closePreview} />}
              </div>
            </DropZone>
            <Composer />
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
