# 多模态图片输入（Vision）— 设计文档

**日期**：2026-07-18
**状态**：已通过设计评审，待写实现计划
**关联**：FloodMind Desktop（Tauri 2 + React 19 + Python Flask Sidecar）

## 背景与目标

当前桌面端只能向模型发送纯文本。用户希望释放模型的多模态能力——让 FloodMind 能接收图片（水文图表、截图、示意图等），由视觉模型理解图意后进入正常 agentic 工作流。

调研结论（CC / Codex CLI / Opencode）：

- 三家都提供「粘贴 + 拖拽 + 文件路径」三种入口；剪贴板粘贴在 Windows 终端最不稳（Codex #19143、Opencode #906），但我们是 Tauri 桌面应用走原生 API，反而比 CLI 容易。
- 成本陷阱（Codex 血泪）：多轮对话里图片 token 每轮被重发。必须避免图片贯穿整个会话。
- Opencode 反面教材：把图片混进普通文件通道，`Read` 工具读图直接报错（#15728 / #11306）。图片与工作区文件引用必须分两条通道。

SDK 现状（关键前提 ✅）：FloodMind SDK **内部已完整支持图片输入，无需改 SDK 本体**。

- `NativeFloodAgent.stream(user_input, ..., attachments: Optional[List[Attachment]], abort_check, ...)`（`native_flood_agent.py:2251`）已接受 attachments。
- `Attachment(kind: Literal["image","document"], path, mime_type, ...)`（`types.py:33`）。
- `MessageBuilder.build_user_message(text, attachments)` 读 path → base64 → 拼 OpenAI 标准 `[{type:text},{type:image_url,image_url:{url:data:...}}]`（`message_builder.py:27`）。
- `ModelClient.stream_chat(messages: List[dict])` 把 dict 原样丢给 `openai.OpenAI`，内容数组天然支持。
- sidecar 调的 `create_flood_agent()` 直接返回 `NativeFloodAgent`（不是 `api.py:170` 那个只收 str 的 `Agent` 包装类），所以 sidecar **现在就能**传 `attachments=[...]`。
- SDK 有 `ResolvedModel.supports_vision`（`model_resolver.py:47`），可判断模型是否支持视觉。

模型层面：智谱 GLM-5、Kimi K2/K2.5、MiniMax、Qwen 视觉系为原生多模态；DeepSeek 聊天模型等不支持。需按模型能力动态开关图片入口。

## 已定决策

| # | 决策点 | 选择 |
|---|--------|------|
| 1 | 入口方式 | 粘贴 + 拖拽 + `@工作区图片` 三种全做 |
| 2 | 图片生命周期 | **SDK 原生 attachments、单轮有效**——图片只在被发送的那一轮的 agent 运行里出现，运行结束即丢弃，下一轮纯文本。跨轮次天然不重发（`DualMemory.add_user_message` 只存文本，attachments 不入记忆）；单次运行内的多步重发交给服务商 prompt 缓存兜底。零 SDK 改动。 |
| 3 | 非视觉模型 | 禁用三个入口 + tooltip 提示「当前模型不支持图片输入」 |
| 4 | 体积处理 | 硬上限单张 ≤10MB，超限拒绝；原图直发不压缩，由服务商端降采样（与 CC 一致） |

## 架构与数据流

所有图片最终汇成一条统一的 **attachment 描述符**进入 `/api/chat` 请求体，由 sidecar 归一化成 SDK `Attachment`。三种入口按来源区分（判别联合）：

```
@工作区图片      → {source:"workspace", name, mime}     ← sidecar 用 workspace_root + name 解析绝对路径
拖拽文件到输入框  → {source:"file", path, mime}          ← Tauri onDragDropEvent 给的绝对路径，原样使用
剪贴板粘贴截图    → {source:"clipboard", data:base64}    ← sidecar 写到 app_data/image-staging/<uuid>.<ext>
```

### `/api/chat` 请求体扩展

现状：`{ messages: [{role, content: string}] }`。
扩展：新增可选 `attachments: ImageAttachment[]`。`content` 仍为纯文本（agent 看到的文字部分）。仅发起轮（`send()`）携带 attachments；mid-run `appendInstruction`（`/api/chat/append`）维持纯文本，不支持图片。

```ts
type ImageAttachment =
  | { source: "workspace"; name: string; mime: string }
  | { source: "file"; path: string; mime: string }
  | { source: "clipboard"; data: string; mime: string }; // data = base64（无换行）
```

### sidecar 归一化流程

`FloodMindAgent.stream(messages)` 内（在提取 `user_text` 之后、调用 `agent.stream()` 之前）：

