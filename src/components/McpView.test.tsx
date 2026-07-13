import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { useCatalogStore } from "../state/catalog-store";
import McpView from "./McpView";

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

  it("opens create modal when add button is clicked", () => {
    render(<McpView />);
    fireEvent.click(screen.getByTitle("新建 MCP 服务器"));
    expect(screen.getByText("新建 MCP 服务器")).toBeInTheDocument();
  });
});
