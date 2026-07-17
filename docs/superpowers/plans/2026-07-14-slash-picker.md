# Composer `/` 选择器实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Composer 输入框中增加 `/` 唤起选择器，列出 Skills 和 MCP 服务器，选中后以 pill 形式展示，并在发送时向提示词追加调用指令。

**Architecture:** 复用现有 `catalog-store` 的 `skills`/`mcpServers` 数据；新增独立 `SlashPicker` 组件负责数据加载、过滤与展示；`Composer` 负责 `/` 检测、选中项状态、pill 渲染以及消息构建。单选模式。

**Tech Stack:** React 19 + Vite + TypeScript + Zustand + Vitest + @testing-library/react。

## Global Constraints

- 单选：一次只能选择一个 Skill 或一个 MCP 服务器。
- MCP 粒度为 server 名，不展示单个 tool。
- 禁用（`disabled`）的 Skill 不展示。
- 未连接的 MCP server 仍展示，但带状态指示。
- 复用现有 `/api/skills` 和 `/api/mcp`，不新增 sidecar 接口。
- 提示词追加指令格式：
  - Skill: `请使用 ${name} skill`
  - MCP: `请使用 ${name} MCP工具`
- 每次任务结束后独立运行对应测试并提交。

---

## File Structure

| 文件 | 职责 |
|---|---|
| `src/components/SlashPicker.tsx` | 新增：加载并展示 Skills/MCP 服务器列表，支持搜索过滤、Escape 关闭、选中回调。 |
| `src/components/SlashPicker.test.tsx` | 新增：单元测试 SlashPicker 的加载、过滤、选中、关闭行为。 |
| `src/components/Composer.tsx` | 修改：集成 `/` 检测、渲染 SlashPicker、维护 slashItem 状态、渲染 pill、在 `buildMessage` 中注入指令。 |
| `src/components/Composer.test.tsx` | 修改：补充 catalog-store mock，新增 slash picker 集成测试。 |
| `src/app.css` | 修改：增加 `.slash-picker*` 与 `.slash-pill*` 样式。 |

---

## Task 1: Create `SlashPicker` component

**Files:**
- Create: `src/components/SlashPicker.tsx`
- Create: `src/components/SlashPicker.test.tsx`

**Interfaces:**
- Consumes: `useCatalogStore` 的 `skills`、`mcpServers`、`loadSkills`、`loadMcp`。
- Produces: `SlashItem` 类型与 `SlashPicker` 组件；`onSelect(item: SlashItem)`、`onClose()` 回调。

