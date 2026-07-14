# FloodMind Desktop — WorkBuddy 风格 UI 优化

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 参考 WorkBuddy 的截图，把 FloodMind 桌面端的对话界面、产物展示、设置页和侧边导航打磨成更现代、信息更丰富的形态。

**Architecture:** 保持现有 React + Zustand + Tauri + Python sidecar 架构不变，所有改动都是前端展示层或单个 sidecar 只读接口的增量修改。每个任务独立可交付、可测试，互不阻塞。

**Tech Stack:** React 19, TypeScript, Vite, Zustand, Tauri 2.x, Python Flask sidecar。

## Global Constraints

- 不引入新的运行时依赖。
- 保留现有 CSS 变量与配色体系（`--accent`, `--bg`, `--surface`, `--border` 等）。
- 所有用户可见文案为中文。
- 不破坏现有 sidecar REST API 契约。
- 新增代码必须附带对应测试；原有测试必须继续通过。
- 每次任务提交前运行 `npm test`、`python -m pytest sidecar/tests`、`npm run build`。
- 产物预览仅支持本地工作区已存在的文件，不新增文件上传/保存能力。

---

## File Structure

- `src/components/ArtifactCard.tsx` — 产物文件卡片（图标、文件名、大小、打开按钮）。
- `src/components/PreviewPanel.tsx` — 右侧文件预览面板（文本/图片/PDF 占位）。
- `src/components/WelcomeView.tsx` — 空会话欢迎页（标题、场景 chips、快捷动作）。
- `src/components/SettingsNav.tsx` — 设置页左侧分类导航。
- `src/components/ComposerFilePicker.tsx` — Composer 内联 @ 文件选择下拉。
- `src/components/BlockView.tsx` — 扩展 artifact block 渲染为卡片。
- `src/components/Conversation.tsx` — 空会话时渲染 WelcomeView。
- `src/components/Composer.tsx` — 接入内联 @ 选择器。
- `src/components/SettingsView.tsx` — 改为左侧导航 + 右侧内容区的布局。
- `src/components/Sidebar.tsx` — 重新分组导航项。
- `src/components/TopBar.tsx` — 可选显示当前执行动作/预估消耗。
- `src/state/ui-store.ts` — 新增 `previewPath`、`setPreviewPath`、`closePreview`。
- `src/app.css` — 新增卡片、预览面板、欢迎页、设置导航样式。
- `sidecar/floodmind_desktop_sidecar/app.py` — 新增 `GET /api/workspace/file` 读取文件内容。
- `sidecar/tests/test_app.py` — 测试文件读取接口。

---

### Task 1: 产物卡片 + 右侧预览面板

**Files:**
- Create: `src/components/ArtifactCard.tsx`
- Create: `src/components/PreviewPanel.tsx`
- Create: `src/lib/preview.ts`
- Modify: `src/components/BlockView.tsx`
- Modify: `src/App.tsx`
- Modify: `src/state/ui-store.ts`
- Modify: `src/app.css`
- Modify: `sidecar/floodmind_desktop_sidecar/app.py`
- Test: `src/components/ArtifactCard.test.tsx`
- Test: `sidecar/tests/test_app.py`

**Interfaces:**
- Consumes: `Block` 中 `kind === "artifact"` 的 `{ artKind, name, path }`。
- Consumes: sidecar `GET /api/workspace/file?path=<relative>` 返回 `{ content: string, mime: string }`。
- Produces: `ArtifactCard` 组件 `{ name, artKind, path, onOpen }`。
- Produces: `PreviewPanel` 组件 `{ path, onClose }`。
- Produces: `useUiStore` 状态 `{ previewPath: string | null, setPreviewPath(p: string | null), closePreview() }`。

- [ ] **Step 1: 给 sidecar 增加文件读取接口并写失败测试**

在 `sidecar/floodmind_desktop_sidecar/app.py` 添加：

