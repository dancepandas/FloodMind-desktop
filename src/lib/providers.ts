export type ContextTier = "1M" | "200K";

/** Default max-output-token presets that go with each context tier.
 *  These are *output* limits (what the API calls max_tokens/max_completion_tokens),
 *  not the context-window size — the context tier is a fixed model capability. */
export const TIER_OUTPUT_TOKENS: Record<ContextTier, number> = {
  "1M": 131_072,
  "200K": 65_536,
};

export interface CuratedModelDef {
  name: string;
  /** Official-provider models are grouped into 1M/200K context tiers so the GUI
   *  can show a simple badge and a safe default output-token preset. */
  contextTier?: ContextTier;
  /** Optional per-model output-token override. If omitted, the tier default is used. */
  maxTokens?: number | null;
}

export interface CuratedProviderDef {
  id: string;
  name: string;
  baseURL: string;
  /** If true, the user can edit the baseURL (OpenAI / Ollama). */
  editableBaseURL: boolean;
  /** If true, the user can add/remove models (OpenAI / Ollama). */
  editableModels: boolean;
  models: CuratedModelDef[];
  docsURL: string;
}

export const CURATED_PROVIDERS: CuratedProviderDef[] = [
  {
    id: "deepseek",
    name: "DeepSeek",
    baseURL: "https://api.deepseek.com/v1",
    editableBaseURL: false,
    editableModels: false,
    models: [
      { name: "deepseek-v4-pro", contextTier: "1M" },
      { name: "deepseek-v4-flash", contextTier: "1M" },
    ],
    docsURL: "https://api-docs.deepseek.com/",
  },
  {
    id: "zhipu",
    name: "智谱 AI",
    baseURL: "https://open.bigmodel.cn/api/paas/v4",
    editableBaseURL: false,
    editableModels: false,
    models: [
      { name: "glm-5.2", contextTier: "1M" },
      { name: "glm-5.1", contextTier: "200K" },
    ],
    docsURL: "https://docs.bigmodel.cn/",
  },
  {
    id: "moonshot",
    name: "月之暗面",
    baseURL: "https://api.moonshot.cn/v1",
    editableBaseURL: false,
    editableModels: false,
    models: [
      { name: "kimi-2.6", contextTier: "200K" },
      { name: "kimi-2.5", contextTier: "200K" },
    ],
    docsURL: "https://platform.kimi.ai/docs",
  },
  {
    id: "qwen",
    name: "通义千问",
    baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    editableBaseURL: false,
    editableModels: false,
    models: [
      { name: "qwen3.7-plus", contextTier: "1M" },
      { name: "qwen3.6-plus", contextTier: "200K" },
      { name: "qwen3.7-flash", contextTier: "1M" },
      { name: "qwen3.6-flash", contextTier: "200K" },
    ],
    docsURL: "https://help.aliyun.com/zh/model-studio/qwen-api-via-dashscope",
  },
  {
    id: "minimax",
    name: "MiniMax",
    baseURL: "https://api.minimax.io/v1",
    editableBaseURL: false,
    editableModels: false,
    models: [
      { name: "minimax3", contextTier: "1M" },
      { name: "minimax2.7", contextTier: "200K" },
    ],
    docsURL: "https://platform.minimaxi.com/docs/",
  },
  {
    id: "openai",
    name: "自定义 OpenAI 兼容",
    baseURL: "",
    editableBaseURL: true,
    editableModels: true,
    models: [],
    docsURL: "https://platform.openai.com/",
  },
  {
    id: "ollama",
    name: "Ollama 本地",
    baseURL: "http://localhost:11434/v1",
    editableBaseURL: true,
    editableModels: true,
    models: [],
    docsURL: "https://ollama.com/",
  },
];

export const CURATED_PROVIDER_IDS = new Set(CURATED_PROVIDERS.map((p) => p.id));

export function getProviderDef(id: string): CuratedProviderDef | undefined {
  return CURATED_PROVIDERS.find((p) => p.id === id);
}

/** Resolve the default output-token preset for an official-provider model. */
export function getTierDefaultTokens(model: CuratedModelDef): number | null {
  if (model.contextTier) {
    return model.maxTokens ?? TIER_OUTPUT_TOKENS[model.contextTier] ?? null;
  }
  return model.maxTokens ?? null;
}

export function isCustomProvider(def: CuratedProviderDef): boolean {
  return def.editableModels;
}
