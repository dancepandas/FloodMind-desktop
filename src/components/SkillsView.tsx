import { useEffect, useState } from "react";
import PageHeader from "./PageHeader";
import { useCatalogStore, type SkillForm } from "../state/catalog-store";
import SkillEditModal from "./SkillEditModal";

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
    <div className="page">
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
                      <span className="cat-tool-chip" key={t}>{t}</span>
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
          {selected && !detailLoading && !detail && <div className="cat-empty">无法加载该技能</div>}
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
