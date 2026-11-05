import type { ImageItem } from "../../state/attachment-store";
import { looksLikeFsPath } from "../../lib/file-refs";

type Props = {
  files: string[];
  images: ImageItem[];
  onPreviewFile: (path: string) => void;
  onPreviewImage: (image: { src: string; name: string }) => void;
  onRemoveFile: (path: string) => void;
  onRemoveImage: (id: string) => void;
};

export default function AttachmentTray({ files, images, onPreviewFile, onPreviewImage, onRemoveFile, onRemoveImage }: Props) {
  if (!files.length && !images.length) return null;
  return (
    <div className="fm-attachment-tray" role="group" aria-label="待发送附件">
      {files.map((path) => (
        <span key={path} className="fm-file-card" title={path}>
          <button type="button" className="fm-file-preview" onClick={() => onPreviewFile(path)} aria-label={`预览 ${path}`}>
            <svg width="18" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
              <path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8Z" /><path d="M14 3v5h5M8 13h8M8 17h5" />
            </svg>
            <span className="fm-file-name">{path.split(/[\\/]/).pop() || path}</span>
            {looksLikeFsPath(path) && <span className="fm-external-badge">外部</span>}
          </button>
          <button type="button" className="fm-attachment-remove" onClick={() => onRemoveFile(path)} aria-label={`移除 ${path}`}>×</button>
        </span>
      ))}
      {images.map((image) => (
        <span key={image.id} className="fm-image-card" title={image.name}>
          <button type="button" className="fm-image-preview" onClick={() => onPreviewImage({ src: image.thumb, name: image.name })} aria-label={`预览 ${image.name}`}>
            <img src={image.thumb} alt={image.name} />
          </button>
          <button type="button" className="fm-attachment-remove fm-image-remove" onClick={() => onRemoveImage(image.id)} aria-label={`移除 ${image.name}`}>×</button>
        </span>
      ))}
    </div>
  );
}
