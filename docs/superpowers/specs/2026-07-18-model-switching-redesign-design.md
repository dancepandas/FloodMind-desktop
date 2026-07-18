# 模型管理与切换重构 — 设计文档

**日期：** 2026-07-18
**状态：** 待评审
**范围：** FloodMind Desktop（Tauri 2 + React 19 + TS 前端 / Python Flask sidecar）

## 目标

把模型切换从"设置页深埋、全局唯一、composer 标签是死元素"的当前形态，重构为主流 Agent（Cursor / Roo / Copilot / Claude Code）共识的形态：**composer 输入框下方一键下拉切换 + 设置页做可定制的供应商/模型目录管理**。同时解除"模型列表被代码写死"的限制——任何供应商都可增删模型。

## 背景：当前实现的痛点（已调研确认）

1. 切模型必须进设置页 → 滚动 provider 卡片 → 选 radio → 保存并重载 → 回聊天，7+ 次点击。
2. composer 模型标签是死 `<span>`（`Composer.tsx:416`），点击无反应。
3. 全局唯一模型，无"按会话绑定"。
4. `enableReasoning`、`temperature` 在数据模型里存在、已传给 agent，但前端无任何开关。
5. 只有 openai/ollama 可增删模型；其余 5 家（deepseek/zhipu/moonshot/qwen/minimax）模型写死在 `providers.ts`。
6. 潜在 bug：`config-store.ts:226` `model: data.model?.model ?? null`——`data.model` 是 `ModelConfig` 对象，`.model` 取到的是模型名字符串，导致每次设置保存后 store 的 `model` 塌成字符串，直到下次 `load()` 才恢复。

## 非目标（YAGNI，本轮不做）

- Profiles / Modes（Roo 风格的"模型+设置"捆绑预设）。
- "Auto" 智能路由（需要路由策略，复杂）。
- 模型 fallback 链（Claude Code 独有，后续差异化机会）。
- `enableReasoning` / `enableSearch` / `temperature` 的前端开关 UI（属"完整"范围，本轮只顺手修上述 bug）。
- 收藏/置顶排序（以"启用集"自然替代——不勾的就不出现）。

## 设计

### 1. 数据模型

**`~/.floodmind/settings.json`**（`desktop` 块新增 `enabledModels`；`providers.<id>.models[]` 成为用户可定制的权威目录）：

```jsonc
{
  "providers": {
    "qwen": {
      "name": "通义千问",
      "base_url": "https://dashscope.aliyuncs.com/compatible-mode/v1",
      "api_key": "sk-...",
      "models": [
        { "id": "qwen3.7-plus", "context_window": 1000000, "default_max_tokens": 131072, "supports_vision": true },
        { "id": "my-custom-qwen", "default_max_tokens": 8192 }   // 用户自加
      ]
    }
    // ...其余 provider 同构，均可增删
  },
  "desktop": {
    "activeModel": "qwen3.7-plus",
    "activeProvider": "qwen",
    "enabledModels": [                          // 新增：勾选进下拉的模型集合
      { "provider": "qwen", "model": "qwen3.7-plus" },
      { "provider": "moonshot", "model": "kimi-2.6" }
    ],
    "enableReasoning": false,
    "enableSearch": false
  }
}
```

要点：
- **目录权威化**：`providers.<id>.models[]` 由用户拥有（首轮从 `CURATED_PROVIDERS` 播种；之后以保存值为准）。增删都改这里。
- **启用集** `desktop.enabledModels` 是扁平的 `{provider, model}` 列表，desktop 专属，不污染 SDK 的 models 数组。下拉只列这里的模型，按 provider 分组。
- **活动模型** `desktop.activeModel/activeProvider` 仍保留，但只由 composer 下拉写入（"总是顺带"语义）。

**每会话模型覆盖**——桌面侧文件 `<app_data>/conversation_meta.json`，全局 map：

```jsonc
{ "conv-4c04c220a99a": { "provider": "qwen", "model": "qwen3.7-plus", "updatedAt": "..." } }
```

convId 即 session_id，全局唯一，单文件即可。不碰 SDK session 存储。

### 2. 活动模型解析规则

composer 标签显示的"当前模型"，按优先级解析：

1. 当前打开的会话在 `conversation_meta.json` 有绑定 → 用它。
2. 否则 → `desktop.activeModel/activeProvider`（全局默认）。
3. `activeModel` 不在 `enabledModels` 里（如用户取消了勾选）→ 回退到 `enabledModels` 第一个。
4. 启用集为空 → 显示"未配置模型"，下拉邀去设置。

