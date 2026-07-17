import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { fetchFilePreview } from "../lib/preview";
import { openFileInSystem } from "../lib/open-file";

const DocxPreview = lazy(() => import("./office/DocxPreview"));
const XlsxPreview = lazy(() => import("./office/XlsxPreview"));
const PptxPreview = lazy(() => import("./office/PptxPreview"));

const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const PPTX = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
const LEGACY_OFFICE = new Set([
  "application/msword",
  "application/vnd.ms-excel",
  "application/vnd.ms-powerpoint",
]);

export interface PreviewPanelProps {
  path: string;
  onClose: () => void;
}

/** Map a mime type to the office renderer to use, or null for non-office. */
function officeKind(mime: string): "docx" | "xlsx" | "pptx" | "legacy" | null {
  if (mime === DOCX) return "docx";
  if (mime === XLSX) return "xlsx";
  if (mime === PPTX) return "pptx";
  if (LEGACY_OFFICE.has(mime)) return "legacy";
  return null;
}

function base64ToBuffer(b64: string): ArrayBuffer {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  return bytes.buffer;
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

  const pdfUrl = useMemo(() => {
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
      if (pdfUrl) URL.revokeObjectURL(pdfUrl);
    };
  }, [pdfUrl]);

  const office = data ? officeKind(data.mime) : null;
  const officeBuffer = useMemo(
    () => (office && office !== "legacy" && data ? base64ToBuffer(data.content) : null),
    [office, data],
  );

  const isUnsupportedDoc =
    data &&
    !data.previewable &&
    !office &&
    !data.mime.startsWith("image/") &&
    !data.mime.startsWith("application/pdf");

  const officeFallback = (data && (office === "legacy")) || false;

  return (
    <div className="preview-panel">
      <div className="preview-panel-header">
        <span className="preview-title" title={path}>
          {path.split("/").pop()}
        </span>
        <div className="preview-header-actions">
          {data && (
            <button
              className="preview-open-system"
              onClick={() => openFileInSystem(data.path)}
              type="button"
              title="在系统中打开"
            >
              打开
            </button>
          )}
          <button
            className="preview-close"
            onClick={onClose}
            type="button"
            aria-label="关闭"
          >
            ✕
          </button>
        </div>
      </div>
      <div className="preview-body">
        {error && <div className="preview-error">{error}</div>}
        {!data && !error && <div className="preview-loading">加载中…</div>}
        {data && data.mime.startsWith("image/") && (
          <img src={`data:${data.mime};base64,${data.content}`} alt={path} />
        )}
        {data && data.mime.startsWith("application/pdf") && (
          pdfUrl ? (
            <iframe
              src={pdfUrl}
              title={path}
              className="preview-iframe"
              width="100%"
              height="100%"
            />
          ) : (
            <div className="preview-error">无法渲染 PDF</div>
          )
        )}
        {office === "docx" && officeBuffer && (
          <Suspense fallback={<div className="preview-loading">加载中…</div>}>
            <DocxPreview data={officeBuffer} path={data!.path} />
          </Suspense>
        )}
        {office === "xlsx" && officeBuffer && (
          <Suspense fallback={<div className="preview-loading">加载中…</div>}>
            <XlsxPreview data={officeBuffer} path={data!.path} />
          </Suspense>
        )}
        {office === "pptx" && officeBuffer && (
          <Suspense fallback={<div className="preview-loading">加载中…</div>}>
            <PptxPreview data={officeBuffer} path={data!.path} />
          </Suspense>
        )}
        {officeFallback && (
          <div className="preview-unsupported">
            <p>旧版 Office 格式（.doc/.xls/.ppt）暂不支持内置预览。</p>
            <button
              type="button"
              className="btn-secondary"
              onClick={() => data && openFileInSystem(data.path)}
            >
              在系统中打开
            </button>
          </div>
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
        {data && data.previewable && !office && !data.mime.startsWith("image/") && !data.mime.startsWith("application/pdf") && (
          <pre className="preview-text">{data.content}</pre>
        )}
      </div>
    </div>
  );
}
