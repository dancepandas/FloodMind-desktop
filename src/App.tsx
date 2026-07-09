import ArtifactList from "./components/ArtifactList";
import ChatView from "./components/ChatView";
import Composer from "./components/Composer";
import HealthBadge from "./components/HealthBadge";
import PlanPanel from "./components/PlanPanel";
import ToolList from "./components/ToolList";
import UsageBadge from "./components/UsageBadge";

export default function App() {
  return (
    <main className="app">
      <header className="app-header">
        <h1>FloodMind Desktop</h1>
        <HealthBadge />
        <UsageBadge />
      </header>
      <div className="app-body">
        <section className="chat-col">
          <ChatView />
          <Composer />
        </section>
        <aside className="rail">
          <PlanPanel />
          <ToolList />
          <ArtifactList />
          <div className="rail-empty muted">任务进度、工具调用与产物会显示在这里</div>
        </aside>
      </div>
    </main>
  );
}
