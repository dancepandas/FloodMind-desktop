import { useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { popupGeometry, type PopupGeometry } from "./popup-geometry";

export type CloseReason = "escape" | "select" | "outside" | "tab";
interface Props {
  anchor: RefObject<HTMLButtonElement | null>;
  triggers: RefObject<HTMLButtonElement | null>[];
  width: number;
  onClose: (reason: CloseReason) => void;
  children: ReactNode;
}
export default function ComposerPopup({ anchor, triggers, width, onClose, children }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [geometry, setGeometry] = useState<PopupGeometry | null>(null);
  // Keep listeners stable while callbacks and trigger arrays change on renders.
  const latest = useRef({ anchor, triggers, width, onClose });
  latest.current = { anchor, triggers, width, onClose };
  useLayoutEffect(() => {
    const update = () => {
      const { anchor, triggers, width } = latest.current;
      if (!anchor.current) return;
      const rects = triggers.flatMap((r) => r.current ? [r.current.getBoundingClientRect()] : []);
      const envelope = { top: Math.min(...rects.map((r) => r.top)), bottom: Math.max(...rects.map((r) => r.bottom)), left: 0, right: 0 };
      const viewport = window.visualViewport;
      const visible = { left: viewport?.offsetLeft ?? 0, top: viewport?.offsetTop ?? 0, right: (viewport?.offsetLeft ?? 0) + (viewport?.width ?? window.innerWidth), bottom: (viewport?.offsetTop ?? 0) + (viewport?.height ?? window.innerHeight) };
      const root = document.querySelector(".app") ?? document.getElementById("root");
      const rect = root?.getBoundingClientRect();
      const app = rect && rect.width > 0 && rect.height > 0 ? rect : visible;
      setGeometry(popupGeometry(anchor.current.getBoundingClientRect(), envelope, app, visible, width));
    };
    const outside = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!ref.current?.contains(target) && !latest.current.triggers.some((r) => r.current?.contains(target))) latest.current.onClose("outside");
    };
    const focus = (event: FocusEvent) => {
      const target = event.target as Node;
      if (!ref.current?.contains(target) && !latest.current.triggers.some((r) => r.current?.contains(target))) latest.current.onClose("outside");
    };
    update();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    latest.current.triggers.forEach((r) => {
      if (r.current) {
        observer?.observe(r.current);
        const composer = r.current.closest(".fm-composer-wrap");
        if (composer) observer?.observe(composer);
      }
    });
    const root = document.querySelector(".app") ?? document.getElementById("root");
    if (root) observer?.observe(root);
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    window.visualViewport?.addEventListener("resize", update);
    window.visualViewport?.addEventListener("scroll", update);
    document.addEventListener("mousedown", outside);
    document.addEventListener("focusin", focus);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
      window.visualViewport?.removeEventListener("resize", update);
      window.visualViewport?.removeEventListener("scroll", update);
      document.removeEventListener("mousedown", outside);
      document.removeEventListener("focusin", focus);
    };
  }, []);
  return createPortal(<div ref={ref} className="fm-composer-popup" data-direction={geometry?.direction}
    style={geometry ? { left: geometry.left, top: geometry.top, width: geometry.width, maxHeight: geometry.maxHeight, transform: geometry.direction === "up" ? "translateY(-100%)" : undefined } : { visibility: "hidden" }}
    onKeyDown={(event) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose("escape"); }
      if (event.key !== "Tab") return;
      const stops = Array.from(ref.current?.querySelectorAll<HTMLElement>('[tabindex="0"], button:not(:disabled)') ?? []);
      const index = stops.indexOf(document.activeElement as HTMLElement);
      if ((!event.shiftKey && index < stops.length - 1) || (event.shiftKey && index > 0)) return;
      event.preventDefault();
      const trigger = anchor.current;
      onClose("tab");
      if (event.shiftKey) { trigger?.focus(); return; }
      const all = Array.from(document.querySelectorAll<HTMLElement>('button:not(:disabled), textarea:not(:disabled), input:not(:disabled), select:not(:disabled), a[href], [tabindex="0"]')).filter((el) => !ref.current?.contains(el) && !el.closest('[hidden], [inert]'));
      all[all.indexOf(trigger!) + 1]?.focus();
    }}>
    {children}
  </div>, document.body);
}
