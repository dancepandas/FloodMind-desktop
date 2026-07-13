import { useEffect, useState } from "react";
import type { SkillForm } from "../state/catalog-store";

interface Props {
  open: boolean;
  editing: SkillForm | null;
  onClose: () => void;
  onSave: (skill: SkillForm) => void;
  saving: boolean;
  error: string | null;
}

export default function SkillEditModal({ open, editing, onClose, onSave, saving, error }: Props) {
  const [form, setForm] = useState<SkillForm>({
    name: "",
    description: "",
    category: "execution",
    version: "1.0",
    prompt: "",
  });

  useEffect(() => {
    if (open) {
      setForm(
        editing || {
          name: "",
          description: "",
          category: "execution",
          version: "1.0",
          prompt: "",
        }
      );
    }
  }, [open, editing]);

  if (!open) return null;

  const isEdit = !!editing;
  const canSave = (form.name ?? "").trim() !== "" || isEdit;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-title">{isEdit ? "编辑 Skill" : "新建 Skill"}</div>
        {error && <div className="modal-error">{error}</div>}
        <label className="modal-label">
          名称
          <input
            className="modal-textarea"
            value={form.name}
            disabled={isEdit}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            placeholder="my-skill"
          />
        </label>
        <label className="modal-label">
          描述
          <input
            className="modal-textarea"
            value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
          />
        </label>
        <label className="modal-label">
          分类
          <input
            className="modal-textarea"
            value={form.category}
            onChange={(e) => setForm({ ...form, category: e.target.value })}
          />
        </label>
        <label className="modal-label">
          版本
          <input
            className="modal-textarea"
            value={form.version}
            onChange={(e) => setForm({ ...form, version: e.target.value })}
          />
        </label>
        <label className="modal-label">
          SKILL.md
          <textarea
            className="modal-textarea"
            rows={10}
            value={form.prompt}
            onChange={(e) => setForm({ ...form, prompt: e.target.value })}
          />
        </label>
        <div className="modal-actions">
          <button className="btn-secondary" onClick={onClose} type="button" disabled={saving}>
            取消
          </button>
          <button
            className="btn-primary"
            onClick={() => onSave(form)}
            type="button"
            disabled={!canSave || saving}
          >
            {saving ? "保存中…" : "保存"}
          </button>
        </div>
      </div>
    </div>
  );
}
