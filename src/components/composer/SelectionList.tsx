import { useEffect, useId, useRef, useState, type ReactNode } from "react";
export interface SelectionItem { value: string; label: string; title?: string }
export function SelectionCheck({ selected }: { selected: boolean }) {
  return <span className="fm-menu-check" aria-hidden="true">{selected && <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="m5 12 4 4L19 6" /></svg>}</span>;
}
export default function SelectionList({ label, items, value, disabled, onSelect, footer }: { label: string; items: SelectionItem[]; value: string; disabled?: boolean; onSelect: (value: string) => void; footer?: ReactNode }) {
  const id = useId();
  const ref = useRef<HTMLDivElement>(null);
  const [hi, setHi] = useState(() => Math.max(0, items.findIndex((item) => item.value === value)));
  const index = Math.min(hi, items.length - 1);
  useEffect(() => { ref.current?.focus(); }, []);
  useEffect(() => { document.getElementById(`${id}-${index}`)?.scrollIntoView?.({ block: "nearest" }); }, [id, index]);
  return <>
    <div ref={ref} role="listbox" aria-label={label} tabIndex={0} aria-disabled={disabled || undefined} aria-activedescendant={index >= 0 ? `${id}-${index}` : undefined} className="fm-selection-list" onKeyDown={(event) => {
      if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
        event.preventDefault();
        setHi(event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length);
      } else if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        if (!disabled && items[index]) onSelect(items[index].value);
      }
    }}>
      {items.map((item, i) => <div key={item.value} id={`${id}-${i}`} role="option" aria-selected={item.value === value} aria-disabled={disabled || undefined} className={`fm-menu-option${i === index ? " hi" : ""}`} title={item.title ?? item.label} onClick={() => { if (!disabled) onSelect(item.value); }}>
        <SelectionCheck selected={item.value === value} /><span>{item.label}</span>
      </div>)}
    </div>
    {footer}
  </>;
}
