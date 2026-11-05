import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { fetchFilePreview, type PreviewData } from "../lib/preview";
import { openFileInSystem } from "../lib/open-file";
import { useUiStore } from "../state/ui-store";

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
  const setPreviewPath = useUiStore((s) => s.setPreviewPath);
  const [data, setData] = useState<PreviewData | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    fetchFilePreview(path)
      .then(setData)
      .catch((e) => setError(e.message));
  }, [path]);

  // Directory listings (dropped external folders) have no content/mime fields.
  const file = data && data.kind === "file" ? data : null;

  const pdfUrl = useMemo(() => {
    if (!file || !file.mime?.startsWith("application/pdf")) return null;
    try {
      const bytes = Uint8Array.from(atob(file.content), (c) => c.charCodeAt(0));
      const blob = new Blob([bytes], { type: file.mime });
      return URL.createObjectURL(blob);
    } catch {
      return null;
    }
  }, [file]);

  useEffect(() => {
    return () => {
      if (pdfUrl) URL.revokeObjectURL(pdfUrl);
    };
  }, [pdfUrl]);

  const office = file ? officeKind(file.mime) : null;
  const officeBuffer = useMemo(
    () => (office && office !== "legacy" && file ? base64ToBuffer(file.content) : null),
    [office, file],
  );

  const isUnsupportedDoc =
    file &&
    !file.previewable &&
    !office &&
    !file.mime?.startsWith("image/") &&
    !file.mime?.startsWith("application/pdf");

  const officeFallback = office === "legacy";

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
        {data && data.kind === "dir" && (
          <div className="preview-dir">
            <div className="preview-dir-path" title={data.path}>
              {data.path}
            </div>
            <ul className="preview-dir-list">
              {(data.entries ?? []).map((en) => (
                <li key={en.path}>
                  <button
                    type="button"
                    className="preview-dir-row"
                    onClick={() => setPreviewPath(en.path)}
                  >
                    <span className="preview-dir-icon" aria-hidden="true">
                      {en.type === "dir" ? "📁" : "📄"}
                    </span>
                    <span className="preview-dir-name">{en.name}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
        {file && file.mime?.startsWith("image/") && (
          <img src={`data:${file.mime};base64,${file.content}`} alt={path} />
        )}
        {file && file.mime?.startsWith("application/pdf") && (
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
            <DocxPreview data={officeBuffer} path={file!.path} />
          </Suspense>
        )}
        {office === "xlsx" && officeBuffer && (
          <Suspense fallback={<div className="preview-loading">加载中…</div>}>
            <XlsxPreview data={officeBuffer} path={file!.path} />
          </Suspense>
        )}
        {office === "pptx" && officeBuffer && (
          <Suspense fallback={<div className="preview-loading">加载中…</div>}>
            <PptxPreview data={officeBuffer} path={file!.path} />
          </Suspense>
        )}
        {officeFallback && (
          <div className="preview-unsupported">
            <p>旧版 Office 格式（.doc/.xls/.ppt）暂不支持内置预览。</p>
            <button
              type="button"
              className="btn-secondary"
              onClick={() => file && openFileInSystem(file.path)}
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
              onClick={() => file && openFileInSystem(file.path)}
            >
              在系统中打开
            </button>
          </div>
        )}
        {file && file.previewable && !office && !file.mime?.startsWith("image/") && !file.mime?.startsWith("application/pdf") && (
          <pre className="preview-text">{file.content}</pre>
        )}
      </div>
    </div>
  );
}
