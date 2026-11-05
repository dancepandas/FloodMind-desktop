import { useEffect, useMemo, useState } from "react";
import { getBaseUrl } from "../lib/sidecar-client";
import PageHeader from "./PageHeader";
import "../styles/catalog.css";

interface ExperienceLeaf {
  node_id: string;
  path: string[];
  task_description: string;
  skill_used: string;
  domain_keywords: string[];
  pitfalls: string[];
  solutions: string[];
  final_outcome: string;
  importance: number;
  hit_count: number;
  success_count: number;
  failure_count: number;
  updated_at: string;
}

interface ExperienceData {
  stats: Record<string, number>;
  summaries: { path: string[]; text: string }[];
  leaves: ExperienceLeaf[];
}

function groupByDomain(leaves: ExperienceLeaf[]): Map<string, ExperienceLeaf[]> {
  const map = new Map<string, ExperienceLeaf[]>();
  for (const leaf of leaves) {
    const domain = leaf.path[0] ?? "未分类";
    const arr = map.get(domain) ?? [];
    arr.push(leaf);
    map.set(domain, arr);
  }
  return map;
}

export default function ExperienceView() {
  const [data, setData] = useState<ExperienceData>({ stats: {}, summaries: [], leaves: [] });
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ExperienceLeaf[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = async () => {
    setLoading(true);
    setError("");
    try {
      const base = await getBaseUrl();
      const r = await fetch(`${base}/api/experience`);
      if (!r.ok) throw new Error(`status ${r.status}`);
      setData(await r.json());
    } catch (e) {
      setError(`加载经验库失败：${(e as Error).message}`);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const doSearch = async () => {
    if (!query.trim()) {
      setResults(null);
      return;
    }
    try {
      const base = await getBaseUrl();
      const r = await fetch(`${base}/api/experience/search?q=${encodeURIComponent(query)}`);
      if (!r.ok) throw new Error(`status ${r.status}`);
      setResults((await r.json()).results);
    } catch (e) {
      setError(`搜索失败：${(e as Error).message}`);
    }
  };

  const feedback = async (nodeId: string, helpful: boolean) => {
    try {
      const base = await getBaseUrl();
      await fetch(`${base}/api/experience/feedback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ node_id: nodeId, helpful }),
      });
      await load(); // refresh importance / counts
    } catch (e) {
      setError(`反馈失败：${(e as Error).message}`);
    }
  };

  const maintain = async () => {
    try {
      const base = await getBaseUrl();
      await fetch(`${base}/api/experience/maintain`, { method: "POST" });
      await load();
    } catch (e) {
      setError(`维护失败：${(e as Error).message}`);
    }
  };

  const shown = useMemo(() => results ?? data.leaves, [results, data.leaves]);
  const grouped = useMemo(() => groupByDomain(shown), [shown]);
  const leafCount = data.stats.leaf_cases ?? data.leaves.length;

  return (
    <div className="experience-view catalog-page" role="region" aria-label="经验库" tabIndex={0}>
      <PageHeader variant="hero" title="经验库" />
      <p className="page-hero-note">
        {leafCount} 条经验 · 引擎自动从完成的任务中沉淀，帮助后续任务复用踩坑与解法
      </p>

      <div className="experience-toolbar">
        <input
          className="experience-search"
          type="search"
          aria-label="搜索经验"
          placeholder="搜索经验（关键词 / 领域 / 坑点）…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && doSearch()}
        />
        <button className="btn-secondary" onClick={doSearch} type="button">搜索</button>
        <button className="btn-secondary" onClick={() => { setQuery(""); setResults(null); }} type="button">重置</button>
        <button className="btn-secondary" onClick={maintain} type="button" title="去重/合并/归档">维护</button>
      </div>

      {error && <div className="blk blk-error">⚠️ {error}</div>}
      {loading && <div className="empty-hint">加载中…</div>}

      {!loading && shown.length === 0 && (
        <div className="empty-hint">
          暂无经验。多跑几个任务后，引擎会自动沉淀可复用的经验。
        </div>
      )}

      {Array.from(grouped.entries()).map(([domain, leaves]) => (
        <section className="experience-group" key={domain}>
          <h3 className="experience-domain">{domain}</h3>
          <div className="catalog-grid experience-grid">
            {leaves.map((leaf) => (
              <article className="experience-card" key={leaf.node_id}>
                <div className="experience-card-head">
                  <span className={`experience-outcome ${leaf.final_outcome === "success" ? "ok" : "bad"}`}>
                    {leaf.final_outcome === "success" ? "成功" : "失败"}
                  </span>
                  <span className="experience-title">{leaf.task_description || leaf.path.slice(1).join(" / ")}</span>
                  {leaf.skill_used && <span className="experience-skill">{leaf.skill_used}</span>}
                </div>
                {leaf.pitfalls.length > 0 && (
                  <div className="experience-section">
                    <span className="experience-label">坑点</span>
                    <ul>{leaf.pitfalls.slice(0, 3).map((p, i) => <li key={i}>{p}</li>)}</ul>
                  </div>
                )}
                {leaf.solutions.length > 0 && (
                  <div className="experience-section">
                    <span className="experience-label">解法</span>
                    <ul>{leaf.solutions.slice(0, 3).map((s, i) => <li key={i}>{s}</li>)}</ul>
                  </div>
                )}
                <div className="experience-meta">
                  <span title="重要性">重要度 {(leaf.importance * 100).toFixed(0)}%</span>
                  <span title="被引用次数">引用 {leaf.hit_count}</span>
                  <span title="有用/无用反馈">👍 {leaf.success_count} · 👎 {leaf.failure_count}</span>
                  <span className="experience-actions">
                    <button className="btn-mini" onClick={() => feedback(leaf.node_id, true)} type="button">有帮助</button>
                    <button className="btn-mini" onClick={() => feedback(leaf.node_id, false)} type="button">无帮助</button>
                  </span>
                </div>
              </article>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
