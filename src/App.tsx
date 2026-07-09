import Composer from "./components/Composer";
import Conversation from "./components/Conversation";
import StatusBar from "./components/StatusBar";

export default function App() {
  return (
    <main className="app">
      <StatusBar />
      <Conversation />
      <Composer />
    </main>
  );
}
