import { useEffect, useState } from "react";
import { getBaseUrl } from "../lib/sidecar-client";

interface Plugin {
  name: string;
  version: string;
  description: string;
  source: string;
  kind: "file" | "dir";
  disabled: boolean;
}

export default function PluginsView() {
  const [plugins, setPlugins] = useState<Plugin[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = async () => {
    setLoading(true);
    setError("");
    try {
      const base = await getBaseUrl();
      const r = await fetch(`${base}/api/plugins`);
      if (!r.ok) throw new Error(`status ${r.status}`);
      setPlugins((await r.json()).plugins ?? []);
    } catch (e) {
      setError(`加载插件失败：${(e as Error).message}`);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const toggle = async (p: Plugin) => {
    try {
      const base = await getBaseUrl();
      const r = await fetch(`${base}/api/plugins/disabled`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source: p.source, disabled: !p.disabled }),
      });
      if (r.ok) await load();
    } catch (e) {
      setError(`操作失败：${(e as Error).message}`);
    }
  };

  return (
    <div className="page">
      <div className="view-header">
        <h2>插件</h2>
        <span className="view-subtitle">Python 原生扩展，引擎启动时自动加载</span>
      </div>

      <div className="plugin-warning">
        ⚠️ 插件是<b>受信代码</b>——加载时会执行任意 Python。请只安装你信任来源的插件。
        启用/禁用会在下次发送任务时生效。
      </div>

      {error && <div className="blk blk-error">⚠️ {error}</div>}
      {loading && <div className="empty-hint">加载中…</div>}

      {!loading && plugins.length === 0 && (
        <div className="empty-hint">
          暂无插件。将插件放入 <code>~/.floodmind/plugins/</code>（单文件 .py 或含 plugin.json 的目录）即可被识别。
        </div>
      )}

      <div className="plugin-list">
        {plugins.map((p) => (
          <div className={`plugin-card ${p.disabled ? "disabled" : ""}`} key={p.source}>
            <div className="plugin-card-head">
              <span className="plugin-name">{p.name}</span>
              {p.version && <span className="cat-tag">v{p.version}</span>}
              <span className="plugin-kind">{p.kind === "dir" ? "目录插件" : "单文件"}</span>
              <span className={`plugin-state ${p.disabled ? "off" : "on"}`}>
                {p.disabled ? "已禁用" : "已启用"}
              </span>
            </div>
            {p.description && <div className="plugin-desc">{p.description}</div>}
            <div className="plugin-source" title={p.source}>{p.source}</div>
            <div className="plugin-actions">
              <button
                className={p.disabled ? "btn-primary" : "btn-secondary"}
                onClick={() => toggle(p)}
                type="button"
              >
                {p.disabled ? "启用" : "禁用"}
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