```python
from pathlib import Path

@app.route("/api/workspace/file", methods=["GET"])
def read_workspace_file():
    workspace = _require_workspace()
    rel = request.args.get("path", "").lstrip("/\\")
    if not rel:
        return jsonify({"error": "path required"}), 400
    target = Path(workspace) / rel
    target = target.resolve()
    root = Path(workspace).resolve()
    # 防止越界
    if root not in target.parents and target != root:
        return jsonify({"error": "forbidden"}), 403
    if not target.exists():
        return jsonify({"error": "not found"}), 404
    mime = "text/plain"
    if target.suffix.lower() in {".png", ".jpg", ".jpeg", ".gif", ".webp"}:
        mime = f"image/{target.suffix.lstrip('.').lower()}"
        content = base64.b64encode(target.read_bytes()).decode()
    else:
        content = target.read_text(encoding="utf-8", errors="replace")
    return jsonify({"content": content, "mime": mime})
```

测试 `sidecar/tests/test_app.py`：

```python
def test_read_workspace_file(client, tmp_path, monkeypatch):
    monkeypatch.setenv("FLOODMIND_DESKTOP_WORKSPACE", str(tmp_path))
    (tmp_path / "hello.txt").write_text("world", encoding="utf-8")
    r = client.get("/api/workspace/file?path=hello.txt")
    assert r.status_code == 200
    assert r.get_json()["content"] == "world"

def test_read_workspace_file_forbidden(client, tmp_path, monkeypatch):
    monkeypatch.setenv("FLOODMIND_DESKTOP_WORKSPACE", str(tmp_path))
    r = client.get("/api/workspace/file?path=../etc/passwd")
    assert r.status_code == 403
```

运行 `python -m pytest sidecar/tests/test_app.py::test_read_workspace_file -v`，预期失败（函数未定义或路由未注册）。

- [ ] **Step 2: 实现 sidecar 接口并通过测试**

把 Step 1 的代码加进 `app.py`，确认测试通过。

- [ ] **Step 3: 写 `src/lib/preview.ts` 失败测试并实现**

```ts
// src/lib/preview.ts
import { getBaseUrl } from "./sidecar-client";

export async function fetchFilePreview(relPath: string): Promise<{ content: string; mime: string }> {
  const base = await getBaseUrl();
  const r = await fetch(`${base}/api/workspace/file?path=${encodeURIComponent(relPath)}`);
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}
```

测试 `src/lib/preview.test.ts`：

```ts
import { fetchFilePreview } from "./preview";
import * as client from "./sidecar-client";
import { vi } from "vitest";

test("fetchFilePreview returns content and mime", async () => {
  vi.spyOn(client, "getBaseUrl").mockResolvedValue("http://localhost");
  global.fetch = vi.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve({ content: "hello", mime: "text/plain" }),
  });
  const out = await fetchFilePreview("a.txt");
  expect(out).toEqual({ content: "hello", mime: "text/plain" });
});
```

- [ ] **Step 4: 写 `ArtifactCard` 失败测试并实现**

```tsx
// src/components/ArtifactCard.tsx
import { FileIcon, ImageIcon } from "./FileTreeIcons"; // 已有图标

export interface ArtifactCardProps {
  name: string;
  artKind: "file" | "image";
  path: string;
  onOpen: () => void;
}

export default function ArtifactCard({ name, artKind, path, onOpen }: ArtifactCardProps) {
  const size = "—"; // 后续可从 path 读取，本任务不实现
  return (
    <div className="artifact-card" onClick={onOpen} role="button" tabIndex={0}>
      <span className="artifact-icon" aria-hidden="true">
        {artKind === "image" ? <ImageIcon size={20} /> : <FileIcon size={20} />}
      </span>
      <div className="artifact-meta">
        <span className="artifact-name" title={path}>{name}</span>
        <span className="artifact-size">{size}</span>
      </div>
      <span className="artifact-action" aria-hidden="true">↗</span>
    </div>
  );
}
```

测试 `src/components/ArtifactCard.test.tsx`：

