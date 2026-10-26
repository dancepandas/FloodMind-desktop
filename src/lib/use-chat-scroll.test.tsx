import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useChatScroll } from "./use-chat-scroll";

let height: number;
let viewportHeight: number;
let observers: MockResizeObserver[];
class MockResizeObserver {
  callback: ResizeObserverCallback;
  observe = vi.fn();
  disconnect = vi.fn();
  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    observers.push(this);
  }
  resize() { this.callback([], this as unknown as ResizeObserver); }
}

function Harness({ id = "a", version = 1, enabled = true }: { id?: string; version?: number; enabled?: boolean }) {
  const { scrollRef, contentRef, showJumpToLatest, jumpToLatest } = useChatScroll(id, version, enabled);
  return enabled ? (
    <>
      <div ref={scrollRef} data-testid="viewport"><div ref={contentRef}>content</div></div>
      {showJumpToLatest && <button onClick={jumpToLatest}>Latest</button>}
    </>
  ) : <div>Welcome</div>;
}
function viewport() { return screen.getByTestId("viewport"); }
function scrollTo(top: number) {
  viewport().scrollTop = top;
  fireEvent.scroll(viewport());
}
function resize() { act(() => observers.at(-1)!.resize()); }

beforeEach(() => {
  height = 1200;
  viewportHeight = 400;
  observers = [];
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(() => height);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(() => viewportHeight);
  // Model browser scrollTop clamping, rather than jsdom's unbounded property.
  const positions = new WeakMap<HTMLElement, number>();
  vi.spyOn(HTMLElement.prototype, "scrollTop", "get").mockImplementation(function (this: HTMLElement) {
    return Math.min(positions.get(this) ?? 0, Math.max(0, height - viewportHeight));
  });
  vi.spyOn(HTMLElement.prototype, "scrollTop", "set").mockImplementation(function (this: HTMLElement, value: number) {
    positions.set(this, Math.max(0, Math.min(value, height - viewportHeight)));
  });
  vi.stubGlobal("ResizeObserver", MockResizeObserver);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("useChatScroll", () => {
  it("opens at the bottom and follows repeated token updates without smooth scrolling", () => {
    const { rerender } = render(<Harness />);
    expect(viewport().scrollTop).toBe(800);
    height = 1500;
    rerender(<Harness version={2} />);
    expect(viewport().scrollTop).toBe(1100);
    height = 1700;
    rerender(<Harness version={3} />);
    expect(viewport().scrollTop).toBe(1300);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("preserves history position across updates and asynchronous content growth, then resumes on jump", () => {
    const { rerender } = render(<Harness />);
    scrollTo(300);
    expect(screen.getByRole("button", { name: "Latest" })).toBeInTheDocument();
    height = 1600;
    rerender(<Harness version={2} />);
    expect(viewport().scrollTop).toBe(300);
    height = 1800;
    resize();
    expect(viewport().scrollTop).toBe(300);
    fireEvent.click(screen.getByRole("button", { name: "Latest" }));
    expect(viewport().scrollTop).toBe(1400);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    height = 2000;
    rerender(<Harness version={3} />);
    expect(viewport().scrollTop).toBe(1600);
  });

  it("resumes following on manual return near the bottom, tolerating fractional pixels", () => {
    const { rerender } = render(<Harness />);
    scrollTo(100);
    scrollTo(750.5);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    height = 1400;
    rerender(<Harness version={2} />);
    expect(viewport().scrollTop).toBe(1000);
  });

  it("follows image/disclosure and viewport resizes only while at latest", () => {
    render(<Harness />);
    expect(observers[0].observe).toHaveBeenCalledTimes(2);
    height = 1600;
    resize();
    expect(viewport().scrollTop).toBe(1200);
    viewportHeight = 300;
    resize();
    expect(viewport().scrollTop).toBe(1300);
    scrollTo(200);
    viewportHeight = 450;
    resize();
    expect(viewport().scrollTop).toBe(200);
  });

  it("handles collapsed content becoming shorter than the viewport and follows again", () => {
    const { rerender } = render(<Harness />);
    scrollTo(200);
    height = 300;
    resize();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    height = 1000;
    rerender(<Harness version={2} />);
    expect(viewport().scrollTop).toBe(600);
  });

  it("resets following on conversation switches and disconnects old observers", () => {
    const { rerender, unmount } = render(<Harness />);
    scrollTo(200);
    const first = observers[0];
    height = 1800;
    rerender(<Harness id="b" />);
    expect(first.disconnect).toHaveBeenCalledOnce();
    expect(viewport().scrollTop).toBe(1400);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    scrollTo(100);
    rerender(<Harness id="a" />);
    expect(viewport().scrollTop).toBe(1400);
    unmount();
    expect(observers.at(-1)!.disconnect).toHaveBeenCalledOnce();
  });

  it("attaches when the welcome screen gains its first turn in the same conversation", () => {
    const { rerender } = render(<Harness enabled={false} />);
    expect(observers).toHaveLength(0);
    rerender(<Harness enabled />);
    expect(viewport().scrollTop).toBe(800);
    expect(observers).toHaveLength(1);
    rerender(<Harness enabled={false} />);
    expect(observers[0].disconnect).toHaveBeenCalledOnce();
  });

  it("still follows token updates when ResizeObserver is unavailable", () => {
    vi.stubGlobal("ResizeObserver", undefined);
    const { rerender } = render(<Harness />);
    height = 1500;
    rerender(<Harness version={2} />);
    expect(viewport().scrollTop).toBe(1100);
  });
});