- [ ] **Step 1: Write the failing test**

  Create `src/components/SlashPicker.test.tsx`:

  ```tsx
  import { describe, it, expect, vi, beforeEach } from "vitest";
  import { render, screen, fireEvent, cleanup } from "@testing-library/react";
  import SlashPicker from "./SlashPicker";
  import { useCatalogStore } from "../state/catalog-store";

  describe("SlashPicker", () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();

    beforeEach(() => {
      vi.clearAllMocks();
      useCatalogStore.setState({
        skills: [
          { name: "code-review", description: "Review code", disabled: false },
          { name: "csv", description: "CSV ops", disabled: true },
        ],
        mcpServers: [
          { name: "filesystem", connected: true, tools: 3 },
          { name: "github", connected: false, tools: 0 },
        ],
        loadSkills: vi.fn(),
        loadMcp: vi.fn(),
      } as any);
    });

    afterEach(() => {
      cleanup();
    });

    it("loads skills and mcp servers on mount", () => {
      const loadSkills = vi.fn();
      const loadMcp = vi.fn();
      useCatalogStore.setState({ loadSkills, loadMcp } as any);
      render(<SlashPicker query="" onSelect={onSelect} onClose={onClose} />);
      expect(loadSkills).toHaveBeenCalledTimes(1);
      expect(loadMcp).toHaveBeenCalledTimes(1);
    });

    it("renders enabled skills and all mcp servers", () => {
      render(<SlashPicker query="" onSelect={onSelect} onClose={onClose} />);
      expect(screen.getByText("code-review")).toBeInTheDocument();
      expect(screen.queryByText("csv")).not.toBeInTheDocument();
      expect(screen.getByText("filesystem")).toBeInTheDocument();
      expect(screen.getByText("github")).toBeInTheDocument();
    });

    it("filters items by query", () => {
      render(<SlashPicker query="file" onSelect={onSelect} onClose={onClose} />);
      expect(screen.queryByText("code-review")).not.toBeInTheDocument();
      expect(screen.getByText("filesystem")).toBeInTheDocument();
      expect(screen.queryByText("github")).not.toBeInTheDocument();
    });

    it("calls onSelect with skill when a skill row is clicked", () => {
      render(<SlashPicker query="" onSelect={onSelect} onClose={onClose} />);
      fireEvent.click(screen.getByText("code-review"));
      expect(onSelect).toHaveBeenCalledWith({ kind: "skill", name: "code-review" });
    });

    it("calls onSelect with mcp when an mcp row is clicked", () => {
      render(<SlashPicker query="" onSelect={onSelect} onClose={onClose} />);
      fireEvent.click(screen.getByText("filesystem"));
      expect(onSelect).toHaveBeenCalledWith({ kind: "mcp", name: "filesystem" });
    });

    it("closes on Escape", () => {
      render(<SlashPicker query="" onSelect={onSelect} onClose={onClose} />);
      fireEvent.keyDown(window, { key: "Escape" });
      expect(onClose).toHaveBeenCalled();
    });

    it("shows empty hint when nothing matches", () => {
      render(<SlashPicker query="zzzzz" onSelect={onSelect} onClose={onClose} />);
      expect(screen.getByText("无匹配项")).toBeInTheDocument();
    });
  });
  ```

- [ ] **Step 2: Run test to verify it fails**

  Run: `npm test -- SlashPicker`

  Expected: FAIL — `SlashPicker` component does not exist.

- [ ] **Step 3: Write minimal implementation**

  Create `src/components/SlashPicker.tsx`:

  ```tsx
  import { useEffect } from "react";
  import { useCatalogStore } from "../state/catalog-store";

  export interface SlashItem {
    kind: "skill" | "mcp";
    name: string;
  }

  export interface SlashPickerProps {
    query: string;
    onSelect: (item: SlashItem) => void;
    onClose: () => void;
  }

  export default function SlashPicker({ query, onSelect, onClose }: SlashPickerProps) {
    const skills = useCatalogStore((s) => s.skills);
    const mcpServers = useCatalogStore((s) => s.mcpServers);
    const loadSkills = useCatalogStore((s) => s.loadSkills);
    const loadMcp = useCatalogStore((s) => s.loadMcp);

    useEffect(() => {
      loadSkills();
      loadMcp();
    }, [loadSkills, loadMcp]);

    useEffect(() => {
      function onKeyDown(e: KeyboardEvent) {
        if (e.key === "Escape") onClose();
      }
      window.addEventListener("keydown", onKeyDown);
      return () => window.removeEventListener("keydown", onKeyDown);
    }, [onClose]);

    const q = query.toLowerCase();
    const filteredSkills = skills
      .filter((s) => !s.disabled && s.name.toLowerCase().includes(q))
      .slice(0, 8);
    const filteredMcp = mcpServers
      .filter((s) => s.name.toLowerCase().includes(q))
      .slice(0, 8);

    const hasSkills = filteredSkills.length > 0;
    const hasMcp = filteredMcp.length > 0;

    return (
      <div className="composer-picker slash-picker" role="listbox" aria-label="Skill 和 MCP 选择">
        {hasSkills && (
          <div className="slash-picker-section">
            <div className="slash-picker-section-title">Skills</div>
            {filteredSkills.map((s) => (
              <button
                key={s.name}
                className="composer-picker-row slash-picker-row"
                type="button"
                role="option"
                onClick={() => onSelect({ kind: "skill", name: s.name })}
              >
                <span className="slash-picker-name">{s.name}</span>
                {s.description && (
                  <span className="slash-picker-desc">{s.description}</span>
                )}
              </button>
            ))}
          </div>
        )}
        {hasMcp && (
          <div className="slash-picker-section">
            <div className="slash-picker-section-title">MCP 服务器</div>
            {filteredMcp.map((s) => (
              <button
                key={s.name}
                className="composer-picker-row slash-picker-row"
                type="button"
                role="option"
                onClick={() => onSelect({ kind: "mcp", name: s.name })}
              >
                <span className="slash-picker-name">{s.name}</span>
                <span className={`sdot ${s.connected ? "sdot-up" : "sdot-down"}`} />
              </button>
            ))}
          </div>
        )}
        {!hasSkills && !hasMcp && (
          <div className="composer-picker-empty">无匹配项</div>
        )}
      </div>
    );
  }
  ```

