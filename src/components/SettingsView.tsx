import { useEffect, useState } from "react";
import PageHeader from "./PageHeader";
import { useConfigStore, type ModelForm, type ProviderFormEntry, type ModelEntry } from "../state/config-store";
import { useChatStore } from "../state/chat-store";
import { useFeedbackStore, buildFeedbackMailto, type FeedbackForm } from "../state/feedback-store";
import { useUiStore } from "../state/ui-store";
import { openUrl } from "../lib/open-file";
import SettingsNav, { type Tab } from "./SettingsNav";
import { CURATED_PROVIDERS, getCuratedModels, getProviderDef } from "../lib/providers";
import ProviderIcon from "./ProviderIcon";

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
          {tab === "feedback" && <FeedbackTab />}
        </div>
      </div>
    </div>
  );
}

/* ── 模型 tab：左 provider 列表 + 右详情（master-detail，配置即可用） ── */
function ModelTab() {
  const model = useConfigStore((s) => s.model);
  const providers = useConfigStore((s) => s.providers);
  const envOverrides = useConfigStore((s) => s.envOverrides);
  const loading = useConfigStore((s) => s.loading);
  const saving = useConfigStore((s) => s.saving);
  const savedAt = useConfigStore((s) => s.savedAt);
  const reloadFailed = useConfigStore((s) => s.reloadFailed);
  const error = useConfigStore((s) => s.error);
  const load = useConfigStore((s) => s.load);
  const save = useConfigStore((s) => s.save);
  const switchActive = useConfigStore((s) => s.switchActive);
  const testConnection = useConfigStore((s) => s.testConnection);
  const fetchRemoteModels = useConfigStore((s) => s.fetchRemoteModels);
  const clearSaved = useConfigStore((s) => s.clearSaved);
  const showToast = useUiStore((s) => s.showToast);

  // form: editable catalog (id/name/baseURL/apiKey/models). Built from the
  // authoritative store.providers. The "启用集" checkbox is GONE — every model
  // in the form is automatically usable in the Composer (配置即可用).
  const [form, setForm] = useState<Record<string, ProviderFormEntry>>({});
  const [order, setOrder] = useState<string[]>([]);
  // Selected provider in the left list (master-detail).
  const [selectedId, setSelectedId] = useState<string>("");
  const [newModelName, setNewModelName] = useState<Record<string, string>>({});
  // Per-provider UI state: advanced toggle, connection test, model fetch.
  const [advancedOpen, setAdvancedOpen] = useState<Record<string, boolean>>({});
  const [testing, setTesting] = useState<Record<string, boolean>>({});
  const [testResult, setTestResult] = useState<Record<string, { ok: boolean; error: string | null } | null>>({});
  const [fetching, setFetching] = useState<Record<string, boolean>>({});

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!model) return;
    clearSaved();
    const savedMap = new Map((providers || []).map((p) => [p.id, p]));
    const next: Record<string, ProviderFormEntry> = {};
    const nextOrder: string[] = [];
    // Curated providers first, in canonical order.
    for (const def of CURATED_PROVIDERS) {
      const saved = savedMap.get(def.id);
      next[def.id] = {
        id: def.id,
        name: def.name,
        baseURL: saved?.baseURL ?? def.baseURL,
        apiKey: "", // password never prefilled; empty = keep on disk
        models: (saved?.models || []).map((m) => ({
          name: m.name,
          maxTokens: m.maxTokens ?? null,
          contextSize: m.contextSize ?? null,
          temperature: m.temperature ?? null,
          supportsVision: m.supportsVision ?? false,
        })),
      };
      nextOrder.push(def.id);
      savedMap.delete(def.id);
    }
    // Any remaining (non-curated / user-added) providers.
    for (const saved of savedMap.values()) {
      next[saved.id] = {
        id: saved.id,
        name: saved.name,
        baseURL: saved.baseURL,
        apiKey: "",
        models: (saved.models || []).map((m) => ({
          name: m.name,
          maxTokens: m.maxTokens ?? null,
          contextSize: m.contextSize ?? null,
          temperature: m.temperature ?? null,
          supportsVision: m.supportsVision ?? false,
        })),
      };
      nextOrder.push(saved.id);
    }
    setForm(next);
    setOrder(nextOrder);
    setNewModelName({});
  }, [model, providers, clearSaved]);

  // Auto-select a provider: prefer one with a configured key, else the first.
  useEffect(() => {
    if (selectedId && form[selectedId]) return;
    const firstReady = order.find((id) => providers.find((p) => p.id === id)?.apiKeyPresent);
    setSelectedId(firstReady ?? order[0] ?? "");
  }, [order, form, selectedId, providers]);

  if (loading || !model) {
    return <div className="cat-empty">{error || "加载中…"}</div>;
  }

  const selected = selectedId ? form[selectedId] : null;
  const selectedDef = selectedId ? getProviderDef(selectedId) : undefined;
  const selectedSaved = providers.find((x) => x.id === selectedId);
  const selectedKeyPresent = selectedSaved?.apiKeyPresent ?? false;

  function patchProvider(id: string, patch: Partial<ProviderFormEntry>) {
    clearSaved();
    setForm((f) => ({ ...f, [id]: { ...f[id], ...patch } }));
  }
  function addModel(id: string, name: string) {
    const trimmed = name.trim();
    if (!trimmed) return;
    clearSaved();
    setForm((f) => {
      const p = f[id];
      if (!p || p.models.some((m) => m.name === trimmed)) return f;
      return {
        ...f,
        [id]: {
          ...p,
          models: [...p.models, { name: trimmed, maxTokens: null, contextSize: null, temperature: null, supportsVision: false }],
        },
      };
    });
  }
  function removeModel(id: string, name: string) {
    clearSaved();
    setForm((f) => {
      const p = f[id];
      if (!p) return f;
      return { ...f, [id]: { ...p, models: p.models.filter((m) => m.name !== name) } };
    });
  }
  function setModelField<K extends keyof ModelEntry>(id: string, name: string, field: K, value: ModelEntry[K]) {
    clearSaved();
    setForm((f) => {
      const p = f[id];
      if (!p) return f;
      return {
        ...f,
        [id]: {
          ...p,
          models: p.models.map((m) => (m.name === name ? { ...m, [field]: value } : m)),
        },
      };
    });
  }
  /** 恢复官方推荐：把缺失的 curated 模型补回 form。 */
  function restoreDefaults(id: string) {
    clearSaved();
    const curated = getCuratedModels(id);
    if (curated.length === 0) return;
    setForm((f) => {
      const p = f[id];
      if (!p) return f;
      const existing = new Set(p.models.map((m) => m.name));
      const fresh = curated
        .filter((c) => !existing.has(c.name))
        .map((c) => ({
          name: c.name,
          maxTokens: c.maxTokens ?? null,
          supportsVision: c.supportsVision ?? false,
        }));
      if (fresh.length === 0) return f;
      return { ...f, [id]: { ...p, models: [...p.models, ...fresh] } };
    });
  }

  async function onTest(id: string) {
    const p = form[id];
    if (!p) return;
    setTesting((s) => ({ ...s, [id]: true }));
    setTestResult((s) => ({ ...s, [id]: null }));
    const res = await testConnection(id, { baseURL: p.baseURL, apiKey: p.apiKey });
    setTestResult((s) => ({ ...s, [id]: res }));
    setTesting((s) => ({ ...s, [id]: false }));
  }

  async function onFetch(id: string) {
    const p = form[id];
    if (!p) return;
    setFetching((s) => ({ ...s, [id]: true }));
    const res = await fetchRemoteModels(id, { baseURL: p.baseURL, apiKey: p.apiKey });
    setFetching((s) => ({ ...s, [id]: false }));
    if (!res.ok) {
      showToast(res.error || "拉取失败");
      return;
    }
    const have = new Set(p.models.map((m) => m.name));
    const fresh = (res.models || []).filter((m) => !have.has(m));
    if (fresh.length === 0) {
      showToast("未发现新模型");
      return;
    }
    clearSaved();
    setForm((f) => {
      const pp = f[id];
      if (!pp) return f;
      return {
        ...f,
        [id]: {
          ...pp,
          models: [...pp.models, ...fresh.map((m) => ({ name: m, maxTokens: null, contextSize: null, temperature: null, supportsVision: false }))],
        },
      };
    });
    showToast(`已添加 ${fresh.length} 个模型`);
  }

  async function onSetDefault(id: string, name: string) {
    const ok = await switchActive(id, name);
    if (!ok) showToast("设置默认模型失败");
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    // 配置即可用：所有 form 中的模型都自动进入启用集，无需二次勾选。
    const enabledList: { provider: string; model: string }[] = [];
    for (const id of order) {
      const p = form[id];
      if (!p) continue;
      for (const m of p.models) enabledList.push({ provider: id, model: m.name });
    }
    const resolved = useConfigStore.getState().resolveActiveModel(null);
    const providerList = order.map((id) => form[id]).filter((p): p is ProviderFormEntry => !!p && !!p.id);
    await save({
      provider: resolved?.provider ?? "",
      model: resolved?.model ?? "",
      enabledModels: enabledList,
      providers: providerList,
    });
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
      <form className="settings-form model-providers" onSubmit={onSubmit}>
        <div className="model-providers-hint">
          <span className="hint-icon">💡</span>
          <span>
            左侧选择服务商配置 API Key 与模型，配置好的模型会直接出现在聊天框下拉。点模型行的「设为默认」可指定默认模型。
          </span>
        </div>

        <div className="provider-master-detail">
          {/* 左：provider 列表 */}
          <div className="provider-list">
            {order.map((id) => {
              const def = getProviderDef(id);
              const p = form[id];
              if (!p) return null;
              const saved = providers.find((x) => x.id === id);
              const keyPresent = saved?.apiKeyPresent ?? false;
              const isLocal = id === "ollama";
              const ready = keyPresent || isLocal;
              return (
                <button
                  type="button"
                  key={id}
                  className={`provider-list-item${selectedId === id ? " active" : ""}`}
                  onClick={() => setSelectedId(id)}
                >
                  <span className="provider-list-icon">
                    <ProviderIcon provider={id} />
                  </span>
                  <span className="provider-list-name">{def?.name ?? p.name ?? id}</span>
                  <span
                    className={`provider-list-status${ready ? " ready" : ""}`}
                    title={ready ? "已配置" : "未配置 API Key"}
                  />
                  {p.models.length > 0 && <span className="provider-list-count">{p.models.length}</span>}
                </button>
              );
            })}
          </div>

          {/* 右：详情 */}
          <div className="provider-detail">
            {!selected ? (
              <div className="cat-empty">请在左侧选择一个服务商</div>
            ) : (
              <>
                <div className="provider-card-head">
                  <div className="provider-title">
                    <span className="provider-icon">
                      <ProviderIcon provider={selectedId} />
                    </span>
                    <span className="provider-name-static">{selectedDef?.name ?? selected.name ?? selectedId}</span>
                  </div>
                  {selectedDef?.docsURL && (
                    <button
                      className="provider-docs"
                      onClick={(e) => { e.stopPropagation(); openUrl(selectedDef.docsURL); }}
                      title="打开官方文档"
                      type="button"
                    >
                      文档
                    </button>
                  )}
                </div>

                <div className="provider-fields">
                  {(selectedDef?.editableBaseURL ?? true) && (
                    <label className="field">
                      <span className="field-label">Base URL</span>
                      <input
                        value={selected.baseURL}
                        onChange={(e) => patchProvider(selectedId, { baseURL: e.target.value })}
                        placeholder="https://api.example.com/v1"
                      />
                    </label>
                  )}
                  <label className="field api-key-field">
                    <span className="field-label">
                      API Key {selectedKeyPresent && !selected.apiKey && <em>（已设置）</em>}
                    </span>
                    <div className="api-key-row">
                      <input
                        type="password"
                        value={selected.apiKey}
                        onChange={(e) => patchProvider(selectedId, { apiKey: e.target.value })}
                        placeholder={selectedKeyPresent ? "••••••（留空保持原值）" : "输入 API Key"}
                        autoComplete="off"
                      />
                      <button
                        type="button"
                        className="btn-secondary test-btn"
                        onClick={() => onTest(selectedId)}
                        disabled={testing[selectedId]}
                      >
                        {testing[selectedId] ? "检测中…" : "检测连接"}
                      </button>
                    </div>
                    {testResult[selectedId] && (
                      <div className={testResult[selectedId]!.ok ? "save-ok inline" : "env-warn inline"}>
                        {testResult[selectedId]!.ok ? "✓ 连接成功" : `✕ ${testResult[selectedId]!.error}`}
                      </div>
                    )}
                  </label>
                </div>

                <div className="model-section">
                  <div className="model-section-head">
                    <span className="model-section-title">模型</span>
                    <div className="model-section-actions">
                      <button
                        type="button"
                        className="btn-secondary fetch-btn"
                        onClick={() => onFetch(selectedId)}
                        disabled={fetching[selectedId]}
                        title="从服务商自动拉取可用模型列表"
                      >
                        {fetching[selectedId] ? "拉取中…" : "↻ 拉取模型"}
                      </button>
                      {selectedDef && getCuratedModels(selectedId).length > 0 && (
                        <button
                          type="button"
                          className="restore-defaults-btn"
                          onClick={() => restoreDefaults(selectedId)}
                          title="补回缺失的官方推荐模型"
                        >
                          ↻ 恢复官方推荐
                        </button>
                      )}
                      <button
                        type="button"
                        className="btn-secondary advanced-toggle"
                        onClick={() => setAdvancedOpen((s) => ({ ...s, [selectedId]: !s[selectedId] }))}
                        title="展开编辑最大输出 / 视觉等高级参数"
                      >
                        {advancedOpen[selectedId] ? "收起高级" : "高级"}
                      </button>
                    </div>
                  </div>

                  {selected.models.length === 0 ? (
                    <div className="model-empty">暂无模型，点「拉取模型」自动获取，或在下方手动添加。</div>
                  ) : (
                    <div className="model-rows">
                      {selected.models.map((m) => {
                        const isDefault = model?.provider === selectedId && model?.model === m.name;
                        const isLocal = selectedId === "ollama";
                        const canDefault = selectedKeyPresent || isLocal;
                        return (
                          <div key={m.name} className={`model-row${isDefault ? " default" : ""}`}>
                            <span className="model-name">{m.name}</span>
                            {m.supportsVision && <span className="model-vision-tag" title="支持图片">👁 视觉</span>}
                            {isDefault ? (
                              <span className="model-default-tag">默认</span>
                            ) : (
                              <button
                                type="button"
                                className="model-set-default"
                                onClick={() => onSetDefault(selectedId, m.name)}
                                disabled={!canDefault}
                                title={canDefault ? "设为默认模型" : "需先配置 API Key"}
                              >
                                设为默认
                              </button>
                            )}
                            {advancedOpen[selectedId] && (
                              <>
                                <select
                                  className="model-maxtokens"
                                  value={m.maxTokens ?? ""}
                                  onClick={(e) => e.stopPropagation()}
                                  onChange={(e) => setModelField(selectedId, m.name, "maxTokens", e.target.value === "" ? null : Number(e.target.value))}
                                  title="最大输出 Token"
                                >
                                  <option value="">默认</option>
                                  <option value="4096">4k</option>
                                  <option value="8192">8k</option>
                                  <option value="16384">16k</option>
                                  <option value="32768">32k</option>
                                  <option value="65536">64k</option>
                                  <option value="131072">128k</option>
                                </select>
                                <label
                                  className="model-vision-toggle"
                                  onClick={(e) => e.stopPropagation()}
                                  title="支持图片输入"
                                >
                                  <input
                                    type="checkbox"
                                    checked={!!m.supportsVision}
                                    onChange={(e) => setModelField(selectedId, m.name, "supportsVision", e.target.checked)}
                                  />
                                  视觉
                                </label>
                              </>
                            )}
                            <button
                              type="button"
                              className="model-remove"
                              aria-label={`移除 ${m.name}`}
                              title="移除模型"
                              onClick={(e) => { e.stopPropagation(); removeModel(selectedId, m.name); }}
                            >
                              ✕
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  )}

                  <div className="model-add">
                    <input
                      value={newModelName[selectedId] || ""}
                      onChange={(e) => setNewModelName((s) => ({ ...s, [selectedId]: e.target.value }))}
                      placeholder="手动添加模型，如 llama3.1:8b"
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          addModel(selectedId, newModelName[selectedId] || "");
                          setNewModelName((s) => ({ ...s, [selectedId]: "" }));
                        }
                      }}
                    />
                    <button
                      type="button"
                      className="btn-secondary"
                      onClick={() => {
                        addModel(selectedId, newModelName[selectedId] || "");
                        setNewModelName((s) => ({ ...s, [selectedId]: "" }));
                      }}
                    >
                      ＋ 添加
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>

        <button className="save-btn" type="submit" disabled={saving}>
          {saving ? "保存中…" : "保存并重载"}
        </button>
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
  const [confirmOpen, setConfirmOpen] = useState(false);

  useEffect(() => { loadPermissions(); }, [loadPermissions]);

  const options: { value: import("../state/config-store").PermissionMode; label: string; desc: string; danger?: boolean }[] = [
    { value: "always-trust", label: "完全信任", desc: "所有工具调用自动放行，不询问。", danger: true },
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
              onChange={() => {
                if (opt.value === "always-trust") {
                  setConfirmOpen(true);
                } else {
                  savePermissions(opt.value);
                }
              }}
              disabled={saving}
            />
            <span>
              <strong style={{ color: opt.danger ? "var(--red)" : undefined }}>{opt.label}</strong>
              <span style={{ display: "block", fontSize: "12px", color: "var(--muted)", marginTop: "0.1rem" }}>
                {opt.desc}
              </span>
            </span>
          </label>
        ))}
      </div>
      {saving && <div className="cat-empty">保存中…</div>}

      {confirmOpen && (
        <div className="modal-overlay" onClick={() => setConfirmOpen(false)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="modal-title" style={{ color: "var(--red)" }}>⚠️ 确认切换到「完全信任」模式？</div>
            <div style={{ fontSize: "13px", lineHeight: "1.6", color: "var(--fg-secondary)" }}>
              <p><strong>此模式非常危险，请仔细阅读以下说明：</strong></p>
              <ul style={{ paddingLeft: "1.2rem", margin: "0.4rem 0" }}>
                <li>开启后，FloodMind 将<strong>自动执行所有工具调用</strong>，包括 Bash 命令、文件写入/删除、网络请求等，<strong>不再弹出任何授权提示</strong>。</li>
                <li>如果智能体收到误导性、恶意或错误的指令，可能会在您的电脑上直接执行危险操作，例如读取敏感文件、修改系统配置或删除数据。</li>
                <li>除非您处于完全隔离、无敏感数据的环境，并且完全理解上述风险，否则<strong>不建议使用此模式</strong>。</li>
              </ul>
              <p><strong>确定要继续吗？</strong></p>
            </div>
            <div className="modal-actions">
              <button
                className="btn-secondary"
                type="button"
                onClick={() => setConfirmOpen(false)}
                disabled={saving}
              >
                取消
              </button>
              <button
                className="btn-primary"
                type="button"
                style={{ background: "var(--red)" }}
                onClick={async () => {
                  await savePermissions("always-trust");
                  setConfirmOpen(false);
                }}
                disabled={saving}
              >
                确认切换
              </button>
            </div>
          </div>
        </div>
      )}
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

/* ── 反馈 tab：问题反馈 ─────────────────────────────────────── */
function FeedbackTab() {
  const submit = useFeedbackStore((s) => s.submit);
  const submitting = useFeedbackStore((s) => s.submitting);
  const submittedAt = useFeedbackStore((s) => s.submittedAt);
  const error = useFeedbackStore((s) => s.error);
  const clear = useFeedbackStore((s) => s.clear);
  const [form, setForm] = useState<FeedbackForm>({
    description: "",
    includeLogs: true,
    contact: "",
  });
  // Feedback that was saved locally and is awaiting the user's consent to also
  // be emailed. We do NOT auto-open the mail client — prompt first.
  const [pendingMail, setPendingMail] = useState<FeedbackForm | null>(null);

  useEffect(() => {
    clear();
  }, [clear]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const ok = await submit(form);
    if (ok) {
      setPendingMail(form); // ask before launching the mail client
      setForm({ description: "", includeLogs: true, contact: "" });
    }
  }

  async function confirmSendEmail() {
    const formToSend = pendingMail;
    setPendingMail(null);
    if (!formToSend) return;
    try {
      await openUrl(buildFeedbackMailto(formToSend));
    } catch {
      // Best-effort: the feedback is already saved locally as a backup.
    }
  }

  return (
    <form className="settings-form feedback-form" onSubmit={onSubmit}>
      <p className="persona-hint">
        遇到问题？请描述复现步骤和期望结果。勾选「附带日志」会同时提交近期前端运行日志，方便定位问题。
      </p>
      {error && <div className="env-warn error">{error}</div>}
      {submittedAt && <div className="save-ok">✓ 反馈已保存</div>}
      {pendingMail && (
        <div className="modal-overlay" onClick={() => setPendingMail(null)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="modal-title">通过邮件发送反馈？</div>
            <div className="modal-notice">
              反馈已保存到本地。是否打开邮件客户端发送反馈？
              （邮件内容会自动填好，你确认发送即可）
            </div>
            <div className="modal-actions">
              <button className="btn-secondary" type="button" onClick={() => setPendingMail(null)}>暂不</button>
              <button className="btn-primary" type="button" onClick={confirmSendEmail}>发送邮件</button>
            </div>
          </div>
        </div>
      )}
      <label className="field">
        <span className="field-label">问题描述</span>
        <textarea
          aria-label="问题描述"
          rows={8}
          value={form.description}
          onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
          placeholder="请描述遇到的问题、复现步骤、期望结果…"
          disabled={submitting}
        />
      </label>
      <label className="field">
        <span className="field-label">联系方式（可选）</span>
        <input
          type="text"
          value={form.contact}
          onChange={(e) => setForm((f) => ({ ...f, contact: e.target.value }))}
          placeholder="邮箱 / 微信 / 其他联系方式"
          disabled={submitting}
        />
      </label>
      <label className="toggle" style={{ marginBottom: "0.75rem" }}>
        <input
          type="checkbox"
          checked={form.includeLogs}
          onChange={(e) => setForm((f) => ({ ...f, includeLogs: e.target.checked }))}
          disabled={submitting}
        />
        附带近期运行日志（不包含文件内容，仅前端控制台日志）
      </label>
      <button className="save-btn" type="submit" disabled={submitting || !form.description.trim()}>
        {submitting ? "提交中…" : "提交反馈"}
      </button>
    </form>
  );
}
