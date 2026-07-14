import { render, screen, waitFor, fireEvent, cleanup } from "@testing-library/react";
import { test, expect, vi, afterEach } from "vitest";
import PreviewPanel from "./PreviewPanel";
import * as preview from "../lib/preview";

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

test("renders unsupported document message", async () => {
  vi.spyOn(preview, "fetchFilePreview").mockResolvedValue({ content: "", mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", previewable: false, path: "/ws/report.docx" });
  render(<PreviewPanel path="report.docx" onClose={() => {}} />);
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
