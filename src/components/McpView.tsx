import { useEffect, useState } from "react";
import PageHeader from "./PageHeader";
import { useCatalogStore, type McpServerForm } from "../state/catalog-store";
import McpEditModal from "./McpEditModal";

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
  };

  return (
    <div className="page">
      <PageHeader title={`MCP 服务器（${servers.length}）`}>
        <button
          className="btn-primary"
          onClick={() => { setEditing(null); setModalOpen(true); }}
          type="button"
          title="新建 MCP 服务器"
        >
          ＋ 新建
        </button>
      </PageHeader>
      <div className="page-body master-detail">
        <ul className="cat-list">
          {servers.length === 0 && <li className="cat-empty">未配置 MCP 服务器</li>}
          {servers.map((s) => (
            <li key={s.name}>
              <button
                className={selected === s.name ? "cat-item active" : "cat-item"}
                onClick={() => { setSelected(s.name); setTestResult(null); }}
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
                <span className={detail.connected ? "cat-tag ok" : "cat-tag"}>
                  {detail.connected ? "已连接" : "未连接"}
                </span>
              </div>
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