- [ ] **Step 4: Run test to verify it passes**

  Run: `npm test -- SlashPicker`

  Expected: PASS.

- [ ] **Step 5: Commit**

  ```bash
  git add src/components/SlashPicker.tsx src/components/SlashPicker.test.tsx
  git commit -m "feat(ui): add SlashPicker component for skills and MCP servers"
  ```

---

## Task 2: Integrate slash detection and picker into Composer

**Files:**
- Modify: `src/components/Composer.tsx`
- Modify: `src/components/Composer.test.tsx`

**Interfaces:**
- Consumes: `SlashPicker` (from Task 1) with `query`, `onSelect`, `onClose`.
- Produces: `Composer` detects `/`, renders `SlashPicker`, and closes it on select/escape/space.

- [ ] **Step 1: Write the failing test**

  In `src/components/Composer.test.tsx`, add the catalog-store mock and a new test:

  Add near the top of the file, after existing mocks:

  ```ts
  vi.mock("../state/catalog-store", () => ({
    useCatalogStore: (selector: (s: any) => any) =>
      selector({
        skills: [{ name: "code-review", description: "Review code", disabled: false }],
        mcpServers: [{ name: "filesystem", connected: true, tools: 3 }],
        loadSkills: vi.fn(),
        loadMcp: vi.fn(),
      }),
  }));
  ```

  Add a new test inside the `describe("Composer", () => { ... })` block:

  ```ts
  it("opens the slash picker when / is typed", async () => {
    render(<Composer />);
    const textarea = screen.getByLabelText("任务输入");
    fireEvent.change(textarea, { target: { value: "check /" } });
    await screen.findByText("Skills");
    await screen.findByText("MCP 服务器");
    expect(screen.getByText("code-review")).toBeInTheDocument();
    expect(screen.getByText("filesystem")).toBeInTheDocument();
  });
  ```

- [ ] **Step 2: Run test to verify it fails**

  Run: `npm test -- Composer`

  Expected: FAIL — `Composer` does not render `SlashPicker` when `/` is typed.

- [ ] **Step 3: Write minimal implementation**

  Modify `src/components/Composer.tsx`:

  1. Import `SlashPicker`:

     ```ts
     import SlashPicker, { type SlashItem } from "./SlashPicker";
     ```

  2. Add state:

     ```ts
     const [slashOpen, setSlashOpen] = useState(false);
     const [slashQuery, setSlashQuery] = useState("");
     ```

  3. Replace `handleChange` with a version that handles both `@` and `/`, keeping only the most-recent trigger open:

     ```ts
     function handleChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
       const v = e.target.value;
       setText(v);
       resize();

       const at = v.lastIndexOf("@");
       const slash = v.lastIndexOf("/");
       const lastTrigger = Math.max(at, slash);

       if (lastTrigger === at && at >= 0 && !v.slice(at + 1).includes(" ")) {
         setPickerOpen(true);
         setPickerQuery(v.slice(at + 1));
         setSlashOpen(false);
       } else if (lastTrigger === slash && slash >= 0 && !v.slice(slash + 1).includes(" ")) {
         setSlashOpen(true);
         setSlashQuery(v.slice(slash + 1));
         setPickerOpen(false);
       } else {
         setPickerOpen(false);
         setSlashOpen(false);
       }
     }
     ```

  4. Render `SlashPicker` right before `ComposerFilePicker` inside the form:

     ```tsx
     {slashOpen && (
       <SlashPicker
         query={slashQuery}
         onSelect={() => { /* TODO in Task 3 */ }}
         onClose={() => setSlashOpen(false)}
       />
     )}
     ```

