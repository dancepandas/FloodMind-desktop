export interface Rect { left: number; top: number; right: number; bottom: number }
export interface PopupGeometry { left: number; top: number; width: number; maxHeight: number; direction: "up" | "down" }

/** All coordinates are layout-viewport CSS pixels, including visualViewport offsets. */
export function popupGeometry(anchor: Rect, envelope: Rect, app: Rect, viewport: Rect, preferredWidth: number, preferredHeight = 360): PopupGeometry {
  const left = Math.max(app.left, viewport.left);
  const right = Math.max(left, Math.min(app.right, viewport.right));
  const top = Math.max(app.top, viewport.top);
  const bottom = Math.max(top, Math.min(app.bottom, viewport.bottom));
  const insetX = Math.min(8, (right - left) / 2);
  const insetY = Math.min(8, (bottom - top) / 2);
  const bounds = { left: left + insetX, right: right - insetX, top: top + insetY, bottom: bottom - insetY };
  const above = Math.max(0, envelope.top - bounds.top - 6);
  const below = Math.max(0, bounds.bottom - envelope.bottom - 6);
  // Direction uses the union of the three triggers, never an individual anchor.
  const direction = above >= preferredHeight || above >= below ? "up" : "down";
  const edge = direction === "up" ? Math.min(bounds.bottom, Math.max(bounds.top, anchor.top - 6)) : Math.max(bounds.top, Math.min(bounds.bottom, anchor.bottom + 6));
  const maxHeight = Math.min(preferredHeight, direction === "up" ? edge - bounds.top : bounds.bottom - edge);
  const width = Math.min(preferredWidth, bounds.right - bounds.left);
  return {
    direction, width, maxHeight,
    left: Math.max(bounds.left, Math.min(anchor.left, bounds.right - width)),
    top: edge,
  };
}
