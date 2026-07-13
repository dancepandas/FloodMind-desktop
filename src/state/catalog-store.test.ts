import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../lib/sidecar-client", () => ({ getBaseUrl: vi.fn(async () => "http://test") }));

import { useCatalogStore } from "./catalog-store";

describe("catalog-store CRUD", () => {
  beforeEach(() => {
    useCatalogStore.setState({
      skills: [],
      skillDetail: null,
      skillDetailLoading: false,
      skillSaving: false,
      skillError: null,
      mcpServers: [],
      mcpDetail: null,
      mcpDetailLoading: false,
      mcpSaving: false,
      mcpError: null,
      mcpTesting: false,
    });
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it("toggles skill disabled state", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, disabled: true }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ skills: [] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await useCatalogStore.getState().setSkillDisabled("csv", true);

    expect(String(fetchMock.mock.calls[0][0])).toContain("/api/skills/csv/disabled");
    expect((fetchMock.mock.calls[0][1] as RequestInit).method).toBe("POST");
    expect(JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)).toEqual({ disabled: true });
    expect(useCatalogStore.getState().skillSaving).toBe(false);
    expect(useCatalogStore.getState().skillError).toBeNull();
  });

  it("creates a skill and refreshes the list", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ skills: [{ name: "csv" }] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await useCatalogStore.getState().createSkill({
      name: "csv",
      description: "CSV tools",
      category: "data",
      version: "1.0.0",
      prompt: "You are a CSV helper",
    });

    expect(String(fetchMock.mock.calls[0][0])).toContain("/api/skills");
    expect((fetchMock.mock.calls[0][1] as RequestInit).method).toBe("POST");
    expect(JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string).name).toBe("csv");
    expect(useCatalogStore.getState().skills).toHaveLength(1);
  });

  it("sets skillError when createSkill fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("already exists", { status: 409 })));

    await expect(
      useCatalogStore.getState().createSkill({
        description: "CSV tools",
        category: "data",
        version: "1.0.0",
        prompt: "You are a CSV helper",
      })
    ).rejects.toThrow();

    expect(useCatalogStore.getState().skillError).toBe("already exists");
    expect(useCatalogStore.getState().skillSaving).toBe(false);
  });

  it("updates a skill and refreshes detail when selected", async () => {
    useCatalogStore.setState({ skillDetail: { name: "csv" } as any });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ skills: [{ name: "csv" }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ name: "csv", prompt: "updated" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await useCatalogStore.getState().updateSkill("csv", {
      description: "CSV tools",
      category: "data",
      version: "1.1.0",
      prompt: "updated",
    });

    expect(String(fetchMock.mock.calls[0][0])).toContain("/api/skills/csv");
    expect((fetchMock.mock.calls[0][1] as RequestInit).method).toBe("PUT");
    expect(useCatalogStore.getState().skillDetail?.prompt).toBe("updated");
  });

  it("deletes a skill and clears detail when selected", async () => {
    useCatalogStore.setState({ skillDetail: { name: "csv" } as any });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ skills: [] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await useCatalogStore.getState().deleteSkill("csv");

    expect(String(fetchMock.mock.calls[0][0])).toContain("/api/skills/csv");
    expect((fetchMock.mock.calls[0][1] as RequestInit).method).toBe("DELETE");
    expect(useCatalogStore.getState().skillDetail).toBeNull();
  });

  it("creates an MCP server and refreshes the list", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ servers: [{ name: "fs" }] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await useCatalogStore.getState().createMcpServer({
      name: "fs",
      transport: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem"],
      env: {},
    });

    expect(String(fetchMock.mock.calls[0][0])).toContain("/api/mcp");
    expect((fetchMock.mock.calls[0][1] as RequestInit).method).toBe("POST");
    expect(JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string).name).toBe("fs");
    expect(useCatalogStore.getState().mcpServers).toHaveLength(1);
  });

  it("sets mcpError when createMcpServer fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("invalid transport", { status: 400 })));

    await expect(
      useCatalogStore.getState().createMcpServer({
        transport: "stdio",
        args: [],
        env: {},
      })
    ).rejects.toThrow();

    expect(useCatalogStore.getState().mcpError).toBe("invalid transport");
  });

  it("updates an MCP server and refreshes detail when selected", async () => {
    useCatalogStore.setState({ mcpDetail: { name: "fs" } as any });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ servers: [{ name: "fs" }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ name: "fs", connected: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await useCatalogStore.getState().updateMcpServer("fs", {
      transport: "stdio",
      args: [],
      env: {},
    });

    expect(String(fetchMock.mock.calls[0][0])).toContain("/api/mcp/fs");
    expect((fetchMock.mock.calls[0][1] as RequestInit).method).toBe("PUT");
    expect(useCatalogStore.getState().mcpDetail?.connected).toBe(true);
  });

  it("deletes an MCP server and clears detail when selected", async () => {
    useCatalogStore.setState({ mcpDetail: { name: "fs" } as any });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ servers: [] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await useCatalogStore.getState().deleteMcpServer("fs");

    expect(String(fetchMock.mock.calls[0][0])).toContain("/api/mcp/fs");
    expect((fetchMock.mock.calls[0][1] as RequestInit).method).toBe("DELETE");
    expect(useCatalogStore.getState().mcpDetail).toBeNull();
  });

  it("tests an MCP server and returns the result", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })));

    const result = await useCatalogStore.getState().testMcpServer("fs");

    expect(String((vi.mocked(fetch) as any).mock.calls[0][0])).toContain("/api/mcp/fs/test");
    expect(((vi.mocked(fetch) as any).mock.calls[0][1] as RequestInit).method).toBe("POST");
    expect(result).toEqual({ ok: true, error: undefined });
    expect(useCatalogStore.getState().mcpTesting).toBe(false);
  });

  it("returns error result when testMcpServer fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network down"); }));

    const result = await useCatalogStore.getState().testMcpServer("fs");

    expect(result).toEqual({ ok: false, error: "network down" });
    expect(useCatalogStore.getState().mcpTesting).toBe(false);
  });
});
