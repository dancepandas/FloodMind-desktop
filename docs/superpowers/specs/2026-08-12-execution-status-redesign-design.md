# Design: 执行状态 UI 对齐主流（一行动态指示 + 只流式最终回答）

日期：2026-08-12
状态：approved

## Context

前端执行状态 UI 连续多轮改动后**越改越差**：
- 没有「思考中… → 调用工具… → 正在生成回答…」的一行动态指示（或状态错误）；
- 多轮执行（思考→中间回答→调工具→最终回答）产生的**中间 text 块全部以追加形式**出现在对话流里——每个中间回答都渲染成一个折叠的「第一行…」摘要块，而非一条持续流式输出的回答，观感是堆叠的摘要而不是主流 AI 平台的「状态行 + 流式回答」。

### 主流调研结论（已确认）
1. **执行中**：一行动态状态 + 流式回答。状态随当前步骤原地变化（思考中 → 调用工具 → 正在生成回答），状态文案具体（「正在分析文件…」）而非死板的一直「思考中」。
2. **思考/工具内容**：默认不出现在对话流里，收在一个小折叠块中；不是两行常驻状态。
3. **完成后**：最终答案 + 产物；保留一个默认折叠的复盘入口（可展开看过程）。

### 上一版的问题
「两行常驻状态（思考中/调用工具各一行，始终显示）+ 点击展开」不是主流。主流是**一行动态指示**，随当前步骤变化，做完不显示。

### 探索结论（代码现状）
- `Conversation.tsx`（HEAD d34ad66）已有单条动态状态行实现，但**所有流式 text 块都以 `isLive=false` 渲染**（`answerTexts.map(...)`），因此中间回答显示为折叠摘要 → 追加形式观感。
- 状态推导基于 `blocks[last]`，有真实漏洞：**tool 完成后（`tool_end` 已到达、模型还在处理结果）状态卡在前一个已完成工具的「调用工具」**。
- block 数据模型会产生多个 text 块（跨轮），`final` 只在 turn 结束时标记最后一个。
- `deriveStatusText`（chat-store）被 TopBar 顶栏 pill 复用；`Conversation` 用自己的一套内联推导，两者会漂移。
- 完成态已实现：最终答案 + 产物 + 默认折叠「已用过程」（思考/工具/权限）。

## 方案选择

**方案 A（选定）：纯渲染修正**。保持 block 数据模型与 `reduceEvent`/`appendDelta`/`markFinal` 不动，只改状态推导 + `Conversation.tsx` 渲染 + `BlockView.TextBlock` 的 isLive 分支。最小改动精确解决「追加形式」，不动 `appendInstruction` 多轮插入、plan 模式、权限流。

（备选未选：B 在 store 层标注中间/最终——改动大但体验与 A 几乎相同；C 整体重构为单条助手消息——最彻底但风险最高。）

## 设计

### 1. 状态推导规则（一行动态指示）

`chat-store.ts` 新增 `deriveLiveStatus(turn)`，与现有 `deriveStatusText` 合并为一套文案；TopBar 顶栏 pill 与对话区状态行共用。

| 当前最后一个 block | 状态文案 |
|---|---|
| 无 block（等待首个事件） | 正在思考… |
| `thinking` | 正在思考… |
| `tool` 且 `running/pending/awaiting_permission` | 正在调用 `{tool_name}`… |
| `tool` 已完成（仍在流式） | 正在思考…（过渡态：模型在处理工具结果） |
| `text`（非 final） | 正在生成回答… |
| `permission` 待授权 | 等待授权：`{tool_name}` |
| 其它（plan/artifact/error） | 正在思考… |

要点：
- 修正「tool 完成状态卡死」：已完成的 tool 不再显示「调用工具」，进入「正在思考…」过渡态。
- 具体文案（带工具名）对齐调研点 ①「状态文案具体」。
- 该函数同时供 `Conversation` 状态行与 `TopBar` pill 使用，避免两套推导漂移。

### 2. 执行中渲染

```
FloodMind                    ← 头像 + 名字
正在思考… ● ● ●              ← 一行动态状态，随步骤原地变化（点击展开当前 thinking/tool 详情）
[流式回答]                    ← 只渲染【最后一个】text 块：完整展开 + 流式光标 ▌
```

- 状态行保留现有 `live-status-item` 样式与点击展开逻辑。
- **只渲染最后一个 text 块**（`isLive=true`）。更早的中间 text 块不占对话流。
- 思考/工具内容默认不进对话流（点状态行展开）——对齐调研点 ②。

### 3. 完成态渲染

```
FloodMind
[最终答案 markdown]           ← final text 块，完整展开
[产物卡片]
[已用过程 ▸]                  ← 默认折叠
[usage]
```

- `BlockView.TextBlock`：`isLive` 时不再渲染折叠摘要按钮（只显示展开正文 + 光标），与 final 分支观感一致。
- **边界**：中断/失败的 turn（`done` 但未 `markFinal`）也要显示最后一个 text 块的半截内容 + 「已停止」标记，不能让内容凭空消失。

### 4. 「已用过程」内容（完成态复盘，默认折叠）

比现状多一类：

- `thinking`：可展开「思考过程」
- `tool`：工具名 + 状态 + 定长参数/输出（现状已有）
- **中间 text**（新增）：以紧凑折叠条目展示（`第一行…`，可展开）——即被移出对话流的那些中间回答
- `permission`：批准/拒绝 badge

### 5. 改动面

- `src/state/chat-store.ts`：增强 `deriveStatusText` + 新增 `deriveLiveStatus`（~15 行）
- `src/components/Conversation.tsx`：执行中/完成态渲染改（核心，~40 行）
- `src/components/BlockView.tsx`：`TextBlock` 的 `isLive` 分支小改
- `src/app.css`：状态行/流式回答微调（可能几乎不动）
- 测试：
  - `chat-store.test.ts`：`deriveLiveStatus` 断言（过渡态、带工具名文案等）
  - `Conversation` 渲染相关测试：执行中只渲染最后一个 text 块、isLive 展开、完成态复盘含中间 text

**不动**：`reduceEvent`/`appendDelta`/`markFinal`、block 数据模型、`appendInstruction` 多轮插入、plan 模式、权限流。

## 边界情况

- **tool 完成 → 下一个事件到达前**：状态显示「正在思考…」（过渡态）。
- **中断/失败 turn**：显示半截回答 + 「已停止」，不丢内容。
- **无 text 块的长工具执行**：对话流只有动态状态行，无回答区；最终回答出现时才流式展示。
- **多轮多次中间 text**：仅最后一个在流式中展示，其余进完成态「已用过程」。

## 交付物

- 上述改动实现 + 单测更新 + 前端 `npm test` + `npm run build` 全绿。
- 手工冒烟：多轮 思考→中间回答→调工具→最终回答 场景，观察状态行随步骤变化、流式回答只出现一条、完成态复盘含中间 text。
