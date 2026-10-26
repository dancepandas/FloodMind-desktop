import { useEffect, useState } from "react";
import PageHeader from "./PageHeader";
import { useCatalogStore, type McpServerForm } from "../state/catalog-store";
import McpEditModal from "./McpEditModal";
import "../styles/catalog.css";

export default function McpView() {
  const servers = useCatalogStore((s) => s.mcpServers);
  const detail = useCatalogStore((s) => s.mcpDetail);
  const detailLoading = useCatalogStore((s) => s.mcpDetailLoading);
  const mcpSaving = useCatalogStore((s) => s.mcpSaving);
  const mcpError = useCatalogStore((s) => s.mcpError);
  const mcpTesting = useCatalogStore((s) => s.mcpTesting);
  const loadMcp = useCatalogStore((s) => s.loadMcp);
  const loadMcpServer = useCatalogStore((s) => s.loadMcpServer);
  const createMcpServer = useCatalogStore((s) => s.createMcpServer);
  const updateMcpServer = useCatalogStore((s) => s.updateMcpServer);
  const deleteMcpServer = useCatalogStore((s) => s.deleteMcpServer);
  const testMcpServer = useCatalogStore((s) => s.testMcpServer);

  const [selected, setSelected] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<McpServerForm | null>(null);
  const [testResult, setTestResult] = useState<{ ok: boolean; error?: string } | null>(null);

  useEffect(() => {
    loadMcp();
  }, [loadMcp]);

  useEffect(() => {
    if (selected) loadMcpServer(selected);
  }, [selected, loadMcpServer]);

  const handleEdit = () => {
    if (!detail) return;
    setEditing({
      name: detail.name,
      transport: (detail.transport as "stdio" | "sse") || "stdio",
      command: (detail as any).command || "",
      args: (detail as any).args || [],
      env: (detail as any).env || {},
      url: (detail as any).url || "",
    });
    setModalOpen(true);
  };

  const handleSave = async (form: McpServerForm) => {
    try {
      if (editing) {
        await updateMcpServer(form.name!, form);
      } else {
        await createMcpServer(form);
      }
      setModalOpen(false);
      setEditing(null);
    } catch {
      /* error in store */
    }
  };

  const handleDelete = async (name: string) => {
    if (!window.confirm(`确定删除 MCP 服务器 "${name}" 吗？`)) return;
    try {
      await deleteMcpServer(name);
      if (selected === name) setSelected(null);
    } catch {
      /* error in store */
    }
  };

  const handleTest = async () => {
    if (!selected) return;
    const r = await testMcpServer(selected);
    setTestResult(r);
    if (r.ok) {
      // A successful test leaves the server connected in the pool — refresh so
      // the status dot/detail reflect the new state.
      await loadMcp();
      await loadMcpServer(selected);
    }
  };

  return (
    <div className="page catalog-page" role="region" aria-label="MCP 服务器" tabIndex={0}>
      <PageHeader variant="hero" title={`MCP 服务器（${servers.length}）`}>
        <button
          className="btn-primary"
          onClick={() => { setEditing(null); setModalOpen(true); }}
          type="button"
          title="新建 MCP 服务器"
        >
          ＋ 新建
        </button>
      </PageHeader>
      <div className="page-body catalog-body">
        <ul className="cat-list catalog-grid" aria-label="MCP 服务器列表">
          {servers.length === 0 && <li className="cat-empty">未配置 MCP 服务器</li>}
          {servers.map((s) => {
            const dotClass = s.health_ok === false
              ? "sdot sdot-warn"
              : s.connected
                ? "sdot sdot-up"
                : "sdot sdot-down";
            const title = s.health_ok === false
              ? `最近调用失败：${s.health_error ?? "未知错误"}`
              : s.connected
                ? "已连接"
                : "未连接";
            return (
              <li key={s.name}>
                <button
                  className={selected === s.name ? "cat-item active" : "cat-item"}
                  onClick={() => { setSelected(s.name); setTestResult(null); }}
                  type="button"
                  aria-pressed={selected === s.name}
                  aria-controls="mcp-detail"
                >
                  <span className="cat-name" title={title}>
                    <span className={dotClass} /> {s.name}
                  </span>
                  {s.transport && <span className="cat-tag">{s.transport}</span>}
                  <span className="cat-desc">{s.tools ?? 0} 个工具 · {s.health_ok === false ? "调用异常" : s.connected ? "已连接" : "未连接"}</span>
                </button>
              </li>
            );
          })}
        </ul>
        <div className="cat-detail" id="mcp-detail" role="region" aria-label="服务器详情" aria-busy={detailLoading}>
          {!selected && <div className="cat-empty">选择一个服务器查看工具</div>}
          {selected && detail?.name === selected && !detailLoading && (
            <>
              <div className="cat-detail-head">
                <h2>{detail.name}</h2>
                {detail.transport && <span className="cat-tag">{detail.transport}</span>}
                {detail.health_ok === false ? (
                  <span className="cat-tag warn" title={detail.health_error ?? ""}>调用异常</span>
                ) : (
                  <span className={detail.connected ? "cat-tag ok" : "cat-tag"}>
                    {detail.connected ? "已连接" : "未连接"}
                  </span>
                )}
              </div>
              {detail.health_ok === false && detail.health_error && (
                <div className="env-warn" style={{ margin: "0.5rem 0" }}>
                  最近一次工具调用失败：{detail.health_error}（连接正常，但服务实际不可用）
                </div>
              )}
              <div className="cat-tools">
                <div className="cat-subhead">工具（{(detail.tools || []).length}）</div>
                {(detail.tools || []).length === 0 ? (
                  <div className="cat-empty">无工具</div>
                ) : (
                  <div className="cat-tool-chips">
                    {(detail.tools || []).map((t) => (
                      <span className="cat-tool-chip" key={t}>{t}</span>
                    ))}
                  </div>
                )}
              </div>
              <div className="task-detail-actions" style={{ marginTop: "1rem" }}>
                <button className="btn-secondary" onClick={handleEdit} type="button" disabled={mcpSaving}>编辑</button>
                <button className="btn-secondary" onClick={() => handleDelete(detail.name)} type="button" disabled={mcpSaving}>删除</button>
                <button className="btn-primary" onClick={handleTest} type="button" disabled={mcpTesting}>
                  {mcpTesting ? "测试中…" : "测试连接"}
                </button>
              </div>
              {testResult && (
                <div className={testResult.ok ? "save-ok" : "modal-error"} style={{ marginTop: "0.5rem" }}>
                  {testResult.ok ? "连接成功" : `连接失败：${testResult.error}`}
                </div>
              )}
            </>
          )}
          {selected && detailLoading && <div className="cat-empty">加载中…</div>}
          {selected && !detailLoading && !detail && <div className="cat-empty">无法加载该服务器</div>}
        </div>
      </div>
      <McpEditModal
        open={modalOpen}
        editing={editing}
        onClose={() => setModalOpen(false)}
        onSave={handleSave}
        saving={mcpSaving}
        error={mcpError}
      />
    </div>
  );
}
