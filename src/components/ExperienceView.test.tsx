import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import ExperienceView from "./ExperienceView";

vi.mock("../lib/sidecar-client", () => ({ getBaseUrl: vi.fn(async () => "http://localhost") }));

const leaves = [
  { node_id: "one", path: ["数据", "csv"], task_description: "清理 CSV", skill_used: "csv", domain_keywords: [], pitfalls: ["编码错误"], solutions: ["使用 UTF-8"], final_outcome: "success", importance: 0.8, hit_count: 3, success_count: 2, failure_count: 1, updated_at: "" },
  { node_id: "two", path: ["数据", "xlsx"], task_description: "整理表格", skill_used: "", domain_keywords: [], pitfalls: [], solutions: [], final_outcome: "failure", importance: 0.5, hit_count: 1, success_count: 0, failure_count: 1, updated_at: "" },
];

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => ({
    ok: true,
    json: async () => url.includes("/search?")
      ? { results: [leaves[1]] }
      : { stats: { leaf_cases: 2 }, summaries: [], leaves },
  })));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("ExperienceView gallery", () => {
  it("keeps complete card contents and feedback inside domain groups", async () => {
    render(<ExperienceView />);
    await screen.findByText("清理 CSV");
    expect(screen.getByRole("heading", { name: "数据" })).toBeInTheDocument();
    expect(screen.getAllByRole("article")).toHaveLength(2);
    const card = screen.getAllByRole("article")[0];
    for (const text of ["编码错误", "使用 UTF-8", "重要度 80%", "引用 3"]) {
      expect(within(card).getByText(text)).toBeInTheDocument();
    }
    fireEvent.click(within(card).getByRole("button", { name: "有帮助" }));
    await waitFor(() => expect(fetch).toHaveBeenCalledWith("http://localhost/api/experience/feedback", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ node_id: "one", helpful: true }),
    }));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
  });

  it("searches by Enter, resets results, and runs maintenance", async () => {
    render(<ExperienceView />);
    await screen.findByText("清理 CSV");
    const input = screen.getByRole("searchbox", { name: "搜索经验" });
    fireEvent.change(input, { target: { value: "表格" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(screen.queryByText("清理 CSV")).not.toBeInTheDocument());
    expect(screen.getByText("整理表格")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "重置" }));
    expect(screen.getByText("清理 CSV")).toBeInTheDocument();
    expect(input).toHaveValue("");
    fireEvent.click(screen.getByRole("button", { name: "维护" }));
    await waitFor(() => expect(fetch).toHaveBeenCalledWith("http://localhost/api/experience/maintain", { method: "POST" }));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(4));
  });
});