```tsx
import { render, screen, fireEvent } from "@testing-library/react";
import ArtifactCard from "./ArtifactCard";

test("renders file card and calls onOpen", () => {
  const onOpen = vi.fn();
  render(<ArtifactCard name="report.xlsx" artKind="file" path="/report.xlsx" onOpen={onOpen} />);
  fireEvent.click(screen.getByRole("button"));
  expect(onOpen).toHaveBeenCalled();
});
```

- [ ] **Step 5: 写 `PreviewPanel` 失败测试并实现**

```tsx
// src/components/PreviewPanel.tsx
import { useEffect, useState } from "react";
import { fetchFilePreview } from "../lib/preview";

export interface PreviewPanelProps {
  path: string;
  onClose: () => void;
}

export default function PreviewPanel({ path, onClose }: PreviewPanelProps) {
  const [data, setData] = useState<{ content: string; mime: string } | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    fetchFilePreview(path)
      .then(setData)
      .catch((e) => setError(e.message));
  }, [path]);

  return (
    <div className="preview-panel">
      <div className="preview-panel-header">
        <span className="preview-title" title={path}>{path.split("/").pop()}</span>
        <button className="preview-close" onClick={onClose} type="button">✕</button>
      </div>
      <div className="preview-body">
        {error && <div className="preview-error">{error}</div>}
        {!data && !error && <div className="preview-loading">加载中…</div>}
        {data && data.mime.startsWith("image/") && (
          <img src={`data:${data.mime};base64,${data.content}`} alt={path} />
        )}
        {data && !data.mime.startsWith("image/") && (
          <pre className="preview-text">{data.content}</pre>
        )}
      </div>
    </div>
  );
}
```

测试 `src/components/PreviewPanel.test.tsx` 使用 MSW 或 mock `fetchFilePreview`。

- [ ] **Step 6: 扩展 `useUiStore` 管理预览路径**

在 `src/state/ui-store.ts` 添加：

```ts
interface UiState {
  // ...existing fields
  previewPath: string | null;
  setPreviewPath: (p: string | null) => void;
  closePreview: () => void;
}

export const useUiStore = create<UiState>((set) => ({
  // ...existing
  previewPath: null,
  setPreviewPath: (p) => set({ previewPath: p }),
  closePreview: () => set({ previewPath: null }),
}));
```

- [ ] **Step 7: 修改 `BlockView.tsx` 用 `ArtifactCard` 替代 inline chip**

把 `ArtifactBlock` 改为：

```tsx
import ArtifactCard from "./ArtifactCard";
import { useUiStore } from "../state/ui-store";

function ArtifactBlock({ block }: { block: Extract<Block, { kind: "artifact" }> }) {
  const setPreviewPath = useUiStore((s) => s.setPreviewPath);
  return (
    <ArtifactCard
      name={block.name}
      artKind={block.artKind}
      path={block.path}
      onOpen={() => setPreviewPath(block.path)}
    />
  );
}
```

- [ ] **Step 8: 修改 `App.tsx` 在右侧渲染 `PreviewPanel`**

在 `chat-stage` 里与 `PlanPanel` 并列：

```tsx
import PreviewPanel from "./components/PreviewPanel";
import { useUiStore } from "./state/ui-store";

// inside chat-stage
const previewPath = useUiStore((s) => s.previewPath);
const closePreview = useUiStore((s) => s.closePreview);

<div className="chat-stage">
  <Conversation />
  <PlanPanel />
  {previewPath && <PreviewPanel path={previewPath} onClose={closePreview} />}
</div>
```

- [ ] **Step 9: 添加 CSS**

在 `src/app.css` 追加：

