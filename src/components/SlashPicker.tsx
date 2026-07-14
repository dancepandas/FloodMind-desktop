import { useEffect } from "react";
import { useCatalogStore } from "../state/catalog-store";

export interface SlashItem {
  kind: "skill" | "mcp";
  name: string;
}

export interface SlashPickerProps {
  query: string;
  onSelect: (item: SlashItem) => void;
  onClose: () => void;
}

export default function SlashPicker({ query, onSelect, onClose }: SlashPickerProps) {
  const skills = useCatalogStore((s) => s.skills);
  const mcpServers = useCatalogStore((s) => s.mcpServers);
  const loadSkills = useCatalogStore((s) => s.loadSkills);
  const loadMcp = useCatalogStore((s) => s.loadMcp);

  useEffect(() => {
    loadSkills();
    loadMcp();
  }, [loadSkills, loadMcp]);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const q = query.toLowerCase();
  const filteredSkills = skills
    .filter((s) => !s.disabled && s.name.toLowerCase().includes(q))
    .slice(0, 8);
  const filteredMcp = mcpServers
    .filter((s) => s.name.toLowerCase().includes(q))
    .slice(0, 8);

  const hasSkills = filteredSkills.length > 0;
  const hasMcp = filteredMcp.length > 0;

  return (
    <div className="composer-picker slash-picker" role="listbox" aria-label="Skill 和 MCP 选择">
      {hasSkills && (
        <div className="slash-picker-section">
          <div className="slash-picker-section-title">Skills</div>
          {filteredSkills.map((s) => (
            <button
              key={s.name}
              className="composer-picker-row slash-picker-row"
              type="button"
              role="option"
              onClick={() => onSelect({ kind: "skill", name: s.name })}
            >
              <span className="slash-picker-name">{s.name}</span>
              {s.description && (
                <span className="slash-picker-desc">{s.description}</span>
              )}
            </button>
          ))}
        </div>
      )}
      {hasMcp && (
        <div className="slash-picker-section">
          <div className="slash-picker-section-title">MCP 服务器</div>
          {filteredMcp.map((s) => (
            <button
              key={s.name}
              className="composer-picker-row slash-picker-row"
              type="button"
              role="option"
              onClick={() => onSelect({ kind: "mcp", name: s.name })}
            >
              <span className="slash-picker-name">{s.name}</span>
              <span className={`sdot ${s.connected ? "sdot-up" : "sdot-down"}`} />
            </button>
          ))}
        </div>
      )}
      {!hasSkills && !hasMcp && (
        <div className="composer-picker-empty">无匹配项</div>
      )}
    </div>
  );
}
