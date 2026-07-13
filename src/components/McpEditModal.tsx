import { useEffect, useState } from "react";
import type { McpServerForm } from "../state/catalog-store";

interface Props {
  open: boolean;
  editing: McpServerForm | null;
  onClose: () => void;
  onSave: (server: McpServerForm) => void;
  saving: boolean;
  error: string | null;
}

function parseArgs(text: string): string[] {
  return text.split("\n").map((s) => s.trim()).filter(Boolean);
}

function stringifyArgs(args: string[]): string {
  return args.join("\n");
}

export default function McpEditModal({ open, editing, onClose, onSave, saving, error }: Props) {
  const [form, setForm] = useState<McpServerForm>({
    name: "",
    transport: "stdio",
    command: "",
    args: [],
    env: {},
    url: "",
  });
  const [argsText, setArgsText] = useState("");
  const [envList, setEnvList] = useState<{ key: string; value: string }[]>([]);

  useEffect(() => {
    if (open) {
      const base = editing || {
        name: "",
        transport: "stdio" as const,
        command: "",
        args: [],
        env: {},
        url: "",
      };
      setForm(base);
      setArgsText(stringifyArgs(base.args || []));
      setEnvList(Object.entries(base.env || {}).map(([key, value]) => ({ key, value })));
    }
  }, [open, editing]);

  if (!open) return null;

  const isEdit = !!editing;
  const canSave = (form.name?.trim() !== "" || isEdit) && (form.transport === "sse" ? form.url : form.command);

  const handleSave = () => {
    const env: Record<string, string> = {};
    for (const { key, value } of envList) {
      if (key.trim()) env[key.trim()] = value;
    }
    onSave({ ...form, args: parseArgs(argsText), env });
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-title">{isEdit ? "编辑 MCP 服务器" : "新建 MCP 服务器"}</div>
        {error && <div className="modal-error">{error}</div>}
        <label className="modal-label">
          名称
          <input
            className="modal-textarea"
            value={form.name}
            disabled={isEdit}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
        </label>
        <label className="modal-label">
          传输类型
          <select
            className="modal-textarea"
            value={form.transport}
            onChange={(e) => setForm({ ...form, transport: e.target.value as "stdio" | "sse" })}
          >
            <option value="stdio">stdio（本地命令）</option>
            <option value="sse">sse（HTTP 流）</option>
          </select>
        </label>
        {form.transport === "stdio" ? (
          <>
            <label className="modal-label">
              命令
              <input
                className="modal-textarea"
                value={form.command}
                onChange={(e) => setForm({ ...form, command: e.target.value })}
              />
            </label>
            <label className="modal-label">
              参数（每行一个）
              <textarea
                className="modal-textarea"
                rows={4}
                value={argsText}
                onChange={(e) => setArgsText(e.target.value)}
              />
            </label>
          </>
        ) : (
          <label className="modal-label">
            URL
            <input
              className="modal-textarea"
              value={form.url}
              onChange={(e) => setForm({ ...form, url: e.target.value })}
            />
          </label>
        )}
        <div className="modal-label">
          环境变量
          {envList.map((entry, idx) => (
            <div key={idx} className="modal-row">
              <input
                className="modal-textarea"
                placeholder="KEY"
                value={entry.key}
                onChange={(e) => {
                  const next = [...envList];
                  next[idx].key = e.target.value;
                  setEnvList(next);
                }}
              />
              <input
                className="modal-textarea"
                placeholder="value"
                value={entry.value}
                onChange={(e) => {
                  const next = [...envList];
                  next[idx].value = e.target.value;
                  setEnvList(next);
                }}
              />
              <button
                className="btn-secondary"
                type="button"
                onClick={() => setEnvList(envList.filter((_, i) => i !== idx))}
              >
                删除
              </button>
            </div>
          ))}
          <button className="btn-secondary" type="button" onClick={() => setEnvList([...envList, { key: "", value: "" }])}>
            ＋ 添加
          </button>
        </div>
        <div className="modal-actions">
          <button className="btn-secondary" onClick={onClose} type="button" disabled={saving}>取消</button>
          <button className="btn-primary" onClick={handleSave} type="button" disabled={!canSave || saving}>
            {saving ? "保存中…" : "保存"}
          </button>
        </div>
      </div>
    </div>
  );
}