```css
.artifact-card {
  display: inline-flex;
  align-items: center;
  gap: 0.55rem;
  padding: 0.45rem 0.7rem;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 8px;
  cursor: pointer;
  transition: border-color 0.1s, box-shadow 0.1s;
}
.artifact-card:hover {
  border-color: var(--accent);
  box-shadow: 0 2px 8px rgba(13, 148, 136, 0.08);
}
.artifact-meta {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.artifact-name {
  font-size: 13px;
  color: var(--fg);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.artifact-size {
  font-size: 11px;
  color: var(--muted);
}
.preview-panel {
  width: 360px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  border-left: 1px solid var(--border);
  background: var(--surface);
}
.preview-panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.7rem 0.9rem;
  border-bottom: 1px solid var(--border-soft);
}
.preview-title {
  font-size: 13px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.preview-body {
  flex: 1;
  overflow: auto;
  padding: 1rem;
}
.preview-text {
  margin: 0;
  font-family: var(--font-mono);
  font-size: 12px;
  white-space: pre-wrap;
  word-break: break-word;
}
.preview-body img {
  max-width: 100%;
  border-radius: 6px;
}
```

- [ ] **Step 10: 运行测试并提交**

```bash
npm test -- ArtifactCard PreviewPanel preview
python -m pytest sidecar/tests/test_app.py
npm run build
```

全部通过后提交：

```bash
git add src/ sidecar/
git commit -m "feat(ui): artifact cards with right-side preview panel"
```

---

### Task 2: 欢迎页（场景 chips + 快捷动作）

**Files:**
- Create: `src/components/WelcomeView.tsx`
- Modify: `src/components/Conversation.tsx`
- Modify: `src/app.css`
- Test: `src/components/WelcomeView.test.tsx`

**Interfaces:**
- Consumes: `useChatStore.send`。
- Produces: `WelcomeView` 组件 `{ onSend: (text: string) => void }`。

- [ ] **Step 1: 写 `WelcomeView` 失败测试**

```tsx
// src/components/WelcomeView.test.tsx
import { render, screen, fireEvent } from "@testing-library/react";
import WelcomeView from "./WelcomeView";

test("renders title and quick actions", () => {
  const onSend = vi.fn();
  render(<WelcomeView onSend={onSend} />);
  expect(screen.getByText(/开始工作/)).toBeInTheDocument();
  fireEvent.click(screen.getByText("生成 PPT"));
  expect(onSend).toHaveBeenCalledWith(expect.stringContaining("PPT"));
});
```

- [ ] **Step 2: 实现 `WelcomeView`**

```tsx
// src/components/WelcomeView.tsx
import Logo from "./Logo";

const SCENARIOS = [
  { label: "文档处理", prompt: "帮我整理一份文档" },
  { label: "数据分析", prompt: "分析当前工作区里的数据文件" },
  { label: "生成 PPT", prompt: "根据工作区内容生成一份 PPT" },
  { label: "写代码", prompt: "帮我写一段代码" },
];

export default function WelcomeView({ onSend }: { onSend: (text: string) => void }) {
  return (
    <div className="welcome-view">
      <Logo className="welcome-logo" />
      <h1 className="welcome-title">FloodMind</h1>
      <p className="welcome-sub">你的智能工作助手，直接读写工作区文件完成任务</p>
      <div className="welcome-scenarios">
        {["日常办公", "代码开发", "设计创意"].map((s) => (
          <span key={s} className="welcome-chip">{s}</span>
        ))}
      </div>
      <div className="welcome-actions">
        {SCENARIOS.map((a) => (
          <button key={a.label} className="welcome-action" onClick={() => onSend(a.prompt)} type="button">
            {a.label}
          </button>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: 修改 `Conversation.tsx` 空会话分支**

```tsx
import WelcomeView from "./WelcomeView";
import { useChatStore } from "../state/chat-store";

// inside Conversation
const send = useChatStore((s) => s.send);

