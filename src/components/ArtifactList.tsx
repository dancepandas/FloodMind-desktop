import { useChatStore } from "../state/chat-store";

export default function ArtifactList() {
  const artifacts = useChatStore((s) => s.artifacts);
  if (artifacts.length === 0) return null;
  return (
    <section className="rail-section">
      <h3>产物</h3>
      <ul className="artifact-list">
        {artifacts.map((a, i) => (
          <li key={i} className="artifact-item">
            <span>{a.kind === "image" ? "🖼" : "📄"}</span>
            <span className="artifact-name">{a.name}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
