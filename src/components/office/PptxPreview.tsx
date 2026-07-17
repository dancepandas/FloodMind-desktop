import { useEffect, useRef, useState } from "react";
import OfficeFallback from "./OfficeFallback";

/** Best-effort .pptx preview via pptx-preview (pure-frontend). Slides render at
 *  a fixed width, so we zoom-to-fit the panel (same idea as DocxPreview) and
 *  fall back to horizontal scroll if anything still overflows. Client-side
 *  PowerPoint rendering is less mature than Word/Excel, so any hard failure
 *  falls back to "open in system". The library is imported dynamically. */
export default function PptxPreview({ data, path }: { data: ArrayBuffer; path: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);

  const fit = () => {
    const root = ref.current;
    if (!root) return;
    root.style.zoom = ""; // reset to measure true content width
    const first = root.firstElementChild as HTMLElement | null;
    const contentWidth = first ? first.offsetWidth : root.scrollWidth;
    const avail = root.clientWidth;
    if (contentWidth > 0 && avail > 0 && contentWidth > avail) {
      root.style.zoom = String(avail / contentWidth);
    }
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const mod = await import("pptx-preview");
        const init = mod.init || mod.default?.init;
        if (!init || !ref.current) throw new Error("pptx-preview init unavailable");
        const viewer = init(ref.current);
        await viewer.preview(data);
        if (cancelled) return;
        fit();
        const t = window.setTimeout(fit, 400);
        return () => window.clearTimeout(t);
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [data]);

  useEffect(() => {
    const root = ref.current;
    if (!root || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => fit());
    ro.observe(root);
    return () => ro.disconnect();
  }, []);

  if (failed) return <OfficeFallback path={path} />;
  return <div className="office-preview pptx-preview" ref={ref} />;
}
