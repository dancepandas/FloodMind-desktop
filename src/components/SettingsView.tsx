import { useEffect, useState } from "react";
import PageHeader from "./PageHeader";
import { useConfigStore, type ModelForm } from "../state/config-store";
import { useChatStore } from "../state/chat-store";
import SettingsNav, { type Tab } from "./SettingsNav";

export default function SettingsView() {
  const [tab, setTab] = useState<Tab>("model");
  return (
    <div className="page">
      <PageHeader title="设置" />
      <div className="page-body settings-layout">
        <SettingsNav active={tab} onChange={setTab} />
        <div className="settings-content">
          {tab === "model" && <ModelTab />}
          {tab === "identity" && <IdentityTab />}
          {tab === "rules" && <RulesTab />}
          {tab === "permissions" && <PermissionsTab />}
        </div>
      </div>
    </div>
  );
}

/* ── 模型 tab：原 SettingsView 表单 ───────────────────────────── */
function ModelTab() {
  const model = useConfigStore((s) => s.model);
  const providers = useConfigStore((s) => s.providers);
  const apiKeyPresent = useConfigStore((s) => s.apiKeyPresent);
  const baseURL = useConfigStore((s) => s.baseURL);
  const envOverrides = useConfigStore((s) => s.envOverrides);
  const loading = useConfigStore((s) => s.loading);
  const saving = useConfigStore((s) => s.saving);
  const savedAt = useConfigStore((s) => s.savedAt);
  const reloadFailed = useConfigStore((s) => s.reloadFailed);
  const error = useConfigStore((s) => s.error);
  const load = useConfigStore((s) => s.load);
  const save = useConfigStore((s) => s.save);
  const clearSaved = useConfigStore((s) => s.clearSaved);

  const [form, setForm] = useState<ModelForm | null>(null);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (model) {
      setForm({
        provider: model.provider,
        model: model.model,
        apiKey: "",
        baseURL,
        temperature: model.temperature,
        maxTokens: model.maxTokens,
        enableReasoning: model.enableReasoning,
        enableSearch: model.enableSearch,
      });
    }
  }, [model, baseURL]);

  if (loading || !form) {
    return <div className="cat-empty">{error || "加载中…"}</div>;
  }

  const providerModels = providers.find((p) => p.id === form.provider)?.models || [];
  const set = (patch: Partial<ModelForm>) => {
    clearSaved();
    setForm((f) => (f ? { ...f, ...patch } : f));
  };

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (form) await save(form);
  }

  return (
    <>
      {envOverrides.length > 0 && (
        <div className="env-warn">
          ⚠ 以下环境变量正在覆盖配置文件，GUI 修改不会生效：{envOverrides.join(", ")}
        </div>
      )}
      {error && <div className="env-warn error">{error}</div>}
      {savedAt && (
        <div className={reloadFailed ? "env-warn" : "save-ok"}>
          {reloadFailed ? "⚠ 已保存，但热重载失败——重启后生效" : "✓ 已保存并重载模型"}
        </div>
      )}
      <form className="settings-form" onSubmit={onSubmit}>
        <label className="field">
          <span className="field-label">服务商</span>
          <select value={form.provider} onChange={(e) => {
            const pid = e.target.value;
            const p = providers.find((x) => x.id === pid);
            clearSaved();
            setForm((f) => f ? { ...f, provider: pid, apiKey: "", baseURL: p?.baseURL || "", model: p?.models?.[0] || "" } : f);
          }}>
            {providers.map((p) => (
              <option key={p.id} value={p.id}>{p.name} ({p.id})</option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="field-label">模型</span>
          <input list="model-options" value={form.model} onChange={(e) => set({ model: e.target.value })} placeholder="模型 ID" />
          <datalist id="model-options">
            {providerModels.map((m) => (<option key={m} value={m} />))}
          </datalist>
        </label>
        <label className="field">
          <span className="field-label">API Key {apiKeyPresent && !form.apiKey && <em>（已设置，留空保持不变）</em>}</span>
          <input type="password" value={form.apiKey} onChange={(e) => set({ apiKey: e.target.value })} placeholder={apiKeyPresent ? "••••••（留空不修改）" : "输入 API Key"} autoComplete="off" />
        </label>
        <label className="field">
          <span className="field-label">Base URL</span>
          <input value={form.baseURL} onChange={(e) => set({ baseURL: e.target.value })} placeholder="https://…" />
        </label>
        <div className="field-row">
          <label className="field">
            <span className="field-label">温度（0–2）</span>
            <input type="number" step="0.1" min="0" max="2" value={form.temperature} onChange={(e) => set({ temperature: parseFloat(e.target.value) || 0 })} />
          </label>
          <label className="field">
            <span className="field-label">最大 Token</span>
            <input type="number" step="1" min="1" value={form.maxTokens} onChange={(e) => set({ maxTokens: Math.trunc(parseInt(e.target.value, 10) || 0) })} />
          </label>
        </div>
        <div className="field-row toggles">
          <label className="toggle">
            <input type="checkbox" checked={form.enableReasoning} onChange={(e) => set({ enableReasoning: e.target.checked })} /> 推理模式
          </label>
          <label className="toggle">
            <input type="checkbox" checked={form.enableSearch} onChange={(e) => set({ enableSearch: e.target.checked })} /> 联网搜索
          </label>
        </div>
        <button className="save-btn" type="submit" disabled={saving}>{saving ? "保存中…" : "保存并重载"}</button>
      </form>
    </>
  );
}

/* ── 身份 tab：SOUL.md ───────────────────────────────────────── */
function IdentityTab() {
  const soul = useConfigStore((s) => s.soul);
  const isDefault = useConfigStore((s) => s.soulIsDefault);
  const loading = useConfigStore((s) => s.personaLoading);
  const saving = useConfigStore((s) => s.personaSaving);
  const error = useConfigStore((s) => s.personaError);
  const loadPersona = useConfigStore((s) => s.loadPersona);
  const saveSoul = useConfigStore((s) => s.saveSoul);
  const resetSoul = useConfigStore((s) => s.resetSoul);
  const streaming = useChatStore((s) => s.streaming);
  const [draft, setDraft] = useState(soul);

  useEffect(() => { loadPersona(); }, [loadPersona]);
  useEffect(() => { setDraft(soul); }, [soul]);

  const over = draft.length > 20000;
  const dirty = draft !== soul;
  const canSave = !streaming && !saving && dirty && !over;

  if (loading) return <div className="cat-empty">加载中…</div>;
  return (
    <div className="persona-editor">
      <p className="persona-hint">SOUL.md 决定智能体的身份与职责，对所有会话生效。</p>
      {error && <div className="env-warn error">{error}</div>}
      <textarea
        aria-label="SOUL.md 编辑器"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        rows={16}
      />
      <div className="persona-bottom">
        <span className={`char-counter${over ? " over" : ""}`}>{draft.length} / 20000</span>
        <div className="persona-actions">
          <button type="button" className="btn-secondary" onClick={() => resetSoul()} disabled={streaming || saving || isDefault}>恢复默认</button>
          <button type="button" className="save-btn" onClick={() => saveSoul(draft)} disabled={!canSave}>
            {saving ? "保存中…" : "保存"}
          </button>
        </div>
      </div>
      {streaming && <div className="env-warn">任务执行中，结束后保存生效。</div>}
    </div>
  );
}

/* ── 权限 tab：工具授权模式 ─────────────────────────────────── */
function PermissionsTab() {
  const mode = useConfigStore((s) => s.permissionMode);
  const loading = useConfigStore((s) => s.permissionLoading);
  const saving = useConfigStore((s) => s.permissionSaving);
  const savedAt = useConfigStore((s) => s.permissionSavedAt);
  const error = useConfigStore((s) => s.permissionError);
  const loadPermissions = useConfigStore((s) => s.loadPermissions);
  const savePermissions = useConfigStore((s) => s.savePermissions);

  useEffect(() => { loadPermissions(); }, [loadPermissions]);

  const options: { value: import("../state/config-store").PermissionMode; label: string; desc: string }[] = [
    { value: "always-trust", label: "完全信任", desc: "所有工具调用自动放行，不询问。" },
    { value: "trust-once", label: "首次询问", desc: "同一命令第一次执行时询问，同意后后续自动放行。" },
    { value: "always-ask", label: "每次都问", desc: "每次工具调用前都必须手动授权。" },
  ];

  if (loading) return <div className="cat-empty">加载中…</div>;
  return (
    <div className="settings-form">
      {error && <div className="env-warn error">{error}</div>}
      {savedAt && <div className="save-ok">✓ 已保存</div>}
      <div className="field" role="radiogroup" aria-label="工具权限模式">
        <span className="field-label">工具执行授权</span>
        {options.map((opt) => (
          <label key={opt.value} className="toggle" style={{ marginBottom: "0.35rem" }}>
            <input
              type="radio"
              name="permission-mode"
              value={opt.value}
              checked={mode === opt.value}
              onChange={() => savePermissions(opt.value)}
              disabled={saving}
            />
            <span>
              <strong>{opt.label}</strong>
              <span style={{ display: "block", fontSize: "12px", color: "var(--muted)", marginTop: "0.1rem" }}>
                {opt.desc}
              </span>
            </span>
          </label>
        ))}
      </div>
      {saving && <div className="cat-empty">保存中…</div>}
    </div>
  );
}

/* ── 规则 tab：全局 AGENTS.md ────────────────────────────────── */
function RulesTab() {
  const agents = useConfigStore((s) => s.agents);
  const loading = useConfigStore((s) => s.personaLoading);
  const saving = useConfigStore((s) => s.personaSaving);
  const error = useConfigStore((s) => s.personaError);
  const loadPersona = useConfigStore((s) => s.loadPersona);
  const saveAgents = useConfigStore((s) => s.saveAgents);
  const streaming = useChatStore((s) => s.streaming);
  const [draft, setDraft] = useState(agents);

  useEffect(() => { loadPersona(); }, [loadPersona]);
  useEffect(() => { setDraft(agents); }, [agents]);

  const dirty = draft !== agents;
  const canSave = !streaming && !saving && dirty;

  if (loading) return <div className="cat-empty">加载中…</div>;
  return (
    <div className="persona-editor">
      <p className="persona-hint">全局行为规则（AGENTS.md）：绘图风格、文档模板、用词偏好等。留空则无全局规则。</p>
      {error && <div className="env-warn error">{error}</div>}
      <textarea
        aria-label="AGENTS.md 编辑器"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        rows={16}
      />
      <div className="persona-bottom">
        <span className="char-counter">{draft.length} 字符</span>
        <button type="button" className="save-btn" onClick={() => saveAgents(draft)} disabled={!canSave}>
          {saving ? "保存中…" : "保存"}
        </button>
      </div>
      {streaming && <div className="env-warn">任务执行中，结束后保存生效。</div>}
    </div>
  );
}
