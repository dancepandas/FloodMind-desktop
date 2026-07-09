import { useEffect, useState } from "react";
import { useWorkspaceStore } from "../state/workspace-store";

export default function WorkspaceSwitcher() {
  const current = useWorkspaceStore((s) => s.current);
  const recent = useWorkspaceStore((s) => s.recent);
  const load = useWorkspaceStore((s) => s.load);
  const pickAndOpen = useWorkspaceStore((s) => s.pickAndOpen);
  const openPath = useWorkspaceStore((s) => s.openPath);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    load();
  }, [load]);

  const switchable = recent.filter((r) => !current || r.path !== current.path);

  return (
    <div className="ws-switcher">
      <button className="ws-pick" onClick={() => pickAndOpen()} title={current?.path}>
        📁 {current ? current.name : "打开工作区…"}
      </button>
      {switchable.length > 0 && (
        <button className="ws-toggle" onClick={() => setOpen((o) => !o)}>
          ▾
        </button>
      )}
      {open && switchable.length > 0 && (
        <ul className="ws-recent">
          {switchable.map((r) => (
            <li key={r.path}>
              <button
                onClick={() => {
                  openPath(r.path);
                  setOpen(false);
                }}
                title={r.path}
              >
                {r.name}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
