export type Tab = "model" | "identity" | "rules";

const ITEMS: { tab: Tab; label: string }[] = [
  { tab: "model", label: "模型" },
  { tab: "identity", label: "身份" },
  { tab: "rules", label: "规则" },
];

export default function SettingsNav({ active, onChange }: { active: Tab; onChange: (t: Tab) => void }) {
  return (
    <nav className="settings-nav" role="tablist" aria-label="设置分类">
      {ITEMS.map((i) => (
        <button
          key={i.tab}
          role="tab"
          className={active === i.tab ? "settings-nav-item active" : "settings-nav-item"}
          onClick={() => onChange(i.tab)}
          type="button"
        >
          {i.label}
        </button>
      ))}
    </nav>
  );
}