1. 从 `messages[-1]` 读出 attachments 描述符列表。
2. 对每个描述符解析出真实可读 `path`：
   - `workspace`：`abs = os.path.join(workspace_root, name)`；校验解析后仍在 `workspace_root` 子树内（防 `../` 越界），且扩展名 ∈ `_IMAGE_EXTS`。
   - `file`：校验绝对路径 + 图片扩展名 + 可读。
   - `clipboard`：base64 解码 → 写入 `<app_data>/image-staging/<uuid>.<ext>`，path 指向该文件。
3. `os.path.getsize(path)` 校验 ≤ 10MB，超限 yield `error` 事件并跳过该附件。
4. 构造 `Attachment(file_id=str(uuid4()), name=..., path=resolved, kind="image", mime_type=mime, size=...)`。
5. `agent.stream(user_text, attachments=[...], abort_check=...)`。

SDK 随后自行 `MessageBuilder.build_user_message(user_text, attachments)` → base64 → OpenAI 内容数组。无 SDK 改动。

### 关键不变量

- workspace 图片必须解析后落在 workspace 子树内（安全边界）。
- 任一附件超限/不可读/扩展名非法 → 单独 yield `error` 事件、跳过该附件，不中断整次发送。
- 非视觉模型（`resolve_model(...).supports_vision == False`）收到 attachments 时 → 拒绝并返回 `error` 事件「当前模型不支持图片输入」。（前端已禁用入口，这是后端兜底。）

## `supports_vision` 链路打通

现状缺口：SDK 的 `ResolvedModel.supports_vision` 已就绪，但桌面侧未接通——`providers.ts` 模型无视觉标记、`config-store.ts` 的 `ModelConfig` 无 vision 字段、保存路径不写 `supports_vision`。需四处补：

1. **`src/lib/providers.ts`**：`CuratedModelDef` 加 `supportsVision?: boolean`；给 GLM-5、Kimi K2/K2.5、MiniMax3、Qwen 视觉系等打 `true`，DeepSeek 聊天模型等留 `false`/省略。
2. **`src/state/config-store.ts`**：`ModelConfig` 加 `supportsVision: boolean`；`save()` 写 settings.json 时模型条目带 `supportsVision`（SDK `resolve_model` 认 `supports_vision`/`supportsVision` 两种键）。
3. **后端 `/api/config/model` GET**：用 `resolve_model(activeModel, activeProvider).supports_vision` 算出激活模型能力，放入返回 `model` 块。
4. **前端 Composer**：读 `model.supportsVision`，为 `false` 时粘贴/拖拽/`@`图片三入口置灰 + tooltip「当前模型不支持图片输入，请在设置中切换视觉模型」。

## 前端 UX

### 输入交互

- **Composer 图片区**：复用现有 `attachment-pill` 样式，新增带缩略图的图片 chip（32×32 缩略图 + 文件名 + ✕ 移除）。粘贴/拖拽自动入栈。
- **拖拽高亮**：拖文件进入 composer 区域时整框高亮（`drag-over` 态），松手入栈；离开取消高亮。仅接受图片扩展名，非图片忽略。
- **粘贴**：textarea 监听 DOM `paste` 事件，命中 `image/*` blob 即入栈（WebView2 支持）；若 webview 不给 blob，回落 `@tauri-apps/plugin-clipboard-manager` 的 `readImage()`。
- **流式中禁用**：`streaming === true` 时图片入口禁用——与「图片只属于发起那一轮」一致。

### `@` 图片分叉

- 文件选择器（FilePickerModal / ComposerFilePicker）中，图片扩展名的文件以视觉图标区分。
- 选中图片 → 走视觉附件通道（仍保留文件名进文本 `[图片：name]`，方便 agent 在回答里引用）。
- 选中非图片 → 维持现状（`[引用文件]` 文本 + 工具读取）。

### 对话气泡

- 发送时用户气泡渲染缩略图（前端此时手上有图：clipboard 的 base64、file/workspace 的路径可生成 object URL 或经 sidecar 取缩略）。
- `Msg`（user）类型加可选 `images?: { name: string; thumb: string }[]`，**不入库**。
- 入库文本前缀一行 `[已附图片：a.png, b.jpg]`，让重载后的气泡有交代（图片本身不重载——单轮有效是设计意图）。

### attachment-store 扩展

现状 `pending: string[]`（仅工作区文件名）。需区分图片附件与文件引用两类。方案：新增并行字段 `images: ImageAttachment[]`（三种来源的描述符），`pending` 维持文件名引用语义。`add/remove/clear` 对应扩展。`buildMessage` 把 images 序列化进 `/api/chat` 的 `attachments` 字段（与文本 content 分离）。

## 持久化与暂存生命周期

