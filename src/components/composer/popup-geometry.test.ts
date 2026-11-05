import { describe, expect, it } from "vitest";
import { popupGeometry, type Rect } from "./popup-geometry";
const bounds = { left: 0, top: 0, right: 800, bottom: 600 };
const rect = (left: number, top: number): Rect => ({ left, top, right: left + 80, bottom: top + 32 });
describe("popupGeometry", () => {
  it("opens up at the bottom and down at the top", () => {
    expect(popupGeometry(rect(100, 550), rect(100, 550), bounds, bounds, 300).direction).toBe("up");
    expect(popupGeometry(rect(100, 20), rect(100, 20), bounds, bounds, 300).direction).toBe("down");
  });
  it("uses one trigger envelope even with triggers on different rows", () => {
    const envelope = { left: 10, right: 750, top: 260, bottom: 350 };
    const positions = [rect(10, 260), rect(400, 318), rect(700, 318)].map((r) => popupGeometry(r, envelope, bounds, bounds, 300));
    expect(new Set(positions.map((p) => p.direction)).size).toBe(1);
  });
  it.each([rect(-80, 50), rect(780, 550), rect(300, -30)])("clamps horizontal and vertical space", (anchor) => {
    const p = popupGeometry(anchor, anchor, bounds, bounds, 300);
    expect(p.left).toBeGreaterThanOrEqual(8);
    expect(p.left + p.width).toBeLessThanOrEqual(792);
    expect(p.direction === "up" ? p.top - p.maxHeight : p.top).toBeGreaterThanOrEqual(8);
    expect(p.direction === "down" ? p.top + p.maxHeight : p.top).toBeLessThanOrEqual(592);
  });
  it("intersects app and offset visual viewport in narrow, short windows", () => {
    const app = { left: 20, top: 30, right: 500, bottom: 400 };
    const viewport = { left: 100, top: 140, right: 210, bottom: 200 };
    const anchor = rect(190, 170);
    const p = popupGeometry(anchor, anchor, app, viewport, 300);
    expect(p.width).toBe(94);
    expect(p.left).toBe(108);
    expect(p.maxHeight).toBeLessThanOrEqual(44);
    expect(p.direction === "up" ? p.top - p.maxHeight : p.top).toBeGreaterThanOrEqual(148);
  });
});
