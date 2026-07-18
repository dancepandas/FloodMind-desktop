import { useEffect, useMemo, useRef, useState } from "react";
import { useConfigStore, type EnabledModel } from "../state/config-store";
import { useChatStore } from "../state/chat-store";
import { useUiStore } from "../state/ui-store";

interface Row {
  providerId: string;
  providerName: string;
  model: string;
  supportsVision: boolean;
  keyPresent: boolean;
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
  const showToast = useUiStore((s) => s.showToast);
  const [query, setQuery] = useState("");
  const [hi, setHi] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);

  const rows: Row[] = useMemo(() => {
    const provById = new Map(providers.map((p) => [p.id, p]));
    return enabled
      .map((e: EnabledModel) => {
        const p = provById.get(e.provider);
        const m = p?.models.find((mm) => mm.name === e.model);
        if (!p || !m) return null;
        return {
          providerId: p.id,
          providerName: p.name,
          model: m.name,
          supportsVision: !!m.supportsVision,
          keyPresent: !!p.apiKeyPresent,
          active: active?.provider === p.id && active?.model === m.name,
        };
      })
      .filter(Boolean) as Row[];
  }, [providers, enabled, active]);

  const filtered = rows.filter((r) =>
    !query.trim() ? true : (r.model + r.providerName).toLowerCase().includes(query.trim().toLowerCase()),
  );

  const grouped = useMemo(() => {
    const map = new Map<string, { name: string; rows: Row[] }>();
    for (const r of filtered) {
      if (!map.has(r.providerId)) map.set(r.providerId, { name: r.providerName, rows: [] });
      map.get(r.providerId)!.rows.push(r);
    }
    return Array.from(map.values());
  }, [filtered]);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [onClose]);

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") { onClose(); return; }
    if (filtered.length === 0) return;
    if (e.key === "ArrowDown") { e.preventDefault(); setHi((i) => (i + 1) % filtered.length); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setHi((i) => (i - 1 + filtered.length) % filtered.length); }
    else if (e.key === "Enter") {
      e.preventDefault();
      const r = filtered[hi];
      if (r && r.keyPresent) onPick(r.providerId, r.model);
    }
  }

  const disabled = switching || streaming;

  return (
    <div className="model-picker" ref={containerRef} role="listbox" aria-label="选择模型">
      <input
        className="model-picker-filter"
        placeholder="🔍 过滤模型…"
        value={query}
        autoFocus
        onChange={(e) => { setQuery(e.target.value); setHi(0); }}
        onKeyDown={onKeyDown}
        disabled={disabled}
      />
      <div className="model-picker-list">
        {grouped.length === 0 && <div className="model-picker-empty">无匹配模型</div>}
        {grouped.map((g) => (
          <div className="model-picker-group" key={g.name}>
            <div className="model-picker-group-head">{g.name}</div>
            {g.rows.map((r) => {
              const idx = filtered.indexOf(r);
              const blocked = !r.keyPresent || disabled;
              return (
                <button
                  type="button"
                  key={`${r.providerId}/${r.model}`}
                  className={`model-picker-row${r.active ? " active" : ""}${idx === hi ? " hi" : ""}`}
                  data-vision={r.supportsVision ? "true" : "false"}
                  disabled={blocked}
                  title={!r.keyPresent ? "需配置 API Key" : undefined}
                  onClick={() => {
                    if (!r.keyPresent) { showToast("该模型所在供应商未配置 API Key，请先在设置中填写"); return; }
                    if (disabled) return;
                    onPick(r.providerId, r.model);
                  }}
                >
                  <span className="model-picker-check">{r.active ? "●" : ""}</span>
                  <span className="model-picker-name">{r.model}</span>
                  {r.supportsVision && <span className="model-picker-vision" title="支持图片">👁</span>}
                  {!r.keyPresent && <span className="model-picker-locked">🔒 需配置Key</span>}
                </button>
              );
            })}
          </div>
        ))}
      </div>
      <button type="button" className="model-picker-manage" onClick={onClose}>
        ⚙ 管理模型…
      </button>
    </div>
  );
}
