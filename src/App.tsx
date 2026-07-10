import { useEffect } from "react";
import Composer from "./components/Composer";
import Conversation from "./components/Conversation";
import McpView from "./components/McpView";
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
  const currentPath = useWorkspaceStore((s) => s.current?.path);

  useEffect(() => {
    if (!currentPath) return;
    // On workspace change: load its conversations and ensure one is active+loaded.
    (async () => {
      const items = await useConversationStore.getState().loadList(currentPath);
      const active = items.find((i) => i.active);
      if (active) {
        await useChatStore.getState().loadConversation(active.id);
      } else if (items.length > 0) {
        await useChatStore.getState().loadConversation(items[0].id);
      } else {
        await useChatStore.getState().startNew(currentPath);
      }
    })();
  }, [currentPath]);

  return (
    <div className="app">
      <Sidebar />
      <div className="main">
        {view === "chat" && (
          <>
            <TopBar />
            <Conversation />
            <Composer />
          </>
        )}
        {view === "skills" && <SkillsView />}
        {view === "mcp" && <McpView />}
        {view === "settings" && <SettingsView />}
      </div>
    </div>
  );
}
