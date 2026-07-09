import { useEffect, useState } from "react";
import PageHeader from "./PageHeader";
import { useCatalogStore } from "../state/catalog-store";

export default function SkillsView() {
  const skills = useCatalogStore((s) => s.skills);
  const detail = useCatalogStore((s) => s.skillDetail);
  const detailLoading = useCatalogStore((s) => s.skillDetailLoading);
  const loadSkills = useCatalogStore((s) => s.loadSkills);
  const loadSkill = useCatalogStore((s) => s.loadSkill);
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    loadSkills();
  }, [loadSkills]);

  useEffect(() => {
    if (selected) loadSkill(selected);
  }, [selected, loadSkill]);

  return (
    <div className="page">
      <PageHeader title={`Skills（${skills.length}）`} />
      <div className="page-body master-detail">
        <ul className="cat-list">
          {skills.length === 0 && <li className="cat-empty">暂无技能</li>}
          {skills.map((s) => (
            <li key={s.name}>
              <button
                className={selected === s.name ? "cat-item active" : "cat-item"}
                onClick={() => setSelected(s.name)}
                type="button"
              >
                <span className="cat-name">{s.name}</span>
                {s.category && <span className="cat-tag">{s.category}</span>}
                {s.description && <span className="cat-desc">{s.description}</span>}
              </button>
            </li>
          ))}
        </ul>
        <div className="cat-detail">
          {!selected && <div className="cat-empty">选择左侧技能查看详情</div>}
          {selected && detail && (
            <>
              <div className="cat-detail-head">
                <h2>{detail.name}</h2>
                {detail.version && <span className="cat-tag">v{detail.version}</span>}
                {detail.category && <span className="cat-tag">{detail.category}</span>}
              </div>
              {detail.description && <p className="cat-detail-desc">{detail.description}</p>}
              {detail.provides_tools && detail.provides_tools.length > 0 && (
                <div className="cat-tools">
                  <div className="cat-subhead">提供工具</div>
                  <div className="cat-tool-chips">
                    {detail.provides_tools.map((t) => (
                      <span className="cat-tool-chip" key={t}>
                        {t}
                      </span>
                    ))}
                  </div>
                </div>
              )}
              {detail.prompt && (
                <div className="cat-prompt">
                  <div className="cat-subhead">SKILL.md</div>
                  <pre>{detail.prompt}</pre>
                </div>
              )}
            </>
          )}
          {selected && detailLoading && <div className="cat-empty">加载中…</div>}
          {selected && !detailLoading && !detail && <div className="cat-empty">无法加载该技能</div>}
        </div>
      </div>
    </div>
  );
}