if (turns.length === 0) {
  return (
    <div className="conversation">
      <WelcomeView onSend={send} />
    </div>
  );
}
```

- [ ] **Step 4: 添加 CSS**

```css
.welcome-view {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  text-align: center;
  padding: 2rem;
}
.welcome-logo {
  width: 56px;
  height: 56px;
  color: var(--accent);
  margin-bottom: 1rem;
}
.welcome-title {
  font-size: 1.8rem;
  font-weight: 700;
  margin: 0 0 0.4rem;
}
.welcome-sub {
  color: var(--muted);
  margin: 0 0 1.2rem;
}
.welcome-scenarios {
  display: flex;
  gap: 0.5rem;
  margin-bottom: 1.5rem;
}
.welcome-chip {
  padding: 0.25rem 0.7rem;
  border: 1px solid var(--border);
  border-radius: 999px;
  font-size: 12px;
  color: var(--fg-secondary);
}
.welcome-actions {
  display: grid;
  grid-template-columns: repeat(2, minmax(120px, 160px));
  gap: 0.6rem;
}
.welcome-action {
  padding: 0.7rem 1rem;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--surface);
  color: var(--fg);
  font-size: 13px;
  cursor: pointer;
  transition: border-color 0.1s, transform 0.1s;
}
.welcome-action:hover {
  border-color: var(--accent);
}
```

- [ ] **Step 5: 测试并提交**

```bash
npm test -- WelcomeView
npm run build
```

通过后提交：

```bash
git add src/
git commit -m "feat(ui): WorkBuddy-style welcome screen with scenario chips"
```

---

### Task 3: 设置页左侧导航布局

**Files:**
- Create: `src/components/SettingsNav.tsx`
- Modify: `src/components/SettingsView.tsx`
- Modify: `src/app.css`
- Test: `src/components/SettingsView.test.tsx`

**Interfaces:**
- Produces: `SettingsNav` 组件 `{ active: Tab, onChange: (tab: Tab) => void }`。
- Produces: `SettingsView` 改为左右分栏布局。

- [ ] **Step 1: 写 `SettingsView` 失败测试**

```tsx
// src/components/SettingsView.test.tsx
import { render, screen, fireEvent } from "@testing-library/react";
import SettingsView from "./SettingsView";

vi.mock("../state/config-store", () => ({
  useConfigStore: (selector: any) =>
    selector({
      model: null,
      loading: false,
      error: "",
      providers: [],
      apiKeyPresent: false,
      baseURL: "",
      envOverrides: [],
      personaLoading: false,
      soul: "",
      agents: "",
    }),
}));

test("switches tabs via left navigation", () => {
  render(<SettingsView />);
  fireEvent.click(screen.getByRole("tab", { name: /身份/ }));
  expect(screen.getByText(/SOUL.md/)).toBeInTheDocument();
});
```

- [ ] **Step 2: 实现 `SettingsNav`**

```tsx
// src/components/SettingsNav.tsx
export type Tab = "model" | "identity" | "rules";

const ITEMS: { tab: Tab; label: string }[] = [
  { tab: "model", label: "模型" },
  { tab: "identity", label: "身份" },
  { tab: "rules", label: "规则" },
];

export default function SettingsNav({ active, onChange }: { active: Tab; onChange: (t: Tab) => void }) {
  return (
    <nav className="settings-nav" role="tablist" aria-label="设置分类">
      {ITEMS.map((i) => (
        <button
          key={i.tab}
          role="tab"
          className={active === i.tab ? "settings-nav-item active" : "settings-nav-item"}
          onClick={() => onChange(i.tab)}
          type="button"
        >
          {i.label}
        </button>
      ))}
    </nav>
  );
}
```

- [ ] **Step 3: 修改 `SettingsView.tsx` 为左右分栏**

把原来的 `settings-tabs` 替换为 `SettingsNav`，外层用 `settings-layout`：

```tsx
import SettingsNav, { type Tab } from "./SettingsNav";

// in SettingsView return
<div className="page">
  <PageHeader title="设置" />
  <div className="page-body settings-layout">
    <SettingsNav active={tab} onChange={setTab} />
    <div className="settings-content">
      {tab === "model" && <ModelTab />}
      {tab === "identity" && <IdentityTab />}
      {tab === "rules" && <RulesTab />}
    </div>
  </div>
