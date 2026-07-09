import type { ReactNode } from "react";
import { useUiStore } from "../state/ui-store";

/** Header for a dedicated page (Skills/MCP/Settings) with a back-to-chat button. */
export default function PageHeader({ title, children }: { title: string; children?: ReactNode }) {
  const setView = useUiStore((s) => s.setView);
  return (
    <header className="page-header">
      <button className="back-btn" onClick={() => setView("chat")} type="button">
        ← 返回对话
      </button>
      <h1 className="page-title">{title}</h1>
      <div className="page-actions">{children}</div>
    </header>
  );
}
