import { describe, it, expect, afterEach, beforeAll } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import Conversation from "./Conversation";
import { useChatStore, _resetBlockIdsForTest } from "../state/chat-store";
import { useUiStore } from "../state/ui-store";

// jsdom doesn't implement Element.scrollIntoView; the Conversation mounts and
// runs its auto-scroll effect on every test, so stub it before any render.
beforeAll(() => {
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = function () {};
  }
});

afterEach(() => {
  cleanup();
  // Reset the store + id counter between tests so seeding is order-independent.
  useChatStore.setState({ turns: [], streaming: false });
  useUiStore.setState({ previewPath: null, lightboxImage: null });
  _resetBlockIdsForTest();
});

describe("Conversation", () => {
  it("renders image thumbnails on a user turn that carried images", () => {
    useChatStore.setState({
      turns: [
        {
          id: "u1",
          role: "user",
          content: "看图",
          images: [{ name: "chart.png", thumb: "data:image/png;base64,AAAA" }],
        },
      ] as any,
    });
    render(<Conversation />);
    const imgs = screen.getAllByRole("img");
    expect(imgs.some((i) => (i as HTMLImageElement).src.startsWith("data:image/png"))).toBe(true);
  });

  it("renders no thumbnails on a user turn without images", () => {
    useChatStore.setState({
      turns: [{ id: "u2", role: "user", content: "纯文本" }] as any,
    });
    render(<Conversation />);
    // No image thumbnails should be present on an image-less user bubble.
    expect(screen.queryAllByRole("img")).toHaveLength(0);
  });

  it("renders a referenced file as a chip that opens the preview panel", () => {
    useChatStore.setState({
      turns: [
        {
          id: "u3",
          role: "user",
          content: "看下这个",
          attachments: [{ path: "notes/report.txt", name: "report.txt" }],
        },
      ] as any,
    });
    render(<Conversation />);
    const chip = screen.getByText("report.txt").closest("button")!;
    expect(chip).toBeInTheDocument();
    fireEvent.click(chip);
    // Clicking the file chip routes to the right-side PreviewPanel.
    expect(useUiStore.getState().previewPath).toBe("notes/report.txt");
  });
});
