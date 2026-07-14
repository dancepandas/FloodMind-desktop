import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { test, expect, vi, afterEach } from "vitest";
import WelcomeView from "./WelcomeView";

afterEach(cleanup);

const SCENARIOS = [
  { label: "文档处理", prompt: "帮我整理一份文档" },
  { label: "数据分析", prompt: "分析当前工作区里的数据文件" },
  { label: "生成 PPT", prompt: "根据工作区内容生成一份 PPT" },
  { label: "写代码", prompt: "帮我写一段代码" },
];

test("renders title, chips, and quick actions", () => {
  const onSend = vi.fn();
  render(<WelcomeView onSend={onSend} />);

  expect(screen.getByText("FloodMind")).toBeInTheDocument();
  expect(screen.getByText(/智能工作助手/)).toBeInTheDocument();

  expect(screen.getByText("日常办公")).toBeInTheDocument();
  expect(screen.getByText("代码开发")).toBeInTheDocument();
  expect(screen.getByText("设计创意")).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "生成 PPT" }));
  expect(onSend).toHaveBeenCalledWith(expect.stringContaining("PPT"));
});

test("each quick action calls onSend with its prompt", () => {
  const onSend = vi.fn();
  render(<WelcomeView onSend={onSend} />);

  for (const scenario of SCENARIOS) {
    fireEvent.click(screen.getByRole("button", { name: scenario.label }));
    expect(onSend).toHaveBeenLastCalledWith(scenario.prompt);
  }
});
