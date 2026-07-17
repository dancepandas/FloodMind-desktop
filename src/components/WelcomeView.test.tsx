import { render, screen, cleanup } from "@testing-library/react";
import { test, expect, afterEach } from "vitest";
import WelcomeView from "./WelcomeView";

afterEach(cleanup);

test("renders title and subtitle", () => {
  render(<WelcomeView />);

  expect(screen.getByText("FloodMind")).toBeInTheDocument();
  expect(screen.getByText(/水文智能助手/)).toBeInTheDocument();
});

test("renders a hydrology usage example", () => {
  render(<WelcomeView />);

  // Hint copy must be hydrology-themed (降雨/径流/流量) — matches both the
  // subtitle and the example line.
  expect(screen.getAllByText(/径流/).length).toBeGreaterThan(0);
});

test("does not render quick-action options or chips", () => {
  render(<WelcomeView />);

  // The quick-action buttons and scenario chips were removed.
  expect(screen.queryByRole("button")).toBeNull();
  expect(screen.queryByText("文档处理")).toBeNull();
  expect(screen.queryByText("日常办公")).toBeNull();
});
