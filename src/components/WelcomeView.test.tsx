import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { test, expect, afterEach, vi } from "vitest";
import WelcomeView, { WelcomeStarters } from "./WelcomeView";
import { COMPOSER_DRAFT_EVENT } from "./composer/draft-event";

afterEach(cleanup);

test("welcomes everyday work with a concise greeting", () => {
  render(<WelcomeView />);
  expect(screen.getByText("FloodMind")).toBeInTheDocument();
  expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("今天，想完成什么？");
});

test("offers three compact draft starters", () => {
  render(<WelcomeStarters />);
  expect(screen.getAllByRole("button")).toHaveLength(3);
  for (const title of ["整理一份文档", "分析一组数据", "推进一个计划"]) {
    const button = screen.getByRole("button", { name: title });
    expect(button).toHaveAttribute("title", expect.stringContaining("填入草稿后再发送"));
    expect(button.querySelector("svg")).toBeNull();
  }
});

test.each(["整理一份文档", "分析一组数据", "推进一个计划"])("starter %s dispatches a draft-only handoff", (title) => {
  const listener = vi.fn();
  window.addEventListener(COMPOSER_DRAFT_EVENT, listener);
  try {
    render(<WelcomeStarters />);
    fireEvent.click(screen.getByRole("button", { name: title }));
    expect(listener).toHaveBeenCalledTimes(1);
    expect((listener.mock.calls[0][0] as CustomEvent).detail).toEqual({ text: expect.any(String) });
    expect((listener.mock.calls[0][0] as CustomEvent).detail.text.length).toBeGreaterThan(15);
  } finally {
    window.removeEventListener(COMPOSER_DRAFT_EVENT, listener);
  }
});
