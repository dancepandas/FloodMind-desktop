# Composer `/` 选择器设计

**日期**: 2026-07-14  
**状态**: 已批准，待实现  

## 背景

FloodMind Desktop 的 `Composer` 输入框已经支持 `@` 引用文件（以附件 pill 形式注入到提示词中）。用户希望在输入框里输入 `/` 时也能唤起一个选择器，列出可用的 **Skill** 和 **MCP 服务器**，选中后让 agent 在提示词中收到一句调用指令。

## 目标

- 输入 `/` 唤起选择器，列出 Skills 和 MCP 服务器。
- 单选：一次只能选中一个 Skill 或一个 MCP 服务器。
- 选中后以 pill 形式显示在输入框上方，可移除。
- 发送消息时，在正文后追加调用指令：
  - Skill: `请使用 ${name} skill`
  - MCP 服务器: `请使用 ${name} MCP工具`

## 非目标

- 不实现多选。
- 不展示单个 MCP 工具名，仅展示 MCP server 名。
- 不修改 sidecar API；复用现有 `/api/skills` 和 `/api/mcp`。

## 架构

复用现有 `catalog-store` 管理 Skills 和 MCP 服务器列表。新增 `SlashPicker` 组件，行为与 `ComposerFilePicker` 保持一致。`Composer` 增加单条 `slashItem` 状态，并在 `buildMessage()` 中注入指令。

```
Composer
├── attachments pills
├── slash item pill (skill / mcp)
├── SlashPicker (conditional)
├── ComposerFilePicker (conditional)
└── textarea
```

## 数据模型

### SlashItem

```ts
type SlashItem =
  | { kind: "skill"; name: string; description?: string }
  | { kind: "mcp"; name: string };
```

### Catalog store 复用字段

- `SkillSummary`: `name`, `description`, `category`, `disabled`
- `McpServer`: `name`, `transport`, `tools`, `connected`

禁用的 Skill 不展示；未连接的 MCP server 仍可展示，但带状态指示。

## 组件设计

### `SlashPicker.tsx`（新增）

**Props**

```ts
interface SlashPickerProps {
  query: string;
  onSelect: (item: SlashItem) => void;
  onClose: () => void;
}
```

**行为**

1. 挂载时调用 `catalogStore.loadSkills()` 和 `catalogStore.loadMcp()`（store 会缓存，重复打开无额外请求）。
2. 按 `query` 过滤 Skills 和 MCP 服务器名称，最多展示 8 条。
3. 分组渲染：
   - **Skills**（展示 `name` + `description`）
   - **MCP 服务器**（展示 `name` + 状态点 + 工具数）
4. 点击条目 → `onSelect(item)`。
5. `Escape` 关闭选择器。
6. 无匹配时显示 `无匹配项`。

### `Composer.tsx`（修改）

**新增状态**

```ts
const [slashItem, setSlashItem] = useState<SlashItem | null>(null);
const [slashOpen, setSlashOpen] = useState(false);
const [slashQuery, setSlashQuery] = useState("");
```

**文本检测**

在 `handleChange` 中，逻辑同 `@` 检测：

```ts
const slash = v.lastIndexOf("/");
if (slash >= 0 && !v.slice(slash + 1).includes(" ")) {
  setSlashOpen(true);
  setSlashQuery(v.slice(slash + 1));
} else {
  setSlashOpen(false);
}
```

**选中处理**

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

**Pill 渲染**

在附件 pills 区域下方、textarea 上方渲染 slash pill：

```tsx
{slashItem && (
  <span className="slash-pill" data-kind={slashItem.kind}>
    {slashItem.kind === "skill" ? "Skill" : "MCP"}: {slashItem.name}
    <button type="button" onClick={() => setSlashItem(null)}>✕</button>
  </span>
)}
```

**消息构建**

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

**发送后清理**

```ts
function doSend() {
  const msg = buildMessage();
  if (!msg) return;
  send(msg);
  setText("");
  setSlashItem(null);
  clearAttachments();
  // ...
}
```

## 样式

新增 CSS 类：

- `.slash-picker`：与 `.composer-picker` 同层，定位在 textarea 上方。
- `.slash-picker-section`：分组标题（Skills / MCP 服务器）。
- `.slash-picker-row`：可选中条目。
- `.slash-pill`：已选 skill/mcp pill，颜色区别于附件 pill（例如 skill 用蓝色系，mcp 用绿色系）。

## 错误处理

- `catalog-store` 加载失败时选择器静默显示 `无匹配项`。
- 用户按 Escape 或输入空格时关闭选择器。
- 选择器外点击关闭（可选，由 `SlashPicker` 内部处理）。

## 测试计划

新增 / 更新 `src/components/Composer.test.tsx`：

1. 输入 `/` 时打开选择器并展示 Skills 与 MCP 服务器。
2. 选择 Skill 后：
   - 输入框中 `/` 及查询文本被移除。
   - 出现 `Skill: xxx` pill。
   - 发送的消息包含 `请使用 xxx skill`。
3. 选择 MCP 服务器后：
   - 出现 `MCP: xxx` pill。
   - 发送的消息包含 `请使用 xxx MCP工具`。
4. 点击 pill 上的 ✕ 可移除 slash item，消息不再包含调用指令。
5. 同时存在附件和 slash item 时，消息格式正确。
6. Escape 关闭选择器。

## 实现顺序

1. 新增 `SlashPicker.tsx` 组件。
2. 修改 `Composer.tsx` 接入 slash 检测、picker、pill 和消息构建。
3. 添加 / 调整 CSS 样式。
4. 更新 `Composer.test.tsx` 测试用例。
5. 运行 `npm test -- Composer` 和 `npm run build` 验证。