- [ ] **Step 4: Run test to verify it passes**

  Run: `npm test -- Composer`

  Expected: PASS — the new test passes; existing tests should still pass.

- [ ] **Step 5: Commit**

  ```bash
  git add src/components/Composer.tsx src/components/Composer.test.tsx
  git commit -m "feat(ui): detect / in Composer and render SlashPicker"
  ```

---

## Task 3: Handle selection and render slash pill

**Files:**
- Modify: `src/components/Composer.tsx`
- Modify: `src/components/Composer.test.tsx`

**Interfaces:**
- Consumes: `SlashItem` from `SlashPicker`.
- Produces: `Composer` displays a removable pill for the selected slash item and clears the `/query` from the input.

- [ ] **Step 1: Write the failing test**

  Add to `src/components/Composer.test.tsx`:

  ```ts
  it("selects a skill and shows it as a removable pill", async () => {
    render(<Composer />);
    const textarea = screen.getByLabelText("任务输入") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "review /code" } });
    const row = await screen.findByText("code-review");
    fireEvent.click(row);
    expect(textarea.value).toBe("review ");
    expect(screen.getByText("Skill")).toBeInTheDocument();
    expect(screen.getByText("code-review")).toBeInTheDocument();
  });

  it("selects an mcp server and shows it as a removable pill", async () => {
    render(<Composer />);
    const textarea = screen.getByLabelText("任务输入") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "list /fs" } });
    const row = await screen.findByText("filesystem");
    fireEvent.click(row);
    expect(textarea.value).toBe("list ");
    expect(screen.getByText("MCP")).toBeInTheDocument();
    expect(screen.getByText("filesystem")).toBeInTheDocument();
  });

  it("removes the slash pill when clicking its remove button", async () => {
    render(<Composer />);
    const textarea = screen.getByLabelText("任务输入");
    fireEvent.change(textarea, { target: { value: "review /code" } });
    const row = await screen.findByText("code-review");
    fireEvent.click(row);
    const remove = screen.getByLabelText("移除 code-review");
    fireEvent.click(remove);
    expect(screen.queryByText("Skill")).not.toBeInTheDocument();
  });
  ```

- [ ] **Step 2: Run test to verify it fails**

  Run: `npm test -- Composer`

  Expected: FAIL — pills are not rendered yet.

- [ ] **Step 3: Write minimal implementation**

  Modify `src/components/Composer.tsx`:

  1. Add state:

     ```ts
     const [slashItem, setSlashItem] = useState<SlashItem | null>(null);
     ```

  2. Add `insertSlash` function after `insertFile`:

     ```ts
     function insertSlash(item: SlashItem) {
       const slash = text.lastIndexOf("/");
       const before = text.slice(0, slash);
       const after = text.slice(slash + 1 + slashQuery.length);
       setText(before + after);
       setSlashItem(item);
       setSlashOpen(false);
       resize();
     }
     ```

  3. Wire `SlashPicker.onSelect`:

     ```tsx
     {slashOpen && (
       <SlashPicker
         query={slashQuery}
         onSelect={insertSlash}
         onClose={() => setSlashOpen(false)}
       />
     )}
     ```

  4. Render slash pill inside the form, above the textarea and after attachments:

     ```tsx
     {attachments.length > 0 && (
       <div className="composer-attachments">...</div>
     )}
     {slashItem && (
       <div className="composer-slash-item">
         <span className="slash-pill" data-kind={slashItem.kind}>
           <span className="slash-pill-kind">
             {slashItem.kind === "skill" ? "Skill" : "MCP"}
           </span>
           <span className="slash-pill-name">{slashItem.name}</span>
           <button
             type="button"
             className="slash-pill-remove"
             onClick={() => setSlashItem(null)}
             aria-label={`移除 ${slashItem.name}`}
           >
             ✕
           </button>
         </span>
       </div>
     )}
     ```

- [ ] **Step 4: Run test to verify it passes**

  Run: `npm test -- Composer`

  Expected: PASS.

