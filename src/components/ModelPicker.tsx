import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useConfigStore, type EnabledModel } from "../state/config-store";
import { useChatStore } from "../state/chat-store";
import ProviderIcon from "./ProviderIcon";

interface Row {
  providerId: string;
  providerName: string;
  model: string;
  supportsVision: boolean;
  active: boolean;
}

export default function ModelPicker({
  onPick,
  onClose,
}: {
  onPick: (provider: string, model: string) => void;
  onClose: () => void;
}) {
  const providers = useConfigStore((s) => s.providers);
  const enabled = useConfigStore((s) => s.enabledModels);
  const active = useConfigStore((s) => s.model);
  const switching = useConfigStore((s) => s.switching);
  const streaming = useChatStore((s) => s.streaming);
  const [hi, setHi] = useState(0);
  const id = useId();
  const containerRef = useRef<HTMLDivElement>(null);

  const rows: Row[] = useMemo(() => {
    const provById = new Map(providers.map((p) => [p.id, p]));
    return enabled
      .map((e: EnabledModel) => {
        const p = provById.get(e.provider);
        const m = p?.models.find((mm) => mm.name === e.model);
        if (!p || !m) return null;
        const usable = !!p.apiKeyPresent || e.provider === "ollama";
        if (!usable) return null;
        return {
          providerId: p.id,
          providerName: p.name,
          model: m.name,
          supportsVision: !!m.supportsVision,
          active: active?.provider === p.id && active?.model === m.name,
        };
      })
      .filter(Boolean) as Row[];
  }, [providers, enabled, active]);

  const grouped = useMemo(() => {
    const map = new Map<string, { providerId: string; name: string; rows: Row[] }>();
    for (const r of rows) {
      if (!map.has(r.providerId)) map.set(r.providerId, { providerId: r.providerId, name: r.providerName, rows: [] });
      map.get(r.providerId)!.rows.push(r);
    }
    return Array.from(map.values());
  }, [rows]);

  const orderedRows = useMemo(() => grouped.flatMap((group) => group.rows), [grouped]);
  const index = Math.min(hi, Math.max(0, orderedRows.length - 1));

  // Focus the container on open so keyboard navigation starts at the selection.
  useEffect(() => {
    setHi(Math.max(0, orderedRows.findIndex((row) => row.active)));
    containerRef.current?.focus();
  }, []);

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") return;
    if (orderedRows.length === 0) return;
    if (e.key === "ArrowDown") { e.preventDefault(); setHi((index + 1) % orderedRows.length); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setHi((index - 1 + orderedRows.length) % orderedRows.length); }
    else if (e.key === "Home") { e.preventDefault(); setHi(0); }
    else if (e.key === "End") { e.preventDefault(); setHi(orderedRows.length - 1); }
    else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      const r = orderedRows[index];
      if (r && !disabled) onPick(r.providerId, r.model);
    }
  }

  useEffect(() => { document.getElementById(`${id}-${index}`)?.scrollIntoView?.({ block: "nearest" }); }, [id, index]);
  const disabled = switching || streaming;

  return (
    <div className="model-picker">
      <div className="model-picker-list" ref={containerRef} role="listbox" aria-label="选择模型" tabIndex={0} aria-disabled={disabled || undefined} aria-activedescendant={orderedRows[index] ? `${id}-${index}` : undefined} onKeyDown={onKeyDown}>
        {grouped.length === 0 && <div className="model-picker-empty">暂无启用的模型，请在设置中勾选</div>}
        {grouped.map((g) => (
          <div className="model-picker-group" key={g.providerId}>
            <div className="model-picker-group-head">
              <ProviderIcon provider={g.providerId} className="model-picker-provider-icon" />
              <span className="model-picker-group-name">{g.name}</span>
            </div>
            {g.rows.map((r) => {
              const idx = orderedRows.indexOf(r);
              return (
                <div
                  role="option"
                  id={`${id}-${idx}`}
                  aria-selected={r.active}
                  aria-disabled={disabled || undefined}
                  title={r.model}
                  key={`${r.providerId}/${r.model}`}
                  className={`model-picker-row${r.active ? " active" : ""}${idx === index ? " hi" : ""}`}
                  data-vision={r.supportsVision ? "true" : "false"}
                  onClick={() => {
                    if (disabled) return;
                    onPick(r.providerId, r.model);
                  }}
                >
                  <span className="model-picker-check">
                    {r.active && (
                      <svg className="model-picker-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
                        <path d="m5 12 4 4L19 6" />
                      </svg>
                    )}
                  </span>
                  <span className="model-picker-name">{r.model}</span>
                  {r.supportsVision && (
                    <span className="model-picker-vision" title="支持图片">
                      <svg className="model-picker-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
                        <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" />
                        <circle cx="12" cy="12" r="3" />
                      </svg>
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </div>
      <button type="button" className="model-picker-manage" onClick={onClose}>
        <svg className="model-picker-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
          <path d="m9.5 3-.6 2.3-1.8 1L4.8 6l-2.5 4.3L4 12l-.1 2-1.6 1.7L4.8 20l2.3-.3 1.8 1 .6 2.3h5l.6-2.3 1.8-1 2.3.3 2.5-4.3L20 14l-.1-2 1.8-1.7L19.2 6l-2.3.3-1.8-1L14.5 3Z" transform="translate(1.2 0) scale(.9)" />
          <circle cx="12" cy="12" r="3" />
        </svg>
        管理模型…
      </button>
    </div>
  );
}
