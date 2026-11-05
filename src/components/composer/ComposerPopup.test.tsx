import { useRef } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import ComposerPopup from "./ComposerPopup";
function Fixture({ close = vi.fn() }) {
  const anchor = useRef<HTMLButtonElement>(null);
  return <><button ref={anchor}>trigger</button><ComposerPopup anchor={anchor} triggers={[anchor]} width={300} onClose={close}><div tabIndex={0}>content</div><button>footer</button></ComposerPopup></>;
}
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
describe("ComposerPopup", () => {
  it("updates on viewport, captured scroll and observer events and cleans subscriptions", () => {
    let notify = () => {};
    const disconnect = vi.fn();
    vi.stubGlobal("ResizeObserver", class { constructor(callback: () => void) { notify = callback; } observe() {} disconnect = disconnect; });
    const viewport = new EventTarget();
    Object.assign(viewport, { offsetLeft: 0, offsetTop: 0, width: 800, height: 600 });
    vi.stubGlobal("visualViewport", viewport);
    const rect = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ left: 100, right: 180, top: 500, bottom: 532, width: 80, height: 32, x: 100, y: 500, toJSON() {} });
    const { unmount } = render(<Fixture />);
    const calls = rect.mock.calls.length;
    fireEvent.resize(window);
    fireEvent.scroll(document.body);
    viewport.dispatchEvent(new Event("resize"));
    viewport.dispatchEvent(new Event("scroll"));
    notify();
    expect(rect.mock.calls.length).toBeGreaterThan(calls);
    unmount();
    expect(disconnect).toHaveBeenCalledOnce();
    const after = rect.mock.calls.length;
    fireEvent.resize(window);
    fireEvent.scroll(document.body);
    viewport.dispatchEvent(new Event("resize"));
    expect(rect.mock.calls.length).toBe(after);
  });
  it("ignores internal/trigger clicks but dismisses external pointer and focus", () => {
    const close = vi.fn();
    const { unmount } = render(<Fixture close={close} />);
    fireEvent.mouseDown(screen.getByText("content"));
    fireEvent.mouseDown(screen.getByText("trigger"));
    expect(close).not.toHaveBeenCalled();
    fireEvent.mouseDown(document.body);
    expect(close).toHaveBeenLastCalledWith("outside");
    unmount();
    close.mockClear();
    fireEvent.mouseDown(document.body);
    expect(close).not.toHaveBeenCalled();
  });
});
