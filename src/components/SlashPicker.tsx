import { useEffect, useMemo, useState } from "react";
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

  const q = query.toLowerCase();
  const filteredSkills = useMemo(
    () => skills.filter((s) => !s.disabled && s.name.toLowerCase().includes(q)).slice(0, 8),
    [skills, q]
  );
  const filteredMcp = useMemo(
    () => mcpServers.filter((s) => s.name.toLowerCase().includes(q)).slice(0, 8),
    [mcpServers, q]
  );
  const options = useMemo<SlashItem[]>(
    () => [
      ...filteredSkills.map((s) => ({ kind: "skill" as const, name: s.name })),
      ...filteredMcp.map((s) => ({ kind: "mcp" as const, name: s.name })),
    ],
    [filteredSkills, filteredMcp]
  );

  const [activeIndex, setActiveIndex] = useState(0);
  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      if (options.length === 0) return;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActiveIndex((i) => (i + 1) % options.length);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setActiveIndex((i) => (i - 1 + options.length) % options.length);
      } else if (e.key === "Enter") {
        e.preventDefault();
        onSelect(options[activeIndex]);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeIndex, onClose, onSelect, options]);

  if (options.length === 0) {
    return (
      <div className="composer-picker slash-picker" role="listbox" aria-label="Skill 和 MCP 选择">
        <div className="composer-picker-empty">无匹配项</div>
      </div>
    );
  }

  const activeId = `slash-picker-option-${activeIndex}`;
  let optionIndex = -1;

  return (
    <div
      className="composer-picker slash-picker"
      role="listbox"
      aria-label="Skill 和 MCP 选择"
      aria-activedescendant={activeId}
    >
      {filteredSkills.length > 0 && (
        <div className="slash-picker-section">
          <div className="slash-picker-section-title">Skills</div>
          {filteredSkills.map((s) => {
            const i = ++optionIndex;
            const id = `slash-picker-option-${i}`;
            const isActive = i === activeIndex;
            return (
              <button
                key={s.name}
                id={id}
                className={`composer-picker-row slash-picker-row${
                  isActive ? " slash-picker-row-active" : ""
                }`}
                type="button"
                role="option"
                aria-selected={isActive}
                onClick={() => onSelect({ kind: "skill", name: s.name })}
              >
                <span className="slash-picker-name">{s.name}</span>
                {s.description && (
                  <span className="slash-picker-desc">{s.description}</span>
                )}
              </button>
            );
          })}
        </div>
      )}
      {filteredMcp.length > 0 && (
        <div className="slash-picker-section">
          <div className="slash-picker-section-title">MCP 服务器</div>
          {filteredMcp.map((s) => {
            const i = ++optionIndex;
            const id = `slash-picker-option-${i}`;
            const isActive = i === activeIndex;
            return (
              <button
                key={s.name}
                id={id}
                className={`composer-picker-row slash-picker-row${
                  isActive ? " slash-picker-row-active" : ""
                }`}
                type="button"
                role="option"
                aria-selected={isActive}
                onClick={() => onSelect({ kind: "mcp", name: s.name })}
              >
                <span className="slash-picker-name">{s.name}</span>
                <span className="slash-picker-meta">
                  <span className={`sdot ${s.connected ? "sdot-up" : "sdot-down"}`} />
                  {typeof s.tools === "number" && (
                    <span className="slash-picker-count">{s.tools} tools</span>
                  )}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
