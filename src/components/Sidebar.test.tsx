import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, within } from "@testing-library/react";
import Sidebar from "./Sidebar";

afterEach(cleanup);

const openPath = vi.fn();
const pickAndOpen = vi.fn();
const loadWorkspaceConversations = vi.fn();
const loadConversation = vi.fn();
const setView = vi.fn();
const remove = vi.fn();
const startNew = vi.fn();
const byWorkspaceState: Record<string, any[]> = {};

vi.mock("../state/workspace-store", () => ({
  useWorkspaceStore: (selector: (s: any) => any) =>
    selector({
      current: { path: "/test", name: "test" },
      recent: [{ path: "/other", name: "other" }],
      load: vi.fn(),
      openPath,
      pickAndOpen,
    }),
}));

vi.mock("../state/chat-store", () => ({
  useChatStore: (selector: (s: any) => any) =>
    selector({
      streaming: false,
      conversationId: null,
      startNew,
      loadConversation,
    }),
}));

vi.mock("../state/conversation-store", () => ({
  useConversationStore: (selector: (s: any) => any) =>
    selector({
      list: [],
      byWorkspace: byWorkspaceState,
      loadList: vi.fn(),
      loadWorkspaceConversations,
      remove,
    }),
}));

vi.mock("../state/scheduled-task-store", () => ({
  useScheduledTaskStore: (selector: (s: any) => any) => selector({ tasks: [], load: vi.fn() }),
}));

vi.mock("../state/ui-store", () => ({
  useUiStore: (selector: (s: any) => any) =>
    selector({ view: "chat", setView, setSelectedTaskId: vi.fn() }),
}));

describe("Sidebar", () => {
  it("renders top navigation rows", () => {
    render(<Sidebar />);
    expect(screen.getByText("新建任务")).toBeInTheDocument();
    expect(screen.getByText("Skills")).toBeInTheDocument();
    expect(screen.getByText("MCP")).toBeInTheDocument();
    expect(screen.getByText("自动化")).toBeInTheDocument();
    expect(screen.getByText("设置")).toBeInTheDocument();
  });

  it("renders three-band navigation without a chat entry", () => {
    render(<Sidebar />);
    const primary = screen.getByRole("navigation", { name: "主导航" });
    expect(within(primary).getByText("新建任务")).toBeInTheDocument();
    expect(within(primary).getByText("自动化")).toBeInTheDocument();
    expect(within(primary).getByText("Skills")).toBeInTheDocument();
    const secondary = screen.getByRole("navigation", { name: "更多" });
    expect(within(secondary).getByText("MCP")).toBeInTheDocument();
    expect(within(secondary).getByText("经验")).toBeInTheDocument();
    expect(screen.queryByText("对话")).not.toBeInTheDocument();
  });

  it("renders a relative timestamp on each conversation row", () => {
    byWorkspaceState["/test"] = [
      {
        id: "c1",
        title: "Hello",
        updated_at: new Date(Date.now() - 5 * 60_000).toISOString(),
        active: false,
      },
    ];
    try {
      render(<Sidebar />);
      const time = document.querySelector(".conv-item .conv-time");
      expect(time).toHaveTextContent("5 分钟");
    } finally {
      delete byWorkspaceState["/test"];
    }
  });

  it("renders workspace header", () => {
    render(<Sidebar />);
    expect(screen.getByText("会话")).toBeInTheDocument();
  });

  it("lists current and recent workspaces", () => {
    render(<Sidebar />);
    expect(screen.getByText("test")).toBeInTheDocument();
    expect(screen.getByText("other")).toBeInTheDocument();
  });

  it("uses decorative SVG chevrons and preserves workspace expansion", () => {
    render(<Sidebar />);
    const collapse = screen.getByRole("button", { name: "折叠工作区" });
    const expand = screen.getByRole("button", { name: "展开工作区" });
    expect(collapse.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
    expect(expand.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
    expect(collapse).not.toHaveTextContent("▾");
    expect(expand).not.toHaveTextContent("▸");
    fireEvent.click(expand);
    expect(expand).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(collapse);
    expect(collapse).toHaveAttribute("aria-expanded", "false");
  });

  it("uses matching decorative folder SVGs for workspaces and opening a directory", () => {
    render(<Sidebar />);
    for (const name of ["test", "other", "打开其他工作区…"]) {
      const button = screen.getByRole("button", { name });
      expect(button.querySelector(".workspace-folder svg")).toHaveAttribute("aria-hidden", "true");
      expect(button).not.toHaveTextContent("＋");
    }
    expect(screen.getByRole("button", { name: "打开其他工作区…" })).toHaveClass("workspace-open");
  });

  it("shows open-other-workspace row", () => {
    render(<Sidebar />);
    expect(screen.getByText("打开其他工作区…")).toBeInTheDocument();
  });

  it("clicking a workspace opens it and switches to chat view", async () => {
    render(<Sidebar />);
    fireEvent.click(screen.getByText("other"));
    expect(openPath).toHaveBeenCalledWith("/other");
    expect(setView).toHaveBeenCalledWith("chat");
  });
});
