import Composer from "./components/Composer";
import Conversation from "./components/Conversation";
import Sidebar from "./components/Sidebar";
import TopBar from "./components/TopBar";

export default function App() {
  return (
    <div className="app">
      <Sidebar />
      <div className="main">
        <TopBar />
        <Conversation />
        <Composer />
      </div>
    </div>
  );
}
