import { useEffect, useState } from "react";
import PageHeader from "./PageHeader";
import { useCatalogStore, type SkillForm } from "../state/catalog-store";
import SkillEditModal from "./SkillEditModal";
import { getBaseUrl } from "../lib/sidecar-client";
import "../styles/catalog.css";

interface DraftSkill {
  name: string;
  description: string;
  path: string;
  keywords: string[];
}

/** 建议技能：引擎从重复成功的经验分支自动生成的 draft SKILL.md，待人工审阅。 */
function DraftSkillsSection({ onChanged }: { onChanged: () => void }) {
  const [drafts, setDrafts] = useState<DraftSkill[]>([]);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setLoading(true);
    try {
      const base = await getBaseUrl();
      const r = await fetch(`${base}/api/skills/drafts`);
      if (!r.ok) throw new Error(`status ${r.status}`);
      setDrafts((await r.json()).drafts ?? []);
    } catch {
      setDrafts([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const act = async (name: string, action: "approve" | "reject") => {
    try {
      const base = await getBaseUrl();
      await fetch(`${base}/api/skills/drafts/${encodeURIComponent(name)}/${action}`, { method: "POST" });
      await load();
      onChanged();
    } catch {
      /* best-effort; reload reflects truth */
    }
  };

  if (loading || drafts.length === 0) return null;

  return (
    <section className="draft-skills" aria-label="建议技能">
      <div className="draft-skills-head">建议技能（由历史经验自动生成，待审阅）</div>
      <div className="catalog-grid draft-skills-grid">
        {drafts.map((d) => (
          <div className="draft-skill-card" key={d.name}>
            <div className="draft-skill-name">{d.name}</div>
            {d.description && <div className="draft-skill-desc">{d.description}</div>}
            {d.keywords.length > 0 && (
              <div className="draft-skill-keywords">关键词：{d.keywords.join("、")}</div>
            )}
            <div className="draft-skill-actions">
              <button className="btn-primary" onClick={() => act(d.name, "approve")} type="button">安装</button>
              <button className="btn-secondary" onClick={() => act(d.name, "reject")} type="button">拒绝</button>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

export default function SkillsView() {
  const skills = useCatalogStore((s) => s.skills);
  const detail = useCatalogStore((s) => s.skillDetail);
  const detailLoading = useCatalogStore((s) => s.skillDetailLoading);
  const skillSaving = useCatalogStore((s) => s.skillSaving);
  const skillError = useCatalogStore((s) => s.skillError);
  const loadSkills = useCatalogStore((s) => s.loadSkills);
  const loadSkill = useCatalogStore((s) => s.loadSkill);
  const setSkillDisabled = useCatalogStore((s) => s.setSkillDisabled);
  const createSkill = useCatalogStore((s) => s.createSkill);
  const updateSkill = useCatalogStore((s) => s.updateSkill);
  const deleteSkill = useCatalogStore((s) => s.deleteSkill);

  const [selected, setSelected] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<SkillForm | null>(null);

  useEffect(() => {
    loadSkills();
  }, [loadSkills]);

  useEffect(() => {
    if (selected) loadSkill(selected);
  }, [selected, loadSkill]);

  const isBuiltIn =
    detail?.builtin ?? skills.find((s) => s.name === detail?.name)?.builtin ?? false;

  const handleEdit = () => {
    if (!detail) return;
    setEditing({
      name: detail.name,
      description: detail.description || "",
      category: detail.category || "execution",
      version: detail.version || "1.0",
      prompt: detail.prompt || "",
    });
    setModalOpen(true);
  };

  const handleSave = async (form: SkillForm) => {
    try {
      if (editing) {
        await updateSkill(form.name!, form);
      } else {
        await createSkill(form);
      }
      setModalOpen(false);
      setEditing(null);
    } catch {
      /* error handled in store */
    }
  };

  const handleDelete = async (name: string) => {
    if (!window.confirm(`确定删除 Skill "${name}" 吗？`)) return;
    try {
      await deleteSkill(name);
      if (selected === name) setSelected(null);
    } catch {
      /* error handled in store */
    }
  };

  return (
    <div className="page catalog-page" role="region" aria-label="Skills" tabIndex={0}>
      <PageHeader title={`Skills（${skills.length}）`}>
        <button
          className="btn-primary"
          onClick={() => { setEditing(null); setModalOpen(true); }}
          type="button"
          title="新建 Skill"
        >
          ＋ 新建
        </button>
      </PageHeader>
      <div className="page-body catalog-body">
        <DraftSkillsSection onChanged={loadSkills} />
        <ul className="cat-list catalog-grid" aria-label="技能列表">
          {skills.length === 0 && <li className="cat-empty">暂无 Skill</li>}
          {skills.map((s) => (
            <li key={s.name}>
              <button
                className={selected === s.name ? "cat-item active" : "cat-item"}
                onClick={() => setSelected(s.name)}
                type="button"
                aria-pressed={selected === s.name}
                aria-controls="skill-detail"
              >
                <span className="cat-name">{s.name}</span>
                {s.category && <span className="cat-tag">{s.category}</span>}
                {s.builtin && <span className="cat-tag">内置</span>}
                {s.disabled && <span className="cat-tag">已停用</span>}
                {s.description && <span className="cat-desc">{s.description}</span>}
              </button>
            </li>
          ))}
        </ul>
        <div className="cat-detail" id="skill-detail" role="region" aria-label="技能详情" aria-busy={detailLoading}>
          {!selected && <div className="cat-empty">选择一个 Skill 查看详情</div>}
          {selected && detail?.name === selected && !detailLoading && (
            <>
              <div className="cat-detail-head">
                <h2>{detail.name}</h2>
                {detail.version && <span className="cat-tag">v{detail.version}</span>}
                {detail.category && <span className="cat-tag">{detail.category}</span>}
              </div>
              {detail.description && <p className="cat-detail-desc">{detail.description}</p>}
              {detail.is_knowledge_only && (
                <span className="cat-tag">纯知识</span>
              )}
              {detail.provides_tools && detail.provides_tools.length > 0 && (
                <div className="cat-tools">
                  <div className="cat-subhead">提供工具</div>
                  <div className="cat-tool-chips">
                    {detail.provides_tools.map((t) => (
                      <span className="cat-tool-chip" key={t}>{t}</span>
                    ))}
                  </div>
                </div>
              )}
              {detail.scripts && detail.scripts.length > 0 && (
                <div className="cat-tools">
                  <div className="cat-subhead">脚本（{detail.scripts.length}）</div>
                  <ul className="cat-file-list">
                    {detail.scripts.map((s) => <li key={s}>{s}</li>)}
                  </ul>
                </div>
              )}
              {detail.references && detail.references.length > 0 && (
                <div className="cat-tools">
                  <div className="cat-subhead">参考文档（{detail.references.length}）</div>
                  <ul className="cat-file-list">
                    {detail.references.map((r) => <li key={r}>{r}</li>)}
                  </ul>
                </div>
              )}
              {detail.assets && detail.assets.length > 0 && (
                <div className="cat-tools">
                  <div className="cat-subhead">资源（{detail.assets.length}）</div>
                  <ul className="cat-file-list">
                    {detail.assets.map((a) => <li key={a}>{a}</li>)}
                  </ul>
                </div>
              )}
              {detail.prompt && (
                <div className="cat-prompt">
                  <div className="cat-subhead">SKILL.md</div>
                  <pre>{detail.prompt}</pre>
                </div>
              )}
              <div className="task-detail-actions" style={{ marginTop: "1rem" }}>
                {isBuiltIn ? (
                  <button
                    className="btn-secondary"
                    onClick={() => setSkillDisabled(detail.name, !detail.disabled)}
                    type="button"
                    disabled={skillSaving}
                  >
                    {detail.disabled ? "启用" : "停用"}
                  </button>
                ) : (
                  <>
                    <button className="btn-secondary" onClick={handleEdit} type="button">编辑</button>
                    <button
                      className="btn-secondary"
                      onClick={() => handleDelete(detail.name)}
                      type="button"
                      disabled={skillSaving}
                    >
                      删除
                    </button>
                  </>
                )}
              </div>
            </>
          )}
          {selected && detailLoading && <div className="cat-empty">加载中…</div>}
          {selected && !detailLoading && !detail && <div className="cat-empty">无法加载该 Skill</div>}
        </div>
      </div>
      <SkillEditModal
        open={modalOpen}
        editing={editing}
        onClose={() => setModalOpen(false)}
        onSave={handleSave}
        saving={skillSaving}
        error={skillError}
      />
    </div>
  );
}