</div>
```

- [ ] **Step 4: 添加 CSS**

```css
.settings-layout {
  display: flex;
  gap: 1.5rem;
  max-width: 900px;
  margin: 0 auto;
  padding-top: 1rem;
}
.settings-nav {
  width: 180px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
}
.settings-nav-item {
  text-align: left;
  padding: 0.5rem 0.75rem;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--fg-secondary);
  font-size: 14px;
  cursor: pointer;
}
.settings-nav-item:hover {
  background: var(--surface-2);
}
.settings-nav-item.active {
  background: var(--surface);
  color: var(--fg);
  font-weight: 600;
  box-shadow: 0 1px 2px rgba(0,0,0,0.04);
}
.settings-content {
  flex: 1;
  min-width: 0;
}
```

- [ ] **Step 5: 测试并提交**

```bash
npm test -- SettingsView
npm run build
```

通过后提交：

```bash
git add src/
git commit -m "feat(ui): left-navigation layout for settings"
```

---

### Task 4: 对话过程显示当前动作

**Files:**
- Modify: `src/components/TopBar.tsx`
- Modify: `src/components/Conversation.tsx`
- Modify: `src/state/chat-store.ts`
- Modify: `src/app.css`

**Interfaces:**
- Consumes: `Block` 中的 `thinking`, `tool`, `text` 块。
- Produces: `TopBar` 显示更细化的状态文字（如"正在读取文件…"）。

说明：不增加预估 token 消耗，继续保留现有按 turn 统计的 usage pill；本任务仅把"正在思考/正在执行/正在回答"的泛化状态细化成具体动作。

- [ ] **Step 1: 在 `chat-store.ts` 增加当前动作推导**

新增纯函数：

```ts
export function deriveStatusText(lastBlock?: Block): string {
  if (!lastBlock) return "等待响应…";
  if (lastBlock.kind === "thinking") return "正在思考…";
  if (lastBlock.kind === "tool") return `正在执行：${lastBlock.tool_name}…`;
  if (lastBlock.kind === "text" && !lastBlock.final) return "正在回答…";
  return "";
}
```

- [ ] **Step 2: 写失败测试**

```ts
// src/state/chat-store.test.ts
import { deriveStatusText } from "./chat-store";

test("deriveStatusText reflects current block", () => {
  expect(deriveStatusText({ kind: "tool", tool_name: "read_file", status: "running" } as any)).toBe("正在执行：read_file…");
});
```

- [ ] **Step 3: 修改 `Conversation.tsx` 与 `TopBar.tsx` 显示细化状态**

在 `Conversation.tsx` 的 `TurnView` 中，把状态文字从硬编码改为 `deriveStatusText(live)`。

在 `TopBar.tsx` 中增加一个全局状态 pill：

```tsx
const streaming = useChatStore((s) => s.streaming);
const turns = useChatStore((s) => s.turns);
const lastAssistant = turns.findLast((t) => t.role === "assistant");
const liveBlock = lastAssistant?.blocks.at(-1);
const statusText = streaming ? deriveStatusText(liveBlock) : "";

// in topbar-actions
{statusText && <span className="topbar-status-pill">{statusText}</span>}
```

- [ ] **Step 4: 添加 CSS**

```css
.topbar-status-pill {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  padding: 0.18rem 0.55rem;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--surface);
  color: var(--fg-secondary);
  font-size: 11.5px;
  animation: status-pulse 1.5s ease-in-out infinite;
}
```

- [ ] **Step 5: 测试并提交**

```bash
npm test -- deriveStatusText
npm run build
```

通过后提交：

```bash
git add src/
git commit -m "feat(ui): show detailed agent action status in top bar"
```

---

### Task 5: Composer 内联 @ 文件引用

**Files:**
- Create: `src/components/ComposerFilePicker.tsx`
- Modify: `src/components/Composer.tsx`
- Modify: `src/state/attachment-store.ts`
- Modify: `src/app.css`
- Test: `src/components/ComposerFilePicker.test.tsx`

**Interfaces:**
- Consumes: `useWorkspaceStore.current?.path` 和 `useWorkspaceStore.listFiles`。
- Produces: `ComposerFilePicker` 组件 `{ open: boolean; query: string; onSelect: (path: string) => void; onClose: () => void }`。

- [ ] **Step 1: 写 `ComposerFilePicker` 失败测试并实现**

```tsx
// src/components/ComposerFilePicker.tsx
import { useEffect, useState } from "react";
import { useWorkspaceStore } from "../state/workspace-store";

