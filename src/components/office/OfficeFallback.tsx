import { openFileInSystem } from "../../lib/open-file";

/** Shared "couldn't render this office file" affordance. Used by every office
 *  renderer when the format is unsupported (legacy .doc/.xls/.ppt), the file is
 *  corrupt/password-protected, or its library fails to load. */
export default function OfficeFallback({ path }: { path: string }) {
  return (
    <div className="preview-unsupported">
      <p>无法直接预览此文件，可能格式不受支持或已损坏。</p>
      <button type="button" className="btn-secondary" onClick={() => openFileInSystem(path)}>
        在系统中打开
      </button>
    </div>
  );
}
