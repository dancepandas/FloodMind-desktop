import { describe, it, expect, vi, beforeEach } from "vitest";
import { useFeedbackStore, buildFeedbackMailto, FEEDBACK_EMAIL } from "./feedback-store";

vi.mock("../lib/sidecar-client", () => ({ getBaseUrl: vi.fn(async () => "http://test") }));
vi.mock("../lib/log-capture", () => ({ getRecentLogs: vi.fn(() => [{ level: "info", message: "test", timestamp: "2026-07-15T00:00:00Z" }]) }));

describe("feedback-store", () => {
  beforeEach(() => {
    useFeedbackStore.setState({
      submitting: false,
      submittedAt: null,
      error: null,
    });
    vi.clearAllMocks();
  });

  it("rejects empty description locally", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const ok = await useFeedbackStore.getState().submit({ description: "   ", includeLogs: false, contact: "" });
    expect(ok).toBe(false);
    expect(useFeedbackStore.getState().error).toContain("描述");
    expect(globalThis.fetch).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("posts feedback without logs", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      new Response(JSON.stringify({ ok: true, path: "/tmp/feedback.json" }), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);

    const ok = await useFeedbackStore.getState().submit({
      description: "Something is wrong",
      includeLogs: false,
      contact: "user@example.com",
    });

    expect(ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://test/api/feedback",
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining("Something is wrong"),
      })
    );
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const sent = JSON.parse(init.body as string);
    expect(sent.include_logs).toBe(false);
    expect(sent.contact).toBe("user@example.com");
    expect(sent.logs).toBeUndefined();
    expect(useFeedbackStore.getState().submittedAt).not.toBeNull();
    vi.unstubAllGlobals();
  });

  it("includes logs when requested", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      new Response(JSON.stringify({ ok: true, path: "/tmp/feedback.json" }), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);

    await useFeedbackStore.getState().submit({
      description: "bug",
      includeLogs: true,
      contact: "",
    });

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const sent2 = JSON.parse(init.body as string);
    expect(sent2.include_logs).toBe(true);
    expect(sent2.logs).toEqual([{ level: "info", message: "test", timestamp: "2026-07-15T00:00:00Z" }]);
    vi.unstubAllGlobals();
  });

  it("surfaces server error", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: "server down" }), { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);

    const ok = await useFeedbackStore.getState().submit({ description: "bug", includeLogs: false, contact: "" });
    expect(ok).toBe(false);
    expect(useFeedbackStore.getState().error).toBe("server down");
    vi.unstubAllGlobals();
  });

  it("builds a mailto to the feedback mailbox with description + contact", () => {
    const url = buildFeedbackMailto({ description: "界面卡顿", includeLogs: false, contact: "qq" });
    expect(url.startsWith(`mailto:${FEEDBACK_EMAIL}?`)).toBe(true);
    // Chinese content is percent-encoded; decode to assert it round-trips.
    const decoded = decodeURIComponent(url);
    expect(decoded).toContain("界面卡顿");
    expect(decoded).toContain("联系方式：qq");
    expect(decoded).toContain("subject=FloodMind Desktop 意见反馈");
    // No logs section when includeLogs is false.
    expect(decoded).not.toContain("近期运行日志");
  });

  it("includes a logs section in the mailto body when requested", () => {
    const url = buildFeedbackMailto({ description: "bug", includeLogs: true, contact: "" });
    const decoded = decodeURIComponent(url);
    expect(decoded).toContain("近期运行日志");
    expect(decoded).toContain("info: test");
  });
});
