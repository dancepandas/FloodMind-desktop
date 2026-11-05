import { FileIcon, ImageIcon } from "./FileTreeIcons";

export interface ArtifactCardProps {
  name: string;
  artKind: "file" | "image";
  path: string;
  exists?: boolean;
  size?: number;
  onOpen: () => void;
}

export function formatArtifactSize(size?: number): string {
  if (size === undefined) return "—";
  if (size < 1024) return `${size} B`;

  const units = ["KB", "MB", "GB", "TB"];
  let value = size / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${Number(value.toFixed(1))} ${units[unitIndex]}`;
}

function artifactTypeLabel(name: string, artKind: "file" | "image"): string {
  const baseName = name.split(/[\\/]/).pop() ?? name;
  const dotIndex = baseName.lastIndexOf(".");
  if (dotIndex > 0 && dotIndex < baseName.length - 1) {
    return baseName.slice(dotIndex + 1).toUpperCase();
  }
  return artKind === "image" ? "图片" : "文件";
}

export default function ArtifactCard({
  name,
  artKind,
  path,
  exists,
  size,
  onOpen,
}: ArtifactCardProps) {
  const missing = exists === false;
  return (
    <button
      className={`artifact-card${missing ? " artifact-card-missing" : ""}`}
      type="button"
      onClick={onOpen}
      disabled={missing}
      title={path}
    >
      <span className="artifact-icon" aria-hidden="true">
        {artKind === "image" ? <ImageIcon size={18} /> : <FileIcon size={18} />}
      </span>
      <span className="artifact-type" aria-hidden="true">
        {artifactTypeLabel(name, artKind)}
      </span>
      <span className="artifact-name">{name}</span>
      <span className="artifact-size">{formatArtifactSize(size)}</span>
      <span className={`artifact-action${missing ? " artifact-error" : ""}`}>
        {missing ? "文件不存在" : "预览"}
      </span>
    </button>
  );
}
