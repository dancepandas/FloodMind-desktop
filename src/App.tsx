import ChatView from "./components/ChatView";
import Composer from "./components/Composer";
import HealthBadge from "./components/HealthBadge";

export default function App() {
  return (
    <main className="app">
      <header className="app-header">
        <h1>FloodMind Desktop</h1>
        <HealthBadge />
      </header>
      <ChatView />
      <Composer />
    </main>
  );
}
