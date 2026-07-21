import { create } from "zustand";
import { getBaseUrl } from "../lib/sidecar-client";
import { CURATED_PROVIDERS, CURATED_PROVIDER_IDS, getProviderDef, getTierDefaultTokens } from "../lib/providers";

export interface ModelConfig {
  provider: string;
  model: string;
  temperature: number;
  maxTokens: number;
  enableReasoning: boolean;
  enableSearch: boolean;
  supportsVision: boolean;
}
export interface ModelEntry {
  name: string;
  maxTokens: number | null; // null = 默认 (use SDK preset / safe fallback)
  /** Context-window size in tokens; only meaningful for custom OpenAI/Ollama models. */
  contextSize?: number | null;
  /** Per-model temperature; only meaningful for custom OpenAI/Ollama models. */
  temperature?: number | null;
  /** 该模型是否接受 image_url 多模态输入。未核实的模型默认 false。 */
  supportsVision?: boolean;
}
export interface ProviderInfo {
  id: string;
  name: string;
  baseURL: string;
  models: ModelEntry[];
  apiKeyPresent: boolean;
}
/** One editable provider entry in the Settings model form. apiKey is left empty
 *  by load() (a password field is never prefilled); empty on save = keep the
 *  existing key on disk. */
export interface ProviderFormEntry {
  id: string;
  name: string;
  baseURL: string;
  apiKey: string;
  models: ModelEntry[];
}
export interface ModelForm {
  provider: string;   // active provider id
  model: string;      // active model name
  providers: ProviderFormEntry[];
  enabledModels?: EnabledModel[];
}

export interface EnabledModel {
  provider: string;
  model: string;
}

export type PermissionMode = "always-trust" | "trust-once" | "always-ask";

/** Merge providers returned by the backend with the curated provider list.
 *  Authoritative: saved model list wins (this is what makes "delete a model"
 *  stick); curated defaults are seeded only when a provider is absent from
 *  saved. Non-curated providers (e.g. user's openai-compatible) are appended. */
function mergeWithCurated(saved: ProviderInfo[]): ProviderInfo[] {
  const byId = new Map(saved.map((p) => [p.id, p]));
  const merged: ProviderInfo[] = CURATED_PROVIDERS.map((def) => {
    const savedProvider = byId.get(def.id);
    if (savedProvider) {
      const models = (savedProvider.models || []).map((m) => ({
        name: m.name,
        maxTokens: m.maxTokens ?? null,
        contextSize: m.contextSize ?? null,
        temperature: m.temperature ?? null,
        supportsVision: m.supportsVision ?? false,
      }));
      return { ...savedProvider, name: def.name, models };
    }
    return {
      id: def.id,
      name: def.name,
      baseURL: def.baseURL,
      models: def.models.map((m) => ({
        name: m.name,
        maxTokens: getTierDefaultTokens(m) ?? null,
        supportsVision: m.supportsVision ?? false,
      })),
      apiKeyPresent: false,
    };
  });
  // Keep non-curated custom providers (e.g. user added under openai-compatible).
  for (const p of saved) {
    if (!CURATED_PROVIDER_IDS.has(p.id)) merged.push(p);
  }
  return merged;
}

interface ConfigState {
  model: ModelConfig | null;
  enabledModels: EnabledModel[];
  switching: boolean;
  providers: ProviderInfo[];
  apiKeyPresent: boolean;
  baseURL: string;
  envOverrides: string[];
  loading: boolean;
  saving: boolean;
  savedAt: number | null;
  reloadFailed: boolean;
  error: string | null;
  // persona slice
  soul: string;
  soulIsDefault: boolean;
  agents: string;
  personaLoading: boolean;
  personaSaving: boolean;
  personaError: string | null;
  // permissions slice
  permissionMode: PermissionMode;
  permissionLoading: boolean;
  permissionSaving: boolean;
  permissionSavedAt: number | null;
  permissionError: string | null;
  load: () => Promise<void>;
  save: (form: ModelForm) => Promise<boolean>;
  clearSaved: () => void;
  resolveActiveModel: (convOverride?: EnabledModel | null) => EnabledModel | null;
  switchActive: (provider: string, model: string, convId?: string) => Promise<boolean>;
  loadConversationModel: (convId: string) => Promise<EnabledModel | null>;
  loadPersona: () => Promise<void>;
  saveSoul: (text: string) => Promise<boolean>;
  saveAgents: (text: string) => Promise<boolean>;
  resetSoul: () => Promise<void>;
  loadPermissions: () => Promise<void>;
  savePermissions: (mode: PermissionMode) => Promise<boolean>;
  testConnection: (provider: string, opts?: { baseURL?: string; apiKey?: string }) => Promise<{ ok: boolean; error: string | null }>;
  fetchRemoteModels: (provider: string, opts?: { baseURL?: string; apiKey?: string }) => Promise<{ ok: boolean; models: string[]; error: string | null }>;
}

