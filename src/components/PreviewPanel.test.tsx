import { render, screen, waitFor, fireEvent, cleanup } from "@testing-library/react";
import { test, expect, vi, afterEach } from "vitest";
import PreviewPanel from "./PreviewPanel";
import * as preview from "../lib/preview";

// The office renderers lazy-import their libraries; stub them so jsdom doesn't
// try to actually parse/render binary documents.
vi.mock("docx-preview", () => ({ renderAsync: vi.fn(async () => {}) }));
vi.mock("xlsx", () => ({
  read: () => ({ SheetNames: ["Sheet1"], Sheets: { Sheet1: {} } }),
  utils: { sheet_to_json: () => [["Name", "Score"], ["Alice", "95"]] },
}));
vi.mock("pptx-preview", () => ({
  init: () => ({ preview: async () => {} }),
}));

afterEach(cleanup);

test("renders text preview", async () => {
  vi.spyOn(preview, "fetchFilePreview").mockResolvedValue({ content: "hello", mime: "text/plain", previewable: true, path: "/ws/notes.txt" });
  render(<PreviewPanel path="notes.txt" onClose={() => {}} />);
  await waitFor(() => expect(screen.getByText("hello")).toBeInTheDocument());
});

test("renders image preview", async () => {
  vi.spyOn(preview, "fetchFilePreview").mockResolvedValue({ content: "base64data", mime: "image/png", previewable: true, path: "/ws/pic.png" });
  render(<PreviewPanel path="pic.png" onClose={() => {}} />);
  await waitFor(() => expect(document.querySelector("img")).toBeInTheDocument());
});

test("routes .docx to the office renderer", async () => {
  vi.spyOn(preview, "fetchFilePreview").mockResolvedValue({
    content: btoa("test"),
    mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    previewable: true,
    path: "/ws/report.docx",
  });
  render(<PreviewPanel path="report.docx" onClose={() => {}} />);
  await waitFor(() => expect(document.querySelector(".docx-preview")).toBeInTheDocument());
});

test("routes .xlsx to the office renderer with a table", async () => {
  vi.spyOn(preview, "fetchFilePreview").mockResolvedValue({
    content: btoa("test"),
    mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    previewable: true,
    path: "/ws/data.xlsx",
  });
  render(<PreviewPanel path="data.xlsx" onClose={() => {}} />);
  await waitFor(() => expect(document.querySelector(".xlsx-table")).toBeInTheDocument());
  await waitFor(() => expect(screen.getByText("Alice")).toBeInTheDocument());
});

test("renders unsupported document message for unknown non-office type", async () => {
  vi.spyOn(preview, "fetchFilePreview").mockResolvedValue({ content: "", mime: "application/octet-stream", previewable: false, path: "/ws/blob.bin" });
  render(<PreviewPanel path="blob.bin" onClose={() => {}} />);
  await waitFor(() => expect(screen.getByText("该文件类型暂不支持内置预览。")).toBeInTheDocument());
});

test("calls onClose when close button clicked", async () => {
  vi.spyOn(preview, "fetchFilePreview").mockResolvedValue({ content: "hello", mime: "text/plain", previewable: true, path: "/ws/notes.txt" });
  const onClose = vi.fn();
  render(<PreviewPanel path="notes.txt" onClose={onClose} />);
  await waitFor(() => expect(screen.getByText("hello")).toBeInTheDocument());
  fireEvent.click(screen.getByRole("button", { name: /关闭/i }));
  expect(onClose).toHaveBeenCalled();
});
