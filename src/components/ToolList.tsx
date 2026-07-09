import { useState } from "react";
import { useChatStore } from "../state/chat-store";

export default function ToolList() {
  const tools = useChatStore((s) => s.tools);
  if (tools.length === 0) return null;
  return (
    <section className="rail-section">
      <h3>工具调用</h3>
      {tools.map((t, i) => (
        <ToolCard key={t.call_id || `${t.tool_name}-${i}`} tool={t} />
      ))}
    </section>
  );
}

function ToolCard({ tool }: { tool: ReturnType<typeof useChatStore.getState>["tools"][number] }) {
  const [open, setOpen] = useState(false);
  const status = tool.status || "running";
  return (
    <div className={`tool-card tool-${status}`}>
      <button className="tool-head" onClick={() => setOpen((o) => !o)}>
        <span className={`dot dot-${status}`} />
        <span className="tool-name">{tool.tool_name}</span>
        <span className="tool-status">{status}</span>
        <span className="tool-chev">{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <div className="tool-detail">
          {tool.input && (
            <div>
              <span className="muted">输入</span>
              <pre>{tool.input}</pre>
            </div>
          )}
          {tool.output && (
            <div>
              <span className="muted">输出</span>
              <pre>{tool.output}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
