import { create } from "zustand";
import { getBaseUrl } from "../lib/sidecar-client";
import { getRecentLogs } from "../lib/log-capture";

export interface FeedbackForm {
  description: string;
  includeLogs: boolean;
  contact: string;
}

/** Destination mailbox for user feedback (chosen product decision). */
export const FEEDBACK_EMAIL = "2590030831@qq.com";
// mailto bodies over a few KB can be truncated by some mail clients, so cap the
// inlined logs. The full untruncated log is always saved locally as a backup.
const FEEDBACK_MAILTO_LOG_CAP = 4000;

/** Build a mailto: URL prefilled with the feedback content. Pure function so it
 *  is unit-testable. The caller decides when (and whether) to open it — the UI
 *  prompts the user first rather than auto-launching the mail client. */
export function buildFeedbackMailto(form: FeedbackForm): string {
  const subject = "FloodMind Desktop 意见反馈";
  const lines = [
    form.description.trim(),
    "",
    `联系方式：${form.contact.trim() || "（未填写）"}`,
  ];
  if (form.includeLogs) {
    const entries = getRecentLogs(200);
    const text = entries
      .map((e) => `[${e.timestamp}] ${e.level}: ${e.message}`)
      .join("\n");
    const capped =
      text.length > FEEDBACK_MAILTO_LOG_CAP
        ? text.slice(0, FEEDBACK_MAILTO_LOG_CAP) + "\n…（日志已截断，完整日志已保存到本地）"
        : text;
    lines.push("", "---- 近期运行日志 ----", capped);
  }
  const body = lines.join("\n");
  return `mailto:${FEEDBACK_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

interface FeedbackState {
  submitting: boolean;
  submittedAt: number | null;
  error: string | null;
  submit: (form: FeedbackForm) => Promise<boolean>;
  clear: () => void;
}

export const useFeedbackStore = create<FeedbackState>((set) => ({
  submitting: false,
  submittedAt: null,
  error: null,

  async submit(form) {
    const description = form.description.trim();
    if (!description) {
      set({ error: "请填写问题描述", submittedAt: null });
      return false;
    }
    set({ submitting: true, error: null, submittedAt: null });
    try {
      const b = await getBaseUrl();
      const body: Record<string, unknown> = {
        description,
        include_logs: form.includeLogs,
        contact: form.contact.trim(),
      };
      if (form.includeLogs) {
        body.logs = getRecentLogs(200);
      }
      const r = await fetch(`${b}/api/feedback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        const data = await r.json().catch(() => ({ error: "提交失败" }));
        set({ submitting: false, error: data.error || "提交失败" });
        return false;
      }
      set({ submitting: false, submittedAt: Date.now() });
      return true;
    } catch {
      set({ submitting: false, error: "无法连接到 sidecar" });
      return false;
    }
  },

  clear: () => set({ submitting: false, submittedAt: null, error: null }),
}));
