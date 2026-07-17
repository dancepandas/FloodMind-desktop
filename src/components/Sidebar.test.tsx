import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import Sidebar from "./Sidebar";

afterEach(cleanup);

const openPath = vi.fn();
const pickAndOpen = vi.fn();
const loadWorkspaceConversations = vi.fn();
const loadConversation = vi.fn();
const setView = vi.fn();
const remove = vi.fn();
const startNew = vi.fn();

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
      byWorkspace: {},
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
    expect(screen.getByText("对话")).toBeInTheDocument();
    expect(screen.getByText("Skills")).toBeInTheDocument();
    expect(screen.getByText("MCP")).toBeInTheDocument();
    expect(screen.getByText("自动化")).toBeInTheDocument();
    expect(screen.getByText("设置")).toBeInTheDocument();
  });

  it("renders workspace header with count", () => {
    render(<Sidebar />);
    expect(screen.getByText("工作区 (2)")).toBeInTheDocument();
  });

  it("lists current and recent workspaces", () => {
    render(<Sidebar />);
    expect(screen.getByText("test")).toBeInTheDocument();
    expect(screen.getByText("other")).toBeInTheDocument();
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
