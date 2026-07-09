import { create } from "zustand";
import { getBaseUrl } from "../lib/sidecar-client";
import { streamChat, type ChatEvent, type ChatMessage } from "../lib/chat-stream";

type Role = "user" | "assistant";

export interface ToolCall {
  call_id: string;
  tool_name: string;
  status: string;
  input?: string;
  output?: string;
}
export interface PlanStep {
  key: string;
  status: string;
  title?: string;
  outcome?: string;
}
export interface Artifact {
  kind: "file" | "image";
  name: string;
  path: string;
}
export interface PermissionAsk {
  ask_id: string;
  call_id: string;
  tool_name: string;
  reason: string;
  input: unknown;
}

interface ChatState {
  messages: { role: Role; content: string }[];
  streaming: boolean;
  thinking: string;
  tools: ToolCall[];
  planTitle: string;
  planSteps: PlanStep[];
  artifacts: Artifact[];
  usage: { prompt: number; completion: number; total: number } | null;
  permission: PermissionAsk | null;
  error: string | null;
  abortController: AbortController | null;
  send: (text: string) => Promise<void>;
  reset: () => void;
  dismissPermission: () => void;
}

const initial = {
  messages: [] as { role: Role; content: string }[],
  streaming: false,
  thinking: "",
  tools: [] as ToolCall[],
  planTitle: "",
  planSteps: [] as PlanStep[],
  artifacts: [] as Artifact[],
  usage: null,
  permission: null,
  error: null,
  abortController: null,
};

export const useChatStore = create<ChatState>((set, get) => ({
  ...initial,

  async send(text: string) {
    if (!text.trim() || get().streaming) return;

    const userMsg: ChatMessage = { role: "user", content: text };
    const controller = new AbortController();
    set((s) => ({
      messages: [
        ...s.messages,
        { role: "user", content: text },
        { role: "assistant", content: "" },
      ],
      streaming: true,
      thinking: "",
      tools: [],
      planTitle: "",
      planSteps: [],
      artifacts: [],
      usage: null,
      permission: null,
      error: null,
      abortController: controller,
    }));

    try {
      const baseUrl = await getBaseUrl();
      let acc = "";
      for await (const ev of streamChat(baseUrl, [userMsg], controller.signal) as AsyncGenerator<ChatEvent>) {
        switch (ev.type) {
          case "text":
            acc += ev.content;
            set((s) => {
              const m = [...s.messages];
              m[m.length - 1] = { role: "assistant", content: acc };
              return { messages: m };
            });
            break;
          case "thinking":
            set((s) => ({ thinking: s.thinking + ev.content }));
            break;
          case "tool_start":
            set((s) => ({
              tools: [
                ...s.tools,
                { call_id: ev.call_id, tool_name: ev.tool_name, status: "running", input: ev.input },
              ],
            }));
            break;
          case "tool_end":
            set((s) => {
              const exists = s.tools.some((t) => t.call_id === ev.call_id);
              return {
                tools: exists
                  ? s.tools.map((t) =>
                      t.call_id === ev.call_id
                        ? { ...t, status: ev.status, output: ev.output }
                        : t
                    )
                  : // Orphan tool_end (no matching start, or empty call_id): show it anyway
                    // rather than silently dropping the tool's output.
                    [
                      ...s.tools,
                      { call_id: ev.call_id, tool_name: ev.tool_name, status: ev.status, output: ev.output },
                    ],
              };
            });
            break;
          case "plan":
            set({
              planTitle: ev.title,
              planSteps: Array.isArray(ev.steps)
                ? ev.steps.map((st: any) => ({
                    key: st.key,
                    status: st.status,
                    title: st.title,
                    outcome: st.outcome,
                  }))
                : [],
            });
            break;
          case "step":
            set((s) => ({
              planSteps: s.planSteps.map((p) =>
                p.key === ev.key
                  ? { ...p, status: ev.status, outcome: ev.outcome ?? p.outcome }
                  : p
              ),
            }));
            break;
          case "artifact":
            set((s) => ({
              artifacts: [...s.artifacts, { kind: ev.kind, name: ev.name, path: ev.path }],
            }));
            break;
          case "permission":
            set({
              permission: {
                ask_id: ev.ask_id,
                call_id: ev.call_id,
                tool_name: ev.tool_name,
                reason: ev.reason,
                input: ev.input,
              },
            });
            break;
          case "usage":
            set({ usage: { prompt: ev.prompt, completion: ev.completion, total: ev.total } });
            break;
          case "error":
            set({ error: ev.content });
            break;
          // "done" needs no action.
        }
      }
    } catch (e) {
      if (controller.signal.aborted) {
        set({ streaming: false, abortController: null });
        return;
      }
      set((s) => {
        const m = [...s.messages];
        m[m.length - 1] = { role: "assistant", content: `⚠️ 出错：${(e as Error).message}` };
        return { messages: m, error: (e as Error).message };
      });
    } finally {
      set({ streaming: false, abortController: null });
    }
  },

  reset: () => {
    get().abortController?.abort();
    set({ ...initial });
  },
  dismissPermission: () => set({ permission: null }),
}));