export interface ComposerFilePickerProps {
  query: string;
  onSelect: (path: string) => void;
  onClose: () => void;
}

export default function ComposerFilePicker({ query, onSelect, onClose }: ComposerFilePickerProps) {
  const current = useWorkspaceStore((s) => s.current);
  const listFiles = useWorkspaceStore((s) => s.listFiles);
  const [files, setFiles] = useState<string[]>([]);

  useEffect(() => {
    if (!current) return;
    listFiles(".")
      .then((entries) => {
        const names: string[] = [];
        const walk = (items: any[]) => {
          for (const e of items || []) {
            if (!e.isDirectory) names.push(e.name);
            if (e.children) walk(e.children);
          }
        };
        walk(entries);
        setFiles(names.filter((n) => n.toLowerCase().includes(query.toLowerCase())).slice(0, 8));
      })
      .catch(() => setFiles([]));
  }, [current, query, listFiles]);

  if (!current) return null;
  return (
    <div className="composer-picker">
      {files.length === 0 && <div className="composer-picker-empty">无匹配文件</div>}
      {files.map((f) => (
        <button key={f} className="composer-picker-row" onClick={() => onSelect(f)} type="button">
          {f}
        </button>
      ))}
    </div>
  );
}
```

测试：

```tsx
import { render, screen, fireEvent } from "@testing-library/react";
import ComposerFilePicker from "./ComposerFilePicker";

vi.mock("../state/workspace-store", () => ({
  useWorkspaceStore: (s: any) => s({ current: { path: "/ws" }, listFiles: () => Promise.resolve([{ name: "a.txt", isDirectory: false }]) }),
}));

test("shows matching files and selects", async () => {
  const onSelect = vi.fn();
  render(<ComposerFilePicker query="a" onSelect={onSelect} onClose={vi.fn()} />);
  const row = await screen.findByText("a.txt");
  fireEvent.click(row);
  expect(onSelect).toHaveBeenCalledWith("a.txt");
});
```

- [ ] **Step 2: 修改 `Composer.tsx` 监听 `@` 字符**

在 `onChange` 中检测最后一个 `@` 后的内容作为 query：

```ts
const [pickerOpen, setPickerOpen] = useState(false);
const [pickerQuery, setPickerQuery] = useState("");

function handleChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
  const v = e.target.value;
  setText(v);
  resize();
  const at = v.lastIndexOf("@");
  if (at >= 0 && !v.slice(at + 1).includes(" ")) {
    setPickerOpen(true);
    setPickerQuery(v.slice(at + 1));
  } else {
    setPickerOpen(false);
  }
}

