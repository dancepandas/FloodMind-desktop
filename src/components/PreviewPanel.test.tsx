import { render, screen, waitFor, fireEvent, cleanup } from "@testing-library/react";
import { test, expect, vi, afterEach } from "vitest";
import PreviewPanel from "./PreviewPanel";
import * as preview from "../lib/preview";

afterEach(cleanup);

test("renders text preview", async () => {
  vi.spyOn(preview, "fetchFilePreview").mockResolvedValue({ content: "hello", mime: "text/plain" });
  render(<PreviewPanel path="notes.txt" onClose={() => {}} />);
  await waitFor(() => expect(screen.getByText("hello")).toBeInTheDocument());
});

test("renders image preview", async () => {
  vi.spyOn(preview, "fetchFilePreview").mockResolvedValue({ content: "base64data", mime: "image/png" });
  render(<PreviewPanel path="pic.png" onClose={() => {}} />);
  await waitFor(() => expect(document.querySelector("img")).toBeInTheDocument());
});

test("calls onClose when close button clicked", async () => {
  vi.spyOn(preview, "fetchFilePreview").mockResolvedValue({ content: "hello", mime: "text/plain" });
  const onClose = vi.fn();
  render(<PreviewPanel path="notes.txt" onClose={onClose} />);
  await waitFor(() => expect(screen.getByText("hello")).toBeInTheDocument());
  fireEvent.click(screen.getByRole("button", { name: /close/i }));
  expect(onClose).toHaveBeenCalled();
});
