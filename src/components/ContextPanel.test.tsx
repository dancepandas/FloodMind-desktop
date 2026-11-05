import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import ContextPanel from "./ContextPanel";
import { useChatStore, type Block, type Msg } from "../state/chat-store";
import { useUiStore } from "../state/ui-store";
import { useBackgroundTaskStore } from "../state/background-task-store";

vi.mock("./PreviewPanel", () => ({ default: ({ path, onClose }: { path: string; onClose: () => void }) => <div>Preview {path}<button onClick={onClose}>关闭文件预览</button></div> }));
vi.mock("../lib/sidecar-client", () => ({ getBaseUrl: vi.fn(async () => "http://test") }));
const plan = (id = "p1"): Block => ({ id, kind: "plan", title: "执行方案", steps: [{ key: "1", title: "检查输入", status: "running" }] });
const artifact = (id: string, final?: boolean): Block => ({ id, kind: "artifact", name: `${id}.txt`, path: `/out/${id}.txt`, artKind: "file", final });
const turns = (...blocks: Block[]): Msg[] => [{ id: "assistant", role: "assistant", blocks, done: true, usage: null }];

beforeEach(() => {
  useUiStore.getState().resetInspector();
  useUiStore.setState({ inspectorConversationId: undefined, inspectorDiscoveredPlans: new Set() });
  useChatStore.setState({ turns: [], conversationId: "c1" });
  useBackgroundTaskStore.setState({ tasks: [], panelOpen: false });
});
afterEach(cleanup);

test("closed controller discovers a plan once and never reopens after manual close or updates", () => {
  render(<ContextPanel />);
  expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
  act(() => useChatStore.setState({ turns: turns(plan()) }));
  expect(screen.getByRole("tab", { name: "计划" })).toHaveAttribute("aria-selected", "true");
  fireEvent.click(screen.getByRole("button", { name: "关闭检查器" }));
  act(() => useChatStore.setState({ turns: turns(plan()) }));
  expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
  act(() => useChatStore.setState({ turns: turns(plan("new-plan")) }));
  expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
});

test("plan discovery never steals preview or a user-selected tab and is consumed", () => {
  useUiStore.getState().setPreviewPath("/external/file.txt");
  render(<ContextPanel />);
  act(() => useChatStore.setState({ turns: turns(plan()) }));
  expect(screen.getByText("Preview /external/file.txt")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "返回产物列表" }));
  expect(screen.getByRole("tab", { name: /产物/ })).toHaveAttribute("aria-selected", "true");
  act(() => useUiStore.getState().openInspector("tasks"));
  act(() => useChatStore.setState({ turns: turns(plan("p2")) }));
  expect(screen.getByRole("tab", { name: "后台任务" })).toHaveAttribute("aria-selected", "true");
});

test("artifact list uses assistant final semantics and arbitrary previews return to list", () => {
  useChatStore.setState({ turns: turns(artifact("final", true), artifact("legacy"), artifact("hidden", false)) });
  useUiStore.getState().openInspector("artifacts");
  render(<ContextPanel />);
  expect(screen.getByText("final.txt")).toBeInTheDocument();
  expect(screen.getByText("legacy.txt")).toBeInTheDocument();
  expect(screen.queryByText("hidden.txt")).not.toBeInTheDocument();
  act(() => useUiStore.getState().setPreviewPath("/not-in-artifacts.txt"));
  expect(screen.getByText("Preview /not-in-artifacts.txt")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "关闭文件预览" }));
  expect(screen.getByText("legacy.txt")).toBeInTheDocument();
  expect(useUiStore.getState().inspectorOpen).toBe(true);
});

test("conversation switch clears tab, preview and closed intent without reopening historical plan", () => {
  useUiStore.getState().setPreviewPath("/old.txt");
  render(<ContextPanel />);
  act(() => useChatStore.setState({ conversationId: "c2", turns: turns(plan()) }));
  expect(useUiStore.getState()).toMatchObject({ inspectorOpen: false, inspectorTab: "artifacts", previewPath: null });
  act(() => useChatStore.setState({ turns: turns(plan()) }));
  expect(useUiStore.getState().inspectorOpen).toBe(false);
  act(() => useChatStore.setState({ turns: turns(plan("fresh")) }));
  expect(useUiStore.getState()).toMatchObject({ inspectorOpen: true, inspectorTab: "plan" });
});

test("conversation scope survives a controller remount outside the chat view", () => {
  useUiStore.getState().setPreviewPath("/old.txt");
  const first = render(<ContextPanel />);
  first.unmount();
  useChatStore.setState({ conversationId: "c2", turns: [] });
  render(<ContextPanel />);
  expect(useUiStore.getState()).toMatchObject({ inspectorOpen: false, previewPath: null });
});

test("historical plan remains consumed through Settings-to-Chat remounts", () => {
  const first = render(<ContextPanel />);
  act(() => useChatStore.setState({ conversationId: "c2", turns: turns(plan()) }));
  expect(useUiStore.getState().inspectorOpen).toBe(false);
  first.unmount();
  const second = render(<ContextPanel />);
  expect(useUiStore.getState().inspectorOpen).toBe(false);
  expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
  second.unmount();
  render(<ContextPanel />);
  expect(useUiStore.getState().inspectorOpen).toBe(false);
});

test("manual close survives controller remount without rediscovering its plan", () => {
  const first = render(<ContextPanel />);
  act(() => useChatStore.setState({ turns: turns(plan()) }));
  fireEvent.click(screen.getByRole("button", { name: "关闭检查器" }));
  first.unmount();
  render(<ContextPanel />);
  expect(useUiStore.getState().inspectorOpen).toBe(false);
  expect(useUiStore.getState().inspectorDiscoveredPlans.has(JSON.stringify(["c1", "p1"]))).toBe(true);
});

test("task updates do not select a tab or open the inspector", () => {
  render(<ContextPanel />);
  act(() => useBackgroundTaskStore.setState({ tasks: [{ task_id: "t", command: "sleep", status: "running", started_at: 1, finished_at: null, exit_code: null, tail: "", stdout_path: "" }] }));
  expect(useUiStore.getState().inspectorOpen).toBe(false);
  act(() => useUiStore.getState().openInspector("artifacts"));
  act(() => useBackgroundTaskStore.setState({ tasks: [] }));
  expect(screen.getByRole("tab", { name: /产物/ })).toHaveAttribute("aria-selected", "true");
});

test("tabs support roving arrows, Home and End and preserve preview selection", async () => {
  useUiStore.getState().setPreviewPath("/selected.txt");
  render(<ContextPanel />);
  const artifactsTab = screen.getByRole("tab", { name: /产物/ });
  fireEvent.keyDown(artifactsTab, { key: "ArrowRight" });
  await vi.waitFor(() => expect(screen.getByRole("tab", { name: "计划" })).toHaveFocus());
  fireEvent.keyDown(screen.getByRole("tab", { name: "计划" }), { key: "End" });
  await vi.waitFor(() => expect(screen.getByRole("tab", { name: "后台任务" })).toHaveFocus());
  fireEvent.keyDown(screen.getByRole("tab", { name: "后台任务" }), { key: "Home" });
  await vi.waitFor(() => expect(artifactsTab).toHaveFocus());
  expect(screen.getByText("Preview /selected.txt")).toBeInTheDocument();
});