- [ ] **Step 5: Commit**

  ```bash
  git add src/components/Composer.tsx src/components/Composer.test.tsx
  git commit -m "feat(ui): select skill/mcp from SlashPicker and render slash pill"
  ```

---

## Task 4: Inject instruction into outgoing message

**Files:**
- Modify: `src/components/Composer.tsx`
- Modify: `src/components/Composer.test.tsx`

**Interfaces:**
- Consumes: `slashItem` state.
- Produces: `buildMessage()` appends the correct usage instruction; `doSend()` clears `slashItem`.

- [ ] **Step 1: Write the failing test**

  Add to `src/components/Composer.test.tsx`:

  ```ts
  it("sends message with skill instruction when a skill is selected", async () => {
    render(<Composer />);
    const textarea = screen.getByLabelText("任务输入") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "review /code" } });
    const row = await screen.findByText("code-review");
    fireEvent.click(row);
    fireEvent.click(screen.getByLabelText("发送"));
    expect(sendMock).toHaveBeenCalledWith("review \n\n请使用 code-review skill");
  });

  it("sends message with mcp instruction when an mcp server is selected", async () => {
    render(<Composer />);
    const textarea = screen.getByLabelText("任务输入") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "list files /fs" } });
    const row = await screen.findByText("filesystem");
    fireEvent.click(row);
    fireEvent.click(screen.getByLabelText("发送"));
    expect(sendMock).toHaveBeenCalledWith("list files \n\n请使用 filesystem MCP工具");
  });

  it("clears slash item after sending", async () => {
    render(<Composer />);
    const textarea = screen.getByLabelText("任务输入");
    fireEvent.change(textarea, { target: { value: "review /code" } });
    fireEvent.click(await screen.findByText("code-review"));
    fireEvent.click(screen.getByLabelText("发送"));
    expect(screen.queryByText("Skill")).not.toBeInTheDocument();
  });
  ```

- [ ] **Step 2: Run test to verify it fails**

  Run: `npm test -- Composer`

  Expected: FAIL — `buildMessage` does not include the instruction yet.

- [ ] **Step 3: Write minimal implementation**

  Modify `src/components/Composer.tsx`:

  1. Replace `buildMessage`:

     ```ts
     function buildMessage(): string {
       const trimmed = text.trim();
       const parts: string[] = [];

       if (attachments.length > 0) {
         const refs = attachments.map((p) => `- ${p}`).join("\n");
         parts.push(`[引用文件]\n${refs}`);
       }

       if (slashItem) {
         const instruction =
           slashItem.kind === "skill"
             ? `请使用 ${slashItem.name} skill`
             : `请使用 ${slashItem.name} MCP工具`;
         parts.push(instruction);
       }

       if (!trimmed && parts.length === 0) return "";
       if (!trimmed) return parts.join("\n\n");
       if (parts.length === 0) return trimmed;
       return `${trimmed}\n\n${parts.join("\n\n")}`;
     }
     ```

  2. Update `doSend` to clear `slashItem`:

     ```ts
     function doSend() {
       const msg = buildMessage();
       if (!msg) return;
       send(msg);
       setText("");
       setSlashItem(null);
       clearAttachments();
       if (textareaRef.current) textareaRef.current.style.height = "auto";
     }
     ```

- [ ] **Step 4: Run test to verify it passes**

  Run: `npm test -- Composer`

  Expected: PASS.

- [ ] **Step 5: Commit**

  ```bash
  git add src/components/Composer.tsx src/components/Composer.test.tsx
  git commit -m "feat(ui): append skill/mcp usage instruction to outgoing message"
  ```

---

## Task 5: Add CSS styles

**Files:**
- Modify: `src/app.css`

**Interfaces:**
- Consumes: HTML classes introduced in Tasks 1-3 (`slash-picker`, `slash-picker-section`, `slash-picker-section-title`, `slash-picker-row`, `slash-picker-name`, `slash-picker-desc`, `composer-slash-item`, `slash-pill`, `slash-pill-kind`, `slash-pill-name`, `slash-pill-remove`).
- Produces: Visual styling for the picker and pill.

