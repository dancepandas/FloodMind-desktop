import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import TopBar from "./TopBar";
import { useChatStore } from "../state/chat-store";
import { useUiStore } from "../state/ui-store";

vi.mock("./HealthBadge", () => ({ default: () => <span>Health</span> }));
vi.mock("./UsageBadge", () => ({ default: () => <span>Usage</span> }));
afterEach(() => { cleanup(); useUiStore.getState().resetInspector(); useChatStore.setState({ turns: [] }); });

test("topbar provides explicit inspector entries and preserves plan toggle", () => {
  useChatStore.setState({ title: "测试会话", turns: [{ id: "a", role: "assistant", done: true, usage: null, blocks: [{ id: "p", kind: "plan", title: "方案", steps: [] }] }] });
  render(<TopBar />);
  fireEvent.click(screen.getByRole("button", { name: "查看产物" }));
  expect(useUiStore.getState()).toMatchObject({ inspectorOpen: true, inspectorTab: "artifacts" });
  fireEvent.click(screen.getByRole("button", { name: "查看后台任务" }));
  expect(useUiStore.getState()).toMatchObject({ inspectorOpen: true, inspectorTab: "tasks" });
  fireEvent.click(screen.getByRole("button", { name: "执行计划" }));
  expect(useUiStore.getState()).toMatchObject({ inspectorOpen: true, inspectorTab: "plan" });
  fireEvent.click(screen.getByRole("button", { name: "执行计划" }));
  expect(useUiStore.getState().inspectorOpen).toBe(false);
  expect(screen.getByText("测试会话")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "新会话" })).toBeInTheDocument();
});

test("new-session reset clears stale inspector detail and manual dismissal", () => {
  useChatStore.setState({ title: "旧会话", turns: [{ id: "old", role: "assistant", done: true, usage: null, blocks: [] }] });
  useUiStore.getState().setPreviewPath("/workspace/old.md");
  useUiStore.getState().closeInspector();
  render(<TopBar />);
  fireEvent.click(screen.getByRole("button", { name: "新会话" }));
  expect(useChatStore.getState().turns).toEqual([]);
  expect(useUiStore.getState()).toMatchObject({ inspectorOpen: false, inspectorTab: "artifacts", previewPath: null, inspectorDismissed: false });
});

test("optional navigation callback is available without replacing existing actions", () => {
  const toggle = vi.fn();
  render(<TopBar onToggleSidebar={toggle} />);
  fireEvent.click(screen.getByLabelText("展开导航"));
  expect(toggle).toHaveBeenCalledOnce();
  act(() => useUiStore.getState().openInspector("artifacts"));
  expect(screen.getByRole("button", { name: "查看产物" })).toHaveAttribute("aria-pressed", "true");
});
