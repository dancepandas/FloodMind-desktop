import { create } from "zustand";
import { getBaseUrl } from "../lib/sidecar-client";

export interface ModelConfig {
  provider: string;
  model: string;
  temperature: number;
  maxTokens: number;
  enableReasoning: boolean;
  enableSearch: boolean;
}
export interface ProviderInfo {
  id: string;
  name: string;
  baseURL: string;
  models: string[];
}
export interface ModelForm {
  provider: string;
  model: string;
  apiKey: string; // empty means "leave unchanged"
  baseURL: string;
  temperature: number;
  maxTokens: number;
  enableReasoning: boolean;
  enableSearch: boolean;
}

interface ConfigState {
  model: ModelConfig | null;
  providers: ProviderInfo[];
  apiKeyPresent: boolean;
  baseURL: string;
  envOverrides: string[];
  loading: boolean;
  saving: boolean;
  savedAt: number | null;
  reloadFailed: boolean;
  error: string | null;
  load: () => Promise<void>;
  save: (form: ModelForm) => Promise<boolean>;
  clearSaved: () => void;
}

export const useConfigStore = create<ConfigState>((set) => ({
  model: null,
  providers: [],
  apiKeyPresent: false,
  baseURL: "",
  envOverrides: [],
  loading: false,
  saving: false,
  savedAt: null,
  reloadFailed: false,
  error: null,

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
        model: data.model,
        providers: data.providers || [],
        apiKeyPresent: !!data.apiKeyPresent,
        baseURL: data.baseURL || "",
        envOverrides: data.envOverrides || [],
        loading: false,
      });
    } catch {
      set({ loading: false, error: "无法连接到 sidecar" });
    }
  },

  async save(form) {
    // Client-side validation.
    if (!form.provider || !form.model) {
      set({ error: "请选择服务商和模型", savedAt: null });
      return false;
    }
    if (form.temperature < 0 || form.temperature > 2) {
      set({ error: "温度须在 0–2 之间", savedAt: null });
      return false;
    }
    if (!(form.maxTokens > 0)) {
      set({ error: "最大 token 须为正整数", savedAt: null });
      return false;
    }

    set({ saving: true, error: null, savedAt: null });
    try {
      const b = await getBaseUrl();
      // Only send apiKey when the user typed one (empty = leave unchanged).
      const body: Record<string, unknown> = {
        provider: form.provider,
        model: form.model,
        baseURL: form.baseURL,
        temperature: form.temperature,
        maxTokens: form.maxTokens,
        enableReasoning: form.enableReasoning,
        enableSearch: form.enableSearch,
      };
      if (form.apiKey) body.apiKey = form.apiKey;
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
      set({
        model: data.model?.model ?? null,
        apiKeyPresent: data.model?.apiKeyPresent ?? false,
        baseURL: data.model?.baseURL ?? "",
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
}));
