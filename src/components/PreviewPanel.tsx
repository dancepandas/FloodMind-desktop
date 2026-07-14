import { useEffect, useMemo, useState } from "react";
import { fetchFilePreview } from "../lib/preview";
import { openFileInSystem } from "../lib/open-file";

export interface PreviewPanelProps {
  path: string;
  onClose: () => void;
}

export default function PreviewPanel({ path, onClose }: PreviewPanelProps) {
  const [data, setData] = useState<{
    content: string;
    mime: string;
    previewable: boolean;
    path: string;
  } | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    fetchFilePreview(path)
      .then(setData)
      .catch((e) => setError(e.message));
  }, [path]);

  const objectUrl = useMemo(() => {
    if (!data || !data.mime.startsWith("application/pdf")) return null;
    try {
      const bytes = Uint8Array.from(atob(data.content), (c) => c.charCodeAt(0));
      const blob = new Blob([bytes], { type: data.mime });
      return URL.createObjectURL(blob);
    } catch {
      return null;
    }
  }, [data]);

  useEffect(() => {
    return () => {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [objectUrl]);

  const isUnsupportedDoc =
    data &&
    !data.previewable &&
    !data.mime.startsWith("image/") &&
    !data.mime.startsWith("application/pdf");

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
          aria-label="关闭"
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
        {data && data.mime.startsWith("application/pdf") && (
          objectUrl ? (
            <iframe
              src={objectUrl}
              title={path}
              className="preview-iframe"
              width="100%"
              height="100%"
            />
          ) : (
            <div className="preview-error">无法渲染 PDF</div>
          )
        )}
        {isUnsupportedDoc && (
          <div className="preview-unsupported">
            <p>该文件类型暂不支持内置预览。</p>
            <button
              type="button"
              className="btn-secondary"
              onClick={() => data && openFileInSystem(data.path)}
            >
              在系统中打开
            </button>
          </div>
        )}
        {data && data.previewable && !data.mime.startsWith("image/") && !data.mime.startsWith("application/pdf") && (
          <pre className="preview-text">{data.content}</pre>
        )}
      </div>
    </div>
  );
}
