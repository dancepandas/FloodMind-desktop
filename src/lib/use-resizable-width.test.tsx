import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useResizableWidth } from "./use-resizable-width";

const storageKey = "test.resizable.width";
function Harness({ edge }: { edge: "left" | "right" }) {
  const { width, onKeyDown } = useResizableWidth({ storageKey, defaultWidth: 250, minWidth: 180, maxWidth: 400, edge });
  return <div role="separator" tabIndex={0} aria-valuenow={width} onKeyDown={onKeyDown} />;
}
function expectWidth(width: number) {
  expect(screen.getByRole("separator")).toHaveAttribute("aria-valuenow", String(width));
  expect(localStorage.getItem(storageKey)).toBe(String(width));
}

beforeEach(() => localStorage.removeItem(storageKey));
afterEach(() => { cleanup(); localStorage.removeItem(storageKey); });

describe.each(["left", "right"] as const)("keyboard resizing at the %s edge", (edge) => {
  const grow = edge === "right" ? "ArrowRight" : "ArrowLeft";
  const shrink = edge === "right" ? "ArrowLeft" : "ArrowRight";

  it("moves in both physical directions, with a larger Shift step, and persists across remounts", () => {
    const first = render(<Harness edge={edge} />);
    const separator = screen.getByRole("separator");
    separator.focus();
    expect(fireEvent.keyDown(separator, { key: grow })).toBe(false);
    expectWidth(260);
    fireEvent.keyDown(separator, { key: shrink });
    expectWidth(250);
    fireEvent.keyDown(separator, { key: grow, shiftKey: true });
    expectWidth(290);
    fireEvent.keyDown(separator, { key: shrink, shiftKey: true });
    expectWidth(250);
    // Multiple events in one React batch must use the latest width, not a stale render.
    act(() => {
      fireEvent.keyDown(separator, { key: grow });
      fireEvent.keyDown(separator, { key: grow });
    });
    expectWidth(270);
    expect(separator).toHaveFocus();
    first.unmount();
    render(<Harness edge={edge} />);
    expectWidth(270);
  });

  it("supports Home and End and clamps normal and Shift arrows at both limits", () => {
    render(<Harness edge={edge} />);
    const separator = screen.getByRole("separator");
    expect(fireEvent.keyDown(separator, { key: "Home" })).toBe(false);
    expectWidth(180);
    fireEvent.keyDown(separator, { key: shrink });
    expectWidth(180);
    fireEvent.keyDown(separator, { key: grow });
    expectWidth(190);
    fireEvent.keyDown(separator, { key: shrink, shiftKey: true });
    expectWidth(180);
    expect(fireEvent.keyDown(separator, { key: "End" })).toBe(false);
    expectWidth(400);
    fireEvent.keyDown(separator, { key: grow });
    expectWidth(400);
    fireEvent.keyDown(separator, { key: shrink });
    expectWidth(390);
    fireEvent.keyDown(separator, { key: grow, shiftKey: true });
    expectWidth(400);
  });

  it("does not consume unrelated keys or persist an unchanged default", () => {
    render(<Harness edge={edge} />);
    const separator = screen.getByRole("separator");
    for (const key of ["Tab", "ArrowUp", "ArrowDown", "Enter"]) {
      expect(fireEvent.keyDown(separator, { key })).toBe(true);
    }
    expect(separator).toHaveAttribute("aria-valuenow", "250");
    expect(localStorage.getItem(storageKey)).toBeNull();
  });
});