- [ ] **Step 1: Add styles to `src/app.css`**

  Insert the following block immediately after `.composer-picker-row:focus-visible` (around line 1026):

  ```css
  .slash-picker .slash-picker-section + .slash-picker-section {
    border-top: 1px solid var(--border-soft);
  }

  .slash-picker-section-title {
    padding: 0.35rem 0.75rem;
    font-size: 11px;
    font-weight: 600;
    color: var(--muted);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .slash-picker-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
  }

  .slash-picker-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .slash-picker-desc {
    margin-left: auto;
    font-size: 12px;
    color: var(--muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 60%;
  }
  ```

  Insert the following block immediately after `.composer-attachments` (around line 1882):

  ```css
  .composer-slash-item {
    display: flex;
    padding: 0 0 0.5rem;
  }

  .slash-pill {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    max-width: 220px;
    padding: 0.18rem 0.45rem;
    background: #eff6ff;
    border: 1px solid #bfdbfe;
    border-radius: 999px;
    font-size: 12px;
    color: var(--blue);
  }

  .slash-pill[data-kind="mcp"] {
    background: #f0fdf4;
    border-color: #bbf7d0;
    color: var(--green);
  }

  .slash-pill-kind {
    font-size: 10px;
    font-weight: 600;
    text-transform: uppercase;
    opacity: 0.8;
  }

  .slash-pill-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .slash-pill-remove {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 14px;
    height: 14px;
    border: none;
    border-radius: 50%;
    background: transparent;
    color: currentColor;
    font-size: 10px;
    cursor: pointer;
    opacity: 0.7;
  }

  .slash-pill-remove:hover {
    background: rgba(0, 0, 0, 0.08);
    opacity: 1;
  }
  ```

- [ ] **Step 2: Verify build passes**

  Run: `npm run build`

  Expected: PASS — TypeScript check and Vite build succeed with no CSS errors.

- [ ] **Step 3: Commit**

  ```bash
  git add src/app.css
  git commit -m "style(ui): add slash picker and slash pill styles"
  ```

---

## Task 6: Full verification

**Files:**
- All files from previous tasks.

**Interfaces:**
- Consumes: All implemented components and styles.
- Produces: Confident green test suite and successful production build.

- [ ] **Step 1: Run component tests**

  Run: `npm test -- SlashPicker`

  Expected: PASS.

- [ ] **Step 2: Run Composer tests**

  Run: `npm test -- Composer`

  Expected: PASS.

- [ ] **Step 3: Run full frontend test suite**

  Run: `npm test`

  Expected: PASS.

- [ ] **Step 4: Run production build**

  Run: `npm run build`

  Expected: PASS.

- [ ] **Step 5: Commit any final fixes**

  If any fixes were needed, commit them:

  ```bash
  git add -A
  git commit -m "fix(ui): slash picker full verification fixes"
  ```

---

## Self-Review

### Spec coverage

- `/` 唤起选择器 → Task 2。
- 列出 Skills 和 MCP 服务器 → Task 1。
- 单选 → Task 3（`setSlashItem` 替换而非追加）。
- 禁用 skill 不展示 → Task 1 (`!s.disabled`)。
- 未连接 MCP 仍展示带状态点 → Task 1 (`sdot-up`/`sdot-down`)。
- pill 可移除 → Task 3。
- 发送时追加指令 → Task 4。
- 发送后清空 → Task 4。

### Placeholder scan

无 TBD/TODO/"稍后实现"/"适当处理"。

### Type consistency

- `SlashItem` 在 Task 1 定义，类型为 `{ kind: "skill" | "mcp"; name: string }`。
- Task 2/3/4 中的 `slashItem`/`insertSlash`/`buildMessage` 均使用同一类型。
- CSS class 名称与 TSX 中一致。

### Risk notes

- `handleChange` 同时处理 `@` 和 `/`，通过 `Math.max(at, slash)` 保证只打开最近一个触发器，避免两个 picker 同时显示。
- `SlashPicker` 挂载时调用 `loadSkills`/`loadMcp`，store 会缓存结果，重复打开无额外请求。
