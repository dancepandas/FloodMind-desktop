import { create } from "zustand";
import { getBaseUrl } from "../lib/sidecar-client";
import { streamChat, type ChatMessage } from "../lib/chat-stream";

type Role = "user" | "assistant";

interface ChatState {
  messages: { role: Role; content: string }[];
  streaming: boolean;
  send: (text: string) => Promise<void>;
}

export const useChatStore = create<ChatState>((set, get) => ({
  messages: [],
  streaming: false,
  async send(text: string) {
    if (!text.trim() || get().streaming) return;

    const userMsg: ChatMessage = { role: "user", content: text };
    set((s) => ({
      messages: [...s.messages, { role: "user", content: text }],
      streaming: true,
    }));

    // Append an empty assistant message and grow it as chunks arrive.
    set((s) => ({ messages: [...s.messages, { role: "assistant", content: "" }] }));

    try {
      const baseUrl = await getBaseUrl();
      let acc = "";
      for await (const event of streamChat(baseUrl, [userMsg])) {
        if (event.type === "text") {
          acc += event.content;
          set((s) => {
            const msgs = [...s.messages];
            msgs[msgs.length - 1] = { role: "assistant", content: acc };
            return { messages: msgs };
          });
        }
      }
    } catch (e) {
      set((s) => {
        const msgs = [...s.messages];
        msgs[msgs.length - 1] = {
          role: "assistant",
          content: `⚠️ 出错：${(e as Error).message}`,
        };
        return { messages: msgs };
      });
    } finally {
      set({ streaming: false });
    }
  },
}));
