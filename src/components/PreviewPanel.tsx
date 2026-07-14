import { useEffect, useState } from "react";
import { fetchFilePreview } from "../lib/preview";

export interface PreviewPanelProps {
  path: string;
  onClose: () => void;
}

export default function PreviewPanel({ path, onClose }: PreviewPanelProps) {
  const [data, setData] = useState<{ content: string; mime: string } | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    fetchFilePreview(path)
      .then(setData)
      .catch((e) => setError(e.message));
  }, [path]);

  return (
    <div className="preview-panel">
      <div className="preview-panel-header">
        <span className="preview-title" title={path}>
          {path.split("/").pop()}
        </span>
        <button
          className="preview-close"
          onClick={onClose}
          type="button"
          aria-label="Close"
        >
          ✕
        </button>
      </div>
      <div className="preview-body">
        {error && <div className="preview-error">{error}</div>}
        {!data && !error && <div className="preview-loading">加载中…</div>}
        {data && data.mime.startsWith("image/") && (
          <img src={`data:${data.mime};base64,${data.content}`} alt={path} />
        )}
        {data && !data.mime.startsWith("image/") && (
          <pre className="preview-text">{data.content}</pre>
        )}
      </div>
    </div>
  );
}
