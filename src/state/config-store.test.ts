import { describe, it, expect, vi, beforeEach } from "vitest";
import { useConfigStore } from "./config-store";

vi.mock("../lib/sidecar-client", () => ({ getBaseUrl: vi.fn(async () => "http://test") }));

describe("config-store persona slice", () => {
  beforeEach(() => {
    useConfigStore.setState({
      soul: "",
      soulIsDefault: true,
      agents: "",
      personaLoading: false,
      personaSaving: false,
      personaError: null,
    });
    vi.clearAllMocks();
  });

  it("loadPersona fetches both endpoints and fills the store", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes("/soul")) {
        return new Response(JSON.stringify({ content: "我是Bot", isDefault: false }), { status: 200 });
      }
      return new Response(JSON.stringify({ content: "## 规则" }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await useConfigStore.getState().loadPersona();

    const s = useConfigStore.getState();
    expect(s.soul).toBe("我是Bot");
    expect(s.soulIsDefault).toBe(false);
    expect(s.agents).toBe("## 规则");
    expect(s.personaError).toBeNull();
    vi.unstubAllGlobals();
  });

  it("saveSoul rejects >20000 chars without sending a request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await useConfigStore.getState().saveSoul("x".repeat(20001));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(useConfigStore.getState().personaError).toContain("20000");
    vi.unstubAllGlobals();
  });

  it("saveSoul posts and updates the store from the response", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true, reloaded: true, content: "新身份", isDefault: false }), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);

    await useConfigStore.getState().saveSoul("新身份");

    expect(fetchMock).toHaveBeenCalledWith(
      "http://test/api/config/soul",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ content: "新身份" }) })
    );
    const s = useConfigStore.getState();
    expect(s.soul).toBe("新身份");
    expect(s.soulIsDefault).toBe(false);
    expect(s.personaSaving).toBe(false);
    vi.unstubAllGlobals();
  });

  it("resetSoul posts empty content (delete → default)", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true, reloaded: true, content: "默认", isDefault: true }), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);

    await useConfigStore.getState().resetSoul();

    expect(fetchMock).toHaveBeenCalledWith(
      "http://test/api/config/soul",
      expect.objectContaining({ body: JSON.stringify({ content: "" }) })
    );
    expect(useConfigStore.getState().soulIsDefault).toBe(true);
    vi.unstubAllGlobals();
  });
});