export const useConfigStore = create<ConfigState>((set) => ({
  model: null,
  enabledModels: [],
  switching: false,
  providers: [],
  apiKeyPresent: false,
  baseURL: "",
  envOverrides: [],
  loading: false,
  saving: false,
  savedAt: null,
  reloadFailed: false,
  error: null,
  soul: "",
  soulIsDefault: true,
  agents: "",
  personaLoading: false,
  personaSaving: false,
  personaError: null,
  // permissions slice
  permissionMode: "trust-once",
  permissionLoading: false,
  permissionSaving: false,
  permissionSavedAt: null,
  permissionError: null,

  async load() {
    set({ loading: true, error: null });
    try {
      const b = await getBaseUrl();
      const r = await fetch(`${b}/api/config/model`);
      if (!r.ok) {
        set({ loading: false, error: "加载配置失败" });
        return;
      }
      const data = await r.json();
      set({
        model: { ...data.model, supportsVision: !!data.model?.supportsVision } as ModelConfig,
        providers: mergeWithCurated(data.providers || []),
        apiKeyPresent: !!data.apiKeyPresent,
        baseURL: data.baseURL || "",
        envOverrides: data.envOverrides || [],
        enabledModels: (data.enabledModels || []) as EnabledModel[],
        loading: false,
      });
    } catch {
      set({ loading: false, error: "无法连接到 sidecar" });
    }
  },

  async save(form) {
    // Client-side validation: need an active provider + model.
    if (!form.provider || !form.model) {
      set({ error: "请选择服务商和模型", savedAt: null });
      return false;
    }

    set({ saving: true, error: null, savedAt: null });
    try {
      const b = await getBaseUrl();
      // Provider-centric payload. apiKey is only included when the user typed a
      // new one for that provider; omitting it tells the sidecar to keep the
      // existing key on disk.
      const providers = form.providers
        .filter((p) => p.id.trim())
        .map((p) => {
          const entry: Record<string, unknown> = {
            id: p.id.trim(),
            name: p.name.trim() || p.id.trim(),
            baseURL: p.baseURL.trim(),
            models: p.models
              .filter((m) => m.name.trim())
              .map((m) => {
                const entry: Record<string, unknown> = { name: m.name.trim(), maxTokens: m.maxTokens };
                if (m.contextSize != null) entry.contextSize = m.contextSize;
                if (m.temperature != null) entry.temperature = m.temperature;
                entry.supportsVision = !!m.supportsVision;
                return entry;
              }),
          };
          if (p.apiKey) entry.apiKey = p.apiKey;
          return entry;
        });
      const body = { provider: form.provider, model: form.model,
                     enabledModels: form.enabledModels ?? [], providers };
      const r = await fetch(`${b}/api/config/model`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        set({ saving: false, error: "保存失败" });
        return false;
      }
      const data = await r.json();
      const snap = data.model || {};
      set({
        model: snap.model ?? null,
        providers: snap.providers ?? [],
        apiKeyPresent: !!snap.apiKeyPresent,
        baseURL: snap.baseURL ?? "",
        enabledModels: snap.enabledModels ?? [],
        saving: false,
        savedAt: Date.now(),
        reloadFailed: data.reloaded === false,
      });
      return true;
    } catch {
      set({ saving: false, error: "无法连接到 sidecar" });
      return false;
    }
  },

  clearSaved: () => set({ savedAt: null, reloadFailed: false }),

  resolveActiveModel(convOverride) {
    const s: ConfigState = useConfigStore.getState();
    if (convOverride && convOverride.provider && convOverride.model) return convOverride;
    const active = s.model;
    if (active && active.provider && active.model) {
      const inEnabled = s.enabledModels.some(
        (e: EnabledModel) => e.provider === active.provider && e.model === active.model,
      );
      if (inEnabled || s.enabledModels.length === 0) {
        return { provider: active.provider, model: active.model };
      }
    }
    return s.enabledModels[0] ?? null;
  },

  async switchActive(provider, model, convId) {
    const prev = useConfigStore.getState().model;
    useConfigStore.setState((s: ConfigState) => ({
      switching: true,
      model: { ...(s.model as any), provider, model } as any,
    }));
    try {
      const b = await getBaseUrl();
      const [, activeRes] = await Promise.all([
        convId
          ? fetch(`${b}/api/conversations/${encodeURIComponent(convId)}/model`, {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ provider, model }),
            })
          : Promise.resolve({ ok: true } as Response),
        fetch(`${b}/api/config/active-model`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ provider, model }),
        }),
      ]);
      if (!activeRes.ok) throw new Error("active-model failed");
      const data = await activeRes.json();
      const snap = data.model || {};
      useConfigStore.setState({
        model: snap.model ?? null,
        enabledModels: snap.enabledModels ?? useConfigStore.getState().enabledModels,
        switching: false,
        savedAt: Date.now(),
        reloadFailed: data.reloaded === false,
      });
      return true;
    } catch {
      useConfigStore.setState({ model: prev, switching: false });
      return false;
    }
  },

  async loadConversationModel(convId) {
    try {
      const b = await getBaseUrl();
      const r = await fetch(`${b}/api/conversations/${encodeURIComponent(convId)}/model`);
      if (!r.ok) return null;
      const data = await r.json();
      const m = data?.model;
      return m && m.provider && m.model ? m : null;
    } catch {
      return null;
    }
  },

  async loadPersona() {
    set({ personaLoading: true, personaError: null });
    try {
      const b = await getBaseUrl();
      const [sr, ar] = await Promise.all([
        fetch(`${b}/api/config/soul`),
        fetch(`${b}/api/config/agents`),
      ]);
      const soul = sr.ok ? await sr.json() : { content: "", isDefault: true };
      const agents = ar.ok ? await ar.json() : { content: "" };
      set({
        soul: soul.content || "",
        soulIsDefault: !!soul.isDefault,
        agents: agents.content || "",
        personaLoading: false,
      });
    } catch {
      set({ personaLoading: false, personaError: "无法加载身份/规则" });
    }
  },

  async saveSoul(text) {
    if (text.length > 20000) {
      set({ personaError: "SOUL.md 不得超过 20000 字符" });
      return false;
    }
    set({ personaSaving: true, personaError: null });
    try {
      const b = await getBaseUrl();
      const r = await fetch(`${b}/api/config/soul`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: text }),
      });
      if (!r.ok) {
        set({ personaSaving: false, personaError: "保存失败" });
        return false;
      }
      const data = await r.json();
      set({
        soul: data.content || "",
        soulIsDefault: !!data.isDefault,
        personaSaving: false,
      });
      return true;
    } catch {
      set({ personaSaving: false, personaError: "无法连接到 sidecar" });
      return false;
    }
  },

  async saveAgents(text) {
    set({ personaSaving: true, personaError: null });
    try {
      const b = await getBaseUrl();
      const r = await fetch(`${b}/api/config/agents`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: text }),
      });
      if (!r.ok) {
        set({ personaSaving: false, personaError: "保存失败" });
        return false;
      }
      const data = await r.json();
      set({ agents: data.content || "", personaSaving: false });
      return true;
    } catch {
      set({ personaSaving: false, personaError: "无法连接到 sidecar" });
      return false;
    }
  },

  async resetSoul() {
    await this.saveSoul("");
  },

  async loadPermissions() {
    set({ permissionLoading: true, permissionError: null });
    try {
      const b = await getBaseUrl();
      const r = await fetch(`${b}/api/permissions`);
      if (!r.ok) {
        set({ permissionLoading: false, permissionError: "加载权限配置失败" });
        return;
      }
      const data = await r.json();
      const mode = data.mode as PermissionMode;
      set({
        permissionMode: ["always-trust", "trust-once", "always-ask"].includes(mode) ? mode : "trust-once",
        permissionLoading: false,
      });
    } catch {
      set({ permissionLoading: false, permissionError: "无法连接到 sidecar" });
    }
  },

  async savePermissions(mode: PermissionMode) {
    set({ permissionSaving: true, permissionError: null, permissionSavedAt: null });
    try {
      const b = await getBaseUrl();
      const r = await fetch(`${b}/api/permissions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode }),
      });
      if (!r.ok) {
        set({ permissionSaving: false, permissionError: "保存失败" });
        return false;
      }
      const data = await r.json();
      const savedMode = data.permissions?.mode as PermissionMode;
      set({
        permissionMode: savedMode || mode,
        permissionSaving: false,
        permissionSavedAt: Date.now(),
      });
      return true;
    } catch {
      set({ permissionSaving: false, permissionError: "无法连接到 sidecar" });
      return false;
    }
  },

  async testConnection(provider, opts) {
    try {
      const b = await getBaseUrl();
      const r = await fetch(`${b}/api/config/model/test`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, baseURL: opts?.baseURL, apiKey: opts?.apiKey }),
      });
      if (!r.ok) return { ok: false, error: "检测失败" };
      return await r.json();
    } catch {
      return { ok: false, error: "无法连接到 sidecar" };
    }
  },

  async fetchRemoteModels(provider, opts) {
    try {
      const b = await getBaseUrl();
      const r = await fetch(`${b}/api/config/model/list`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, baseURL: opts?.baseURL, apiKey: opts?.apiKey }),
      });
      if (!r.ok) return { ok: false, models: [], error: "拉取失败" };
      return await r.json();
    } catch {
      return { ok: false, models: [], error: "无法连接到 sidecar" };
    }
  },
}));