- **会话持久化**：`/api/conversations/{cid}/turns` POST 存的 user 消息仍是 `{role, content}` 纯文本。带图时 content 前缀 `[已附图片：a.png, b.jpg]`。`Msg.images` 不随 turns 入库（单轮有效）。
- **暂存目录** `<app_data>/image-staging/`：仅剪贴板粘贴用到。sidecar 启动时清空残留（上次会话遗留的孤儿文件）；不做逐次清理（best-effort，启动清理已能控增长，且图片随发送即用完）。

## 允许格式与约束

- **格式**：SDK 的 `_IMAGE_EXTS = (".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp")`。bmp 个别服务商可能拒，但与 SDK 保持一致。
- **MIME**：路径用 `mimetypes.guess_type`，未知默认 `image/png`；前端从 blob.type / 扩展名带 `mime`。
- **大小上限**：单张 ≤ 10MB（sidecar `os.path.getsize` 权威校验；前端对 clipboard/drag 已知 size 时 best-effort 预拒）。
- **`file_id`**：`uuid4()`。

## 错误处理

| 场景 | 行为 |
|------|------|
| 单张 > 10MB | yield `error` 事件「图片过大（>10MB）：name」，跳过该附件 |
| 非图片扩展名 | 前端不入栈；后端兜底拒绝 |
| workspace 路径越界 | yield `error` 事件「图片不在工作区内」，跳过 |
| 文件读取失败 | yield `error` 事件，跳过 |
| 非视觉模型强行带图 | 后端 yield `error`「当前模型不支持图片输入」 |
| 剪贴板 webview 不给 blob | 回落 Tauri clipboard-manager 插件；都失败则 toast 提示 |

## 测试计划

### 后端（pytest，`sidecar/tests/`）

- 三种描述符（workspace / file / clipboard）→ 正确解析成 `Attachment`（断言 `path`/`kind=="image"`/`mime`）。
- workspace 越界路径（`../../etc/passwd`）→ 拒绝。
- 单张超 10MB → 拒绝并跳过、不中断其他附件。
- 非视觉模型 + attachments → 拒绝。
- clipboard base64 → 正确写入暂存目录、文件可读。
- sidecar 启动 → 清空 `image-staging/` 残留。

### 前端（vitest）

- 非视觉模型 → 三入口禁用 + tooltip 文案。
- 粘贴 / 拖拽 → 图片入 images 栈 + 缩略 chip + 移除。
- `buildMessage` 带图 → `/api/chat` body 含 `attachments` 字段、`content` 为纯文本。
- 模型切换 → `supportsVision` 联动入口可用性。
- 流式中 → 图片入口禁用。

### 集成（`npm run tauri dev` 手测）

- 配 GLM-5 → 粘贴水文图表截图 + 「分析这张图的洪峰流量」→ 模型正确读图作答。
- 切到 DeepSeek 聊天模型 → 入口置灰、tooltip 出现。
- 拖拽 workspace 内 PNG + `@` 引用 → 双通道都生效。
- 发送后切换会话再切回 → 用户气泡显示 `[已附图片：...]` 文本标记，无图（单轮有效）。

## 受影响文件（预估）

**后端**
- `sidecar/floodmind_desktop_sidecar/floodmind_agent.py` — `stream()` 解析 attachments、归一化、构造 SDK Attachment、size/越界/vision 校验。
- `sidecar/floodmind_desktop_sidecar/app.py` — `/api/chat` 接收 `attachments` 字段；`/api/config/model` GET 返回 `supportsVision`；启动清理 `image-staging/`。
- `sidecar/floodmind_desktop_sidecar/config_api.py` — 保存路径写 `supports_vision`；model GET 计算 vision 能力。

**前端**
- `src/lib/providers.ts` — `CuratedModelDef.supportsVision` + 各模型标记。
- `src/state/config-store.ts` — `ModelConfig.supportsVision`；save 写入。
- `src/state/attachment-store.ts` — `images` 字段 + add/remove/clear。
- `src/state/chat-store.ts` — `send()` 传 attachments；`Msg.images`；入库文本前缀。
- `src/lib/chat-stream.ts` — `streamChat` 接受 attachments 参数、POST body 携带。
- `src/components/Composer.tsx` — 图片 chip、拖拽高亮、paste 监听、vision 门禁、流式中禁用。
- `src/components/ComposerFilePicker.tsx` / `FilePickerModal.tsx` — 图片文件视觉区分 + 分叉。
- `src/components/Conversation.tsx` — 用户气泡缩略图渲染。
- `src/app.css` — 图片 chip、拖拽高亮样式。

## 非目标（YAGNI）

- ❌ 图片客户端压缩 / 重采样（服务商端降采样已足够）。
- ❌ 图片跨轮次持久化（单轮有效是设计意图）。
- ❌ mid-run 追加图片。
- ❌ 视频输入。
- ❌ 多图批量优化（单次发送多图支持，但无特殊批处理）。
