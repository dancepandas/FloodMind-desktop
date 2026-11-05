import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import Lightbox from "./Lightbox";
import { useUiStore } from "../state/ui-store";

const SRC = "data:image/png;base64,AAAA";

describe("Lightbox", () => {
  afterEach(() => cleanup());

  beforeEach(() => {
    useUiStore.setState({ lightboxImage: null });
  });

  it("renders nothing when no image is open", () => {
    const { container } = render(<Lightbox />);
    expect(container.firstChild).toBeNull();
  });

  it("shows the image and its name when opened", () => {
    useUiStore.setState({ lightboxImage: { src: SRC, name: "shot.png" } });
    render(<Lightbox />);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    const img = screen.getByAltText("shot.png") as HTMLImageElement;
    expect(img).toHaveAttribute("src", SRC);
    expect(screen.getByText("shot.png")).toBeInTheDocument();
  });

  it("closes on Escape", () => {
    useUiStore.setState({ lightboxImage: { src: SRC, name: "shot.png" } });
    render(<Lightbox />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(useUiStore.getState().lightboxImage).toBeNull();
  });

  it("closes on backdrop click but not on image click", () => {
    useUiStore.setState({ lightboxImage: { src: SRC, name: "shot.png" } });
    render(<Lightbox />);
    // Clicking the image itself must NOT dismiss the overlay.
    fireEvent.click(screen.getByAltText("shot.png"));
    expect(useUiStore.getState().lightboxImage).not.toBeNull();
    // Clicking the dim backdrop closes it.
    fireEvent.click(screen.getByRole("dialog"));
    expect(useUiStore.getState().lightboxImage).toBeNull();
  });
});
