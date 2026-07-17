import { useEffect, useRef, useState } from "react";
import OfficeFallback from "./OfficeFallback";

/** Render a .docx into a faithful HTML document view via docx-preview.
 *  Word pages are a fixed pixel width, so we zoom-to-fit the panel width
 *  (WebView2 supports CSS `zoom`, which reflows — height adapts automatically).
 *  The library is imported dynamically so it stays out of the main bundle. */
export default function DocxPreview({ data, path }: { data: ArrayBuffer; path: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);

  const fit = () => {
    const root = ref.current;
    if (!root) return;
    const wrapper = root.querySelector<HTMLElement>(".docx-wrapper");
    const page = root.querySelector<HTMLElement>(".docx-wrapper > section");
    if (!wrapper || !page) return;
    wrapper.style.zoom = ""; // reset to measure the true page width
    const pageWidth = page.offsetWidth;
    const avail = root.clientWidth;
    if (pageWidth > 0 && avail > 0 && pageWidth > avail) {
      wrapper.style.zoom = String(avail / pageWidth);
    }
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { renderAsync } = await import("docx-preview");
        if (cancelled || !ref.current) return;
        ref.current.innerHTML = "";
        await renderAsync(data, ref.current, undefined, {
          inWrapper: true,
          ignoreWidth: false,
          ignoreHeight: false,
        });
        fit();
        // Images/fonts may settle a tick after the initial layout.
        const t1 = window.setTimeout(fit, 250);
        const t2 = window.setTimeout(fit, 800);
        return () => {
          window.clearTimeout(t1);
          window.clearTimeout(t2);
        };
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [data]);

  // Re-fit when the panel is resized.
  useEffect(() => {
    const root = ref.current;
    if (!root || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => fit());
    ro.observe(root);
    return () => ro.disconnect();
  }, []);

  if (failed) return <OfficeFallback path={path} />;
  return <div className="office-preview docx-preview" ref={ref} />;
}
