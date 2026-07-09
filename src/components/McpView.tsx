import { useEffect, useState } from "react";
import PageHeader from "./PageHeader";
import { useCatalogStore } from "../state/catalog-store";

export default function McpView() {
  const servers = useCatalogStore((s) => s.mcpServers);
  const detail = useCatalogStore((s) => s.mcpDetail);
  const detailLoading = useCatalogStore((s) => s.mcpDetailLoading);
  const loadMcp = useCatalogStore((s) => s.loadMcp);
  const loadMcpServer = useCatalogStore((s) => s.loadMcpServer);
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    loadMcp();
  }, [loadMcp]);

  useEffect(() => {
    if (selected) loadMcpServer(selected);
  }, [selected, loadMcpServer]);

  return (
    <div className="page">
      <PageHeader title={`MCP 服务器（${servers.length}）`} />
      <div className="page-body master-detail">
        <ul className="cat-list">
          {servers.length === 0 && <li className="cat-empty">未配置 MCP 服务器</li>}
          {servers.map((s) => (
            <li key={s.name}>
              <button
                className={selected === s.name ? "cat-item active" : "cat-item"}
                onClick={() => setSelected(s.name)}
                type="button"
              >
                <span className="cat-name">
                  <span className={s.connected ? "sdot sdot-up" : "sdot sdot-down"} /> {s.name}
                </span>
                {s.transport && <span className="cat-tag">{s.transport}</span>}
                <span className="cat-desc">{s.tools ?? 0} 个工具</span>
              </button>
            </li>
          ))}
        </ul>
        <div className="cat-detail">
          {!selected && <div className="cat-empty">选择左侧服务器查看工具</div>}
          {selected && detail && (
            <>
              <div className="cat-detail-head">
                <h2>{detail.name}</h2>
                {detail.transport && <span className="cat-tag">{detail.transport}</span>}
                <span className={detail.connected ? "cat-tag ok" : "cat-tag"}>{detail.connected ? "已连接" : "未连接"}</span>
              </div>
              <div className="cat-tools">
                <div className="cat-subhead">工具（{(detail.tools || []).length}）</div>
                {(detail.tools || []).length === 0 ? (
                  <div className="cat-empty">无工具</div>
                ) : (
                  <div className="cat-tool-chips">
                    {(detail.tools || []).map((t) => (
                      <span className="cat-tool-chip" key={t}>
                        {t}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}
          {selected && detailLoading && <div className="cat-empty">加载中…</div>}
          {selected && !detailLoading && !detail && <div className="cat-empty">无法加载该服务器</div>}
        </div>
      </div>
    </div>
  );
}
