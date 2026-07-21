import { useEffect } from "react";
import { useUiStore } from "../state/ui-store";

/**
 * Full-screen image preview overlay. Independent of the file PreviewPanel.
 * State lives in ui-store (`lightboxImage`); open via `openLightbox({src,name})`
 * from a composer attachment thumb or a message-bubble thumb. The stored `src`
 * is always a data: URL (both composer thumbs and bubble thumbs are base64), so
 * no extra fetch is needed here.
 */
export default function Lightbox() {
  const image = useUiStore((s) => s.lightboxImage);
  const close = useUiStore((s) => s.closeLightbox);

  // Close on Escape while open.
  useEffect(() => {
    if (!image) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [image, close]);

  if (!image) return null;

  return (
    // The dim backdrop closes the lightbox; clicking the image itself does not
    // (stopPropagation) so users can't accidentally dismiss while inspecting.
    <div
      className="lightbox-overlay"
      role="dialog"
      aria-label={`预览 ${image.name}`}
      onClick={close}
    >
      <button
        type="button"
        className="lightbox-close"
        onClick={close}
        aria-label="关闭预览"
      >
        ✕
      </button>
      <figure className="lightbox-figure" onClick={(e) => e.stopPropagation()}>
        <img className="lightbox-img" src={image.src} alt={image.name} />
        <figcaption className="lightbox-name">{image.name}</figcaption>
      </figure>
    </div>
  );
}
