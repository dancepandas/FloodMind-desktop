import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { useCatalogStore } from "../state/catalog-store";
import McpView from "./McpView";

afterEach(() => cleanup());

describe("McpView management", () => {
  beforeEach(() => {
    useCatalogStore.setState({
      mcpServers: [{ name: "fs", transport: "stdio", tools: 2, connected: true }],
      mcpDetail: null,
      mcpDetailLoading: false,
      mcpSaving: false,
      mcpError: null,
      mcpTesting: false,
      loadMcp: vi.fn(),
      loadMcpServer: vi.fn(),
      createMcpServer: vi.fn(),
      updateMcpServer: vi.fn(),
      deleteMcpServer: vi.fn(),
      testMcpServer: vi.fn().mockResolvedValue({ ok: true }),
    } as any);
  });

  it("selects a server card and tests the connection from its detail panel", async () => {
    useCatalogStore.setState({ mcpDetail: { name: "fs", transport: "stdio", tools: ["read_file"], connected: true } });
    render(<McpView />);
    const card = within(screen.getByRole("list", { name: "MCP 服务器列表" })).getByRole("button");
    fireEvent.click(card);
    expect(card).toHaveAttribute("aria-pressed", "true");
    expect(useCatalogStore.getState().loadMcpServer).toHaveBeenCalledWith("fs");
    const detail = screen.getByRole("region", { name: "服务器详情" });
    expect(within(detail).getByText("read_file")).toBeInTheDocument();
    fireEvent.click(within(detail).getByRole("button", { name: "测试连接" }));
    await screen.findByText("连接成功");
    expect(useCatalogStore.getState().testMcpServer).toHaveBeenCalledWith("fs");
    await waitFor(() => expect(useCatalogStore.getState().loadMcp).toHaveBeenCalledTimes(2));
    fireEvent.click(within(detail).getByRole("button", { name: "编辑" }));
    expect(screen.getByText("编辑 MCP 服务器")).toBeInTheDocument();
  });

  it("shows server health text on cards and deletes selected servers", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    useCatalogStore.setState({
      mcpServers: [{ name: "fs", tools: 2, health_ok: false, health_error: "offline" }],
      mcpDetail: { name: "fs", health_ok: false, health_error: "offline" },
    });
    render(<McpView />);
    const card = within(screen.getByRole("list", { name: "MCP 服务器列表" })).getByRole("button");
    expect(card).toHaveTextContent("调用异常");
    fireEvent.click(card);
    fireEvent.click(screen.getByRole("button", { name: "删除" }));
    await waitFor(() => expect(useCatalogStore.getState().deleteMcpServer).toHaveBeenCalledWith("fs"));
    await screen.findByText("选择一个服务器查看工具");
    confirm.mockRestore();
  });

  it("opens create modal when add button is clicked", () => {
    render(<McpView />);
    fireEvent.click(screen.getByTitle("新建 MCP 服务器"));
    expect(screen.getByText("新建 MCP 服务器")).toBeInTheDocument();
  });
});
