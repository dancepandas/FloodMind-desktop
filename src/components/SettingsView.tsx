import { useEffect, useState } from "react";
import PageHeader from "./PageHeader";
import { useConfigStore, type ModelForm } from "../state/config-store";

export default function SettingsView() {
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

  // Seed the form when the loaded model arrives (or the provider list changes).
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
    return (
      <div className="page">
        <PageHeader title="模型配置" />
        <div className="page-body">
          <div className="cat-empty">{error || "加载中…"}</div>
        </div>
      </div>
    );
  }

  const providerModels = providers.find((p) => p.id === form.provider)?.models || [];
  // Editing any field dismisses the stale save toast.
  const set = (patch: Partial<ModelForm>) => {
    clearSaved();
    setForm((f) => (f ? { ...f, ...patch } : f));
  };

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (form) await save(form);
  }

  return (
    <div className="page">
      <PageHeader title="模型配置" />
      <div className="page-body settings-body">
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
              // Switching provider resets the key (a key typed for A must not be
              // written into B's options) and the base URL / model.
              clearSaved();
              setForm((f) => f ? { ...f, provider: pid, apiKey: "", baseURL: p?.baseURL || "", model: p?.models?.[0] || "" } : f);
            }}>
              {providers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} ({p.id})
                </option>
              ))}
            </select>
          </label>

          <label className="field">
            <span className="field-label">模型</span>
            <input
              list="model-options"
              value={form.model}
              onChange={(e) => set({ model: e.target.value })}
              placeholder="模型 ID"
            />
            <datalist id="model-options">
              {providerModels.map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
          </label>

          <label className="field">
            <span className="field-label">
              API Key {apiKeyPresent && !form.apiKey && <em>（已设置，留空保持不变）</em>}
            </span>
            <input
              type="password"
              value={form.apiKey}
              onChange={(e) => set({ apiKey: e.target.value })}
              placeholder={apiKeyPresent ? "••••••（留空不修改）" : "输入 API Key"}
              autoComplete="off"
            />
          </label>

          <label className="field">
            <span className="field-label">Base URL</span>
            <input value={form.baseURL} onChange={(e) => set({ baseURL: e.target.value })} placeholder="https://…" />
          </label>

          <div className="field-row">
            <label className="field">
              <span className="field-label">温度（0–2）</span>
              <input
                type="number"
                step="0.1"
                min="0"
                max="2"
                value={form.temperature}
                onChange={(e) => set({ temperature: parseFloat(e.target.value) || 0 })}
              />
            </label>
            <label className="field">
              <span className="field-label">最大 Token</span>
              <input
                type="number"
                step="1"
                min="1"
                value={form.maxTokens}
                onChange={(e) => set({ maxTokens: Math.trunc(parseInt(e.target.value, 10) || 0) })}
              />
            </label>
          </div>

          <div className="field-row toggles">
            <label className="toggle">
              <input
                type="checkbox"
                checked={form.enableReasoning}
                onChange={(e) => set({ enableReasoning: e.target.checked })}
              />
              推理模式
            </label>
            <label className="toggle">
              <input
                type="checkbox"
                checked={form.enableSearch}
                onChange={(e) => set({ enableSearch: e.target.checked })}
              />
              联网搜索
            </label>
          </div>

          <button className="save-btn" type="submit" disabled={saving}>
            {saving ? "保存中…" : "保存并重载"}
          </button>
        </form>
      </div>
    </div>
  );
}
