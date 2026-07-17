import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { test, expect, vi, afterEach } from "vitest";
import WelcomeSplash from "./WelcomeSplash";

afterEach(cleanup);

test("renders the welcome title and enter button", () => {
  render(<WelcomeSplash onEnter={() => {}} />);
  expect(screen.getByText("欢迎使用 FloodMind")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "开始使用" })).toBeInTheDocument();
});

test("clicking the button calls onEnter once", () => {
  const onEnter = vi.fn();
  render(<WelcomeSplash onEnter={onEnter} />);
  fireEvent.click(screen.getByRole("button", { name: "开始使用" }));
  expect(onEnter).toHaveBeenCalledTimes(1);
});
