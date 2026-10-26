import { useCallback, useEffect, useRef, useState } from "react";

interface UseResizableWidthOptions {
  storageKey: string;
  defaultWidth: number;
  minWidth: number;
  maxWidth: number;
  edge: "left" | "right";
}

export function useResizableWidth({
  storageKey,
  defaultWidth,
  minWidth,
  maxWidth,
  edge,
}: UseResizableWidthOptions) {
  const [width, setWidth] = useState(() => {
    try {
      const stored = localStorage.getItem(storageKey);
      if (stored) {
        const parsed = parseInt(stored, 10);
        if (!Number.isNaN(parsed)) return Math.max(minWidth, Math.min(maxWidth, parsed));
      }
    } catch {}
    return defaultWidth;
  });
  const draggingRef = useRef(false);
  const startXRef = useRef(0);
  const startWidthRef = useRef(width);
  const widthRef = useRef(width);

  useEffect(() => {
    widthRef.current = width;
  }, [width]);

  const startResize = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      draggingRef.current = true;
      startXRef.current = e.clientX;
      startWidthRef.current = widthRef.current;
      document.body.style.cursor = "ew-resize";
      document.body.style.userSelect = "none";
    },
    [edge]
  );

  useEffect(() => {
    function onMove(e: MouseEvent) {
      if (!draggingRef.current) return;
      const delta = edge === "left" ? startXRef.current - e.clientX : e.clientX - startXRef.current;
      const next = Math.max(minWidth, Math.min(maxWidth, startWidthRef.current + delta));
      setWidth(next);
    }
    function onUp() {
      if (!draggingRef.current) return;
      draggingRef.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      try {
        localStorage.setItem(storageKey, String(widthRef.current));
      } catch {}
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      if (draggingRef.current) {
        draggingRef.current = false;
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      }
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [edge, minWidth, maxWidth, storageKey]);

  const persistWidth = useCallback((next: number) => {
    widthRef.current = next;
    setWidth(next);
    try { localStorage.setItem(storageKey, String(next)); } catch {}
  }, [storageKey]);

  const onKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
    e.preventDefault();
    const direction = (e.key === "ArrowRight" ? 1 : -1) * (edge === "left" ? -1 : 1);
    const next = e.key === "Home" ? minWidth : e.key === "End" ? maxWidth
      : Math.max(minWidth, Math.min(maxWidth, widthRef.current + direction * (e.shiftKey ? 40 : 10)));
    persistWidth(next);
  }, [edge, minWidth, maxWidth, persistWidth]);

  return { width, startResize, onKeyDown };
}