新会话继承全局默认（规则 2/3）。重开旧会话：若其绑定模型与 agent 当前模型不同 → 触发 agent reload 到该模型（见 §5）。

### 3. 设置页「模型」tab — 重构

每家 provider 卡片改为（所有 provider 一视同仁，取消 `editableModels` 区分）：

```
┌ 通义千问  [文档] ──────────────────────────────────────┐
│  API Key [••••••••（留空保持原值）]                      │
│  模型                              💡勾选→进入输入框切换列表│
│   [✓] qwen3.7-plus   默认  👁  输出[128k▾]  🗑           │
│   [ ] qwen3.6-plus         👁  输出[64k▾]   🗑           │
│   [✓] my-custom-qwen          输出[8k▾]    🗑           │
│   [+ 模型名如 qwen3.8-turbo____________][添加]          │
│   [↻ 恢复官方推荐]                                       │
└─────────────────────────────────────────────────────────┘
```

- **勾选框**（替换原 radio）：勾选 = 加入 `enabledModels` → 出现在 composer 下拉。可跨多家、每家多个。
- **增**：每家底部"添加模型"输入框 → 任意 provider 都能加（不再限 openai/ollama）。
- **删**：每行 🗑 → 从目录真删（任何模型，含官方默认的）。删官方模型后可用"恢复官方推荐"找回。
- **每行可编辑元数据**：`maxTokens`（输出 token 下拉）+ `supportsVision`（👁 勾选）。所有 provider 一致（官方模型默认值来自 `CURATED_PROVIDERS`，可覆盖）。
- **Base URL**：仅 openai/ollama 可编辑（`editableBaseURL` 保留）。
- **"默认"标签**：只读显示哪个启用模型是当前 `activeModel`（不可在此改，改去 composer 下拉）。
- **"恢复官方推荐"**：把该 provider 在 `CURATED_PROVIDERS` 里、但用户目录中缺失的模型补回来（默认勾选）。
- **保存**：`保存并重载` 写整个目录 + enabledModels + active（若 active 因取消勾选失效则回退首个启用）并 reload agent。

> 这是设置页的**真改**（radio→checkbox、解锁增删），不是"只微调"——用户明确要求。

### 4. ModelPicker 向上弹出菜单（composer）

composer 底部模型标签 `<span>` → `<button>`，点击**向上**展开菜单（composer 处于屏幕底部，菜单必须朝上展开，不是朝下的下拉框）：

```
┌──────────────────────────────────┐
│  🔍 过滤…                         │
├──────────────────────────────────┤
│  通义千问                         │
│    ● qwen3.7-plus        👁       │  ← 当前
│      my-custom-qwen               │
│  月之暗面                         │
│      kimi-2.6            👁       │
├──────────────────────────────────┤
│  ⚙ 管理模型…   (跳设置)           │
└──────────────────────────────────┘
   ▲
[ qwen3.7-plus  ▾ ]   ← 可点
```

- 内容源：`enabledModels`，按 provider 分组（provider 组头仅当其有 ≥1 启用模型时出现）。
- 每行：模型名 + 👁（`supportsVision`）+ 当前打 ●。
- **限高 + 内部滚动**：菜单设 `max-height`（约 320–360px），列表区 `overflow-y: auto`；启用模型多时在菜单内部滚动查看，不整体撑高、不顶出屏幕。过滤框与底部"管理模型"固定，只有中间列表滚。
- provider 无 API key 的启用模型：置灰 + "需配置 Key"，点击只 toast 邀去设置，不切换。
- 键盘：↑/↓ 导航（滚动跟随选中项）、Enter 选、Esc 关、输入即过滤。
- streaming 时整个菜单禁用（与其它 composer 入口一致）。
- 底部"管理模型…"→ 跳设置模型 tab。
- 完全没配模型（启用集空）：标签显"未配置模型"，点击 → toast 邀去设置。

### 5. 切换数据流（"总是顺带"语义）

用户在下拉选模型 M(provider P)：

1. **乐观更新**：composer 标签立即 → M。
2. `PUT /api/conversations/<convId>/model` body `{provider:P, model:M}` → 写 `conversation_meta.json`。
3. `POST /api/config/active-model` body `{provider:P, model:M}` → 写 `desktop.activeModel/activeProvider` + `agent.reload_model()`（**轻量端点，只改 active + reload，不重写 providers 目录**，避免误伤目录/密钥）。
4. 三步成功 → 完成。reload 失败 → 回滚乐观状态 + toast（复用现有 `reloadFailed` 通路）。

