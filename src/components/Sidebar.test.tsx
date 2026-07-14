import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import Sidebar from "./Sidebar";

afterEach(cleanup);

vi.mock("../state/workspace-store", () => ({
  useWorkspaceStore: (selector: (s: any) => any) =>
    selector({
      current: { path: "/test", name: "test" },
      load: vi.fn(),
      listFiles: () => Promise.resolve([]),
      pickAndOpen: vi.fn(),
    }),
}));
vi.mock("../state/chat-store", () => ({
  useChatStore: (selector: (s: any) => any) =>
    selector({ streaming: false, conversationId: null, startNew: vi.fn(), loadConversation: vi.fn() }),
}));
vi.mock("../state/conversation-store", () => ({
  useConversationStore: (selector: (s: any) => any) =>
    selector({ list: [], loadList: vi.fn(), remove: vi.fn() }),
}));
vi.mock("../state/scheduled-task-store", () => ({
  useScheduledTaskStore: (selector: (s: any) => any) => selector({ tasks: [], load: vi.fn() }),
}));
vi.mock("../state/ui-store", () => ({
  useUiStore: (selector: (s: any) => any) =>
    selector({ view: "chat", setView: vi.fn(), setSelectedTaskId: vi.fn() }),
}));

describe("Sidebar", () => {
  it("shows config group labels", () => {
    render(<Sidebar />);
    expect(screen.getByText("配置")).toBeInTheDocument();
    expect(screen.getByText("技能")).toBeInTheDocument();
    expect(screen.getByText("连接器")).toBeInTheDocument();
    expect(screen.getByText("设置")).toBeInTheDocument();
  });

  it("shows automation group label", () => {
    render(<Sidebar />);
    expect(screen.getByText("自动化")).toBeInTheDocument();
  });
});
