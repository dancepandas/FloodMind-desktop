import Composer from "./components/Composer";
import Conversation from "./components/Conversation";
import McpView from "./components/McpView";
import SettingsView from "./components/SettingsView";
import Sidebar from "./components/Sidebar";
import SkillsView from "./components/SkillsView";
import TopBar from "./components/TopBar";
import { useUiStore } from "./state/ui-store";

export default function App() {
  const view = useUiStore((s) => s.view);

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
