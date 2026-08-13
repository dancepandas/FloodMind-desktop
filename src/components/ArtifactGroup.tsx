import { useState } from "react";
import type { ArtifactBlock } from "../state/chat-store";
import ArtifactCard from "./ArtifactCard";

export interface ArtifactGroupProps {
  artifacts: ArtifactBlock[];
  onOpen: (path: string) => void;
  onOpenFolder: (directory: string) => void;
}

export function artifactParentPath(path: string): string | null {
  const separatorIndex = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  if (separatorIndex < 0) return null;
  if (separatorIndex === 0) return path.slice(0, 1);
  if (separatorIndex === 2 && /^[A-Za-z]:[\\/]/.test(path)) return path.slice(0, 3);
  return path.slice(0, separatorIndex);
}

function artifactType(name: string): string {
  const baseName = name.split(/[\\/]/).pop() ?? name;
  const dotIndex = baseName.lastIndexOf(".");
  return dotIndex > 0 && dotIndex < baseName.length - 1
    ? baseName.slice(dotIndex + 1).toUpperCase()
    : "文件";
}

export function summarizeArtifactTypes(artifacts: ArtifactBlock[]): string {
  return [...new Set(artifacts.map((artifact) => artifactType(artifact.name)))].join("、");
}

export default function ArtifactGroup({ artifacts, onOpen, onOpenFolder }: ArtifactGroupProps) {
  const [expanded, setExpanded] = useState(false);
  const [showAll, setShowAll] = useState(false);

  if (artifacts.length === 0) return null;

  const unfiltered = artifacts.some((artifact) => artifact.source !== "declared");
  const directory = artifacts
    .map((artifact) => artifactParentPath(artifact.path))
    .find((parent): parent is string => parent !== null);
  const hiddenCount = Math.max(0, artifacts.length - 5);
  const visibleArtifacts = showAll ? artifacts : artifacts.slice(0, 5);

  function toggleExpanded() {
    setExpanded((current) => {
      if (current) setShowAll(false);
      return !current;
    });
  }

  return (
    <section className="artifact-group" aria-label="最终产物">
      <button
        type="button"
        className="artifact-group-summary"
        aria-expanded={expanded}
        onClick={toggleExpanded}
      >
        <span className="artifact-group-summary-main">
          <span className="artifact-group-caret" aria-hidden="true">
            {expanded ? "▾" : "▸"}
          </span>
          <span className="artifact-group-title">最终产物</span>
          <span className="artifact-group-count">{artifacts.length} 个</span>
          {unfiltered && <span className="artifact-group-warning">未筛选</span>}
        </span>
        <span className="artifact-group-types">{summarizeArtifactTypes(artifacts)}</span>
      </button>

      {expanded && (
        <div className="artifact-group-content" role="group" aria-label="最终产物清单">
          <div className="artifact-list">
            {visibleArtifacts.map((artifact) => (
              <ArtifactCard
                key={artifact.id}
                name={artifact.name}
                artKind={artifact.artKind}
                path={artifact.path}
                exists={artifact.exists}
                size={artifact.size}
                onOpen={() => onOpen(artifact.path)}
              />
            ))}
          </div>
          {(hiddenCount > 0 || directory) && (
            <div className="artifact-group-actions">
              {hiddenCount > 0 && (
                <button
                  type="button"
                  className="artifact-group-action"
                  onClick={() => setShowAll((current) => !current)}
                >
                  {showAll ? "收起其余" : `显示其余 ${hiddenCount} 个`}
                </button>
              )}
              {directory && (
                <button
                  type="button"
                  className="artifact-group-action artifact-folder-action"
                  onClick={() => onOpenFolder(directory)}
                >
                  打开所在文件夹
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
