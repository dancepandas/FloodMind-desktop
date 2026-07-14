import { FileIcon, ImageIcon } from "./FileTreeIcons";

export interface ArtifactCardProps {
  name: string;
  artKind: "file" | "image";
  path: string;
  onOpen: () => void;
}

export default function ArtifactCard({
  name,
  artKind,
  path,
  onOpen,
}: ArtifactCardProps) {
  const size = "—"; // 后续可从 path 读取，本任务不实现
  return (
    <div
      className="artifact-card"
      onClick={onOpen}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
    >
      <span className="artifact-icon" aria-hidden="true">
        {artKind === "image" ? <ImageIcon size={20} /> : <FileIcon size={20} />}
      </span>
      <div className="artifact-meta">
        <span className="artifact-name" title={path}>
          {name}
        </span>
        <span className="artifact-size">{size}</span>
      </div>
      <span className="artifact-action" aria-hidden="true">
        ↗
      </span>
    </div>
  );
}