function insertFile(name: string) {
  const at = text.lastIndexOf("@");
  const before = text.slice(0, at);
  const after = text.slice(at + 1 + pickerQuery.length);
  const next = `${before}@${name} ${after}`;
  setText(next);
  setPickerOpen(false);
  addAttachments([name]);
}
```

在 textarea 下方渲染：

```tsx
{pickerOpen && (
  <ComposerFilePicker query={pickerQuery} onSelect={insertFile} onClose={() => setPickerOpen(false)} />
)}
```

- [ ] **Step 3: 添加 CSS**

```css
.composer-picker {
  position: absolute;
  bottom: 100%;
  left: 0;
  right: 0;
  margin-bottom: 0.4rem;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 10px;
  box-shadow: 0 4px 24px rgba(0,0,0,0.08);
  max-height: 220px;
  overflow-y: auto;
  z-index: 20;
}
.composer-picker-row {
  width: 100%;
  text-align: left;
  padding: 0.45rem 0.75rem;
  border: none;
  background: transparent;
  font-size: 13px;
  cursor: pointer;
}
.composer-picker-row:hover {
  background: var(--surface-2);
}
```

- [ ] **Step 4: 测试并提交**

```bash
npm test -- ComposerFilePicker Composer
npm run build
```

通过后提交：

```bash
git add src/
git commit -m "feat(ui): inline @ file picker in composer"
```

---

### Task 6: 侧边栏重新分组

**Files:**
- Modify: `src/components/Sidebar.tsx`
- Modify: `src/app.css`
- Test: `src/components/Sidebar.test.tsx`

**Interfaces:**
- 保持所有现有 props/state 不变，仅调整文案与分组顺序。

- [ ] **Step 1: 调整 `Sidebar.tsx` 分组**

把底部 NAV 改为显式分组：

```tsx
const NAV: { view: View; label: string; icon?: string }[] = [
  { view: "skills", label: "技能" },
  { view: "mcp", label: "连接器" },
  { view: "settings", label: "设置" },
];
```

在渲染时给这部分加标题：

```tsx
<div className="sidebar-section sidebar-nav">
  <div className="sidebar-label">配置</div>
  {NAV.map((n) => (
    <button key={n.view} className={...} onClick={() => setView(n.view)} type="button">
      {n.label}
    </button>
  ))}
</div>
```

把"定时任务"段标题改为"自动化"，并把"新建定时任务"按钮保留。

- [ ] **Step 2: 写/更新 `Sidebar` 测试**

```tsx
// src/components/Sidebar.test.tsx
import { render, screen } from "@testing-library/react";
import Sidebar from "./Sidebar";

vi.mock("../state/workspace-store", () => ({ useWorkspaceStore: (s: any) => s({ current: null, listFiles: () => Promise.resolve([]) }) }));
vi.mock("../state/chat-store", () => ({ useChatStore: (s: any) => s({ streaming: false, conversationId: null }) }));
vi.mock("../state/conversation-store", () => ({ useConversationStore: (s: any) => s({ list: [] }) }));
vi.mock("../state/scheduled-task-store", () => ({ useScheduledTaskStore: (s: any) => s({ tasks: [] }) }));
vi.mock("../state/ui-store", () => ({ useUiStore: (s: any) => s({ view: "chat" }) }));

test("shows config group labels", () => {
  render(<Sidebar />);
  expect(screen.getByText("配置")).toBeInTheDocument();
  expect(screen.getByText("技能")).toBeInTheDocument();
});
```

- [ ] **Step 3: 调整 CSS**

```css
.sidebar-nav {
  border-top: 1px solid var(--border-soft);
  padding-top: 0.6rem;
}
```

- [ ] **Step 4: 测试并提交**

```bash
npm test -- Sidebar
npm run build
```

通过后提交：

```bash
git add src/
git commit -m "refactor(ui): reorganize sidebar into chat/automation/config groups"
```

---

## Verification

每个任务完成后执行：

```bash
python -m pytest sidecar/tests
npm test
npm run build
```

Task 1 完成后额外做端到端验证：

1. 启动 `npm run tauri dev`。
2. 让 Agent 生成一个文件。
3. 确认产物显示为卡片，点击后在右侧打开预览。
4. 文本文件显示内容，图片文件显示缩略图。

Task 2 完成后验证：空会话时显示欢迎页，点击快捷动作发送对应 prompt。

Task 3 完成后验证：设置页左侧可切换模型/身份/规则。

Task 4 完成后验证：流式过程中 TopBar 显示"正在执行：tool_name…"。

Task 5 完成后验证：在 Composer 输入 `@` 弹出文件列表，选择后附加为引用。

Task 6 完成后验证：侧边栏出现"配置"分组。

---

## Out of Scope

- 文件大小读取（ArtifactCard 中 size 显示为 `"—"`，后续可扩展）。
- PDF/Office 文件的原生预览（本任务仅支持文本和图片）。
- 不增加预估 token 消耗，继续保留现有 usage pill 统计。
- 设置页改为 WorkBuddy 的模态浮层（本任务仅在现有页面内改为左侧导航）。