> 为何新增轻量端点：现有 `POST /api/config/model` 会整体重写 providers 段，下拉快速切换不应背负这个风险与开销。设置页保存仍走重端点（要改目录/密钥/enabled）。

### 6. 重开历史会话 → 恢复其模型

打开会话 C：
1. `GET /api/conversations/<C>/model` → 绑定的 `{provider, model}` 或 null。
2. 若有绑定且与 agent 当前活动模型不同 → `POST /api/config/active-model` reload 到该模型。
3. composer 标签按 §2 规则解析显示。
4. reload 可能有亚秒级延迟 → 标签处显示极简 loading 态（如 "切换中…"），完成即恢复。

### 7. 顺手修 bug

`config-store.ts:226`：`model: data.model?.model ?? null` → `model: data.model ?? null`（`data.model` 本就是 `ModelConfig`）。加回归测试：保存后 `model` 仍是对象、`s.model.model` 可读。

## 边界与错误

- **启用集为空**：下拉不可用，标签"未配置模型"，toast 邀设置。
- **provider 无 key**：该 provider 下启用模型在下拉置灰 + 提示，不可选。
- **active 模型被取消勾选**：保存/解析时回退首个启用模型。
- **streaming 中**：下拉禁用。
- **reload 失败**：回滚乐观状态 + toast。
- **删模型后该模型是某会话绑定**：绑定记录保留（历史会话仍可恢复其模型名）；若该模型已不在任何目录，重开该会话时回退全局默认 + toast 提示"原模型已移除"。
- **自定义 openai/ollama 模型**：照常出现在各自 provider 组，走相同增删/勾选/元数据逻辑。

## 迁移与兼容

- 首次加载（`providers.<id>.models` 缺失或空）→ 从 `CURATED_PROVIDERS` 播种。
- 已有用户（settings.json 已含 models 列表）→ 原样作为权威目录。
- `enabledModels` 缺失 → 默认等于"所有当前目录模型"，保证升级后现有模型仍出现在下拉（不会因新字段丢失可用模型）。
- `CURATED_PROVIDERS` 仍保留，作为：① 首轮播种源 ② "恢复官方推荐"的数据源 ③ `editableBaseURL` 判定。`editableModels` 字段废弃（所有 provider 视为可增删）。

## 测试策略

**前端单测（vitest）：**
- `ModelPicker`：按 provider 分组渲染、👁 badge、当前打 ●、keyless 置灰、键盘导航、过滤、streaming 禁用、空启用集态。
- config-store：活动模型解析（会话绑定 > active > 首个启用 > 空）、`enabledModels` 缺失回退、save() 响应 bug 回归。
- SettingsView：勾选写 enabledModels、增删任意 provider 模型、恢复官方推荐、active 失效回退。

**sidecar（pytest）：**
- `GET/PUT /api/conversations/<id>/model` 往返 + meta 文件读写 + 缺失/并发容错。
- `POST /api/config/active-model`：只改 active + reload，不触碰 providers 目录/密钥（断言 providers 段不变）。
- `enabledModels` 读写、迁移播种逻辑。

**手测：**
- 聊天中下拉切模型即时生效；重开旧会话恢复其模型；新会话继承默认；keyless 置灰；streaming 禁用；设置页任意 provider 增删模型 + 勾选控制下拉可见性 + 恢复官方推荐。

## 文件改动地图（预估，实施计划细化）

**前端：**
- `src/lib/providers.ts` — `editableModels` 废弃/保留为兼容；新增"恢复官方推荐"所需的 curated 查询。
- `src/state/config-store.ts` — `enabledModels` 字段；活动模型解析；`switchActive(provider,model)` 调轻端点；修 save() bug；`mergeWithCurated` 调整为权威目录 + enabled 回退。
- `src/components/ModelPicker.tsx` — 新建向上弹出菜单组件（限高 + 内部滚动）。
- `src/components/Composer.tsx` — 标签改 `<button>` + 挂 ModelPicker。
- `src/components/SettingsView.tsx` — ModelTab 重构（checkbox / 增删全员 / 元数据 / 恢复推荐 / 默认只读标签）。
- `src/state/conversation-store.ts` / `chat-store.ts` — 会话加载时取绑定模型 + 触发 reload。
- `src/app.css` — picker / checkbox-row 样式。

**sidecar：**
- `config_api.py` — `enabledModels` 读写、`POST /api/config/active-model` 轻端点、迁移播种。
- `app.py` — `/api/conversations/<id>/model` GET/PUT 路由、`conversation_meta.json` 读写模块。

**测试：** 上述 vitest + pytest 用例。
