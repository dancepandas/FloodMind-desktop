# FloodMind Desktop 设计文档

> 版本：v1.0  
> 日期：2026-07-08  
> 状态：待评审  

---

## 1. 背景与目标

### 1.1 产品定位

FloodMind Desktop 是 **FloodMind SDK 的本地桌面客户端**，定位为“常驻桌面的智能任务助手”。它面向日常工作场景：

- 自然语言发起任务（报告生成、数据分析、知识库问答、定时任务等）
- Agent 自动规划、调用工具、跟踪进度
- 输出文档、图表、临时脚本等制品
- 长期记忆与经验复用
- 定时任务后台执行

**它不是代码助手**，因此不包含复杂代码编辑、diff 审查、IDE 式多窗格工作区。

### 1.2 设计原则

1. **Desktop-native**：充分利用桌面端能力（本地文件系统、全局快捷键、系统托盘、原生通知），不做 Web 端的窗口化移植。
2. **Workspace 为中心**：所有工作围绕本地目录（Workspace）展开，减少 Agent 搜索空间。
3. **不复用 Web 前端产物**：UI 风格可与 FloodMind Web 保持一致，但交互逻辑针对 desktop 重新设计。
4. **轻量可分发**：PyTorch 等重依赖不打包进桌面端，模型预报类 skill 通过 MCP 或用户自装方式接入。
5. **进程隔离**：Python Agent Runtime 作为 sidecar 子进程运行，崩溃不影响桌面窗口。

---

## 2. 架构总览

```
┌─────────────────────────────────────────────────────────────────────┐
│  Tauri 2.x 桌面壳（Rust）                                            │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │  React 19 + Vite 前端（专为 desktop 设计）                     │    │
│  │  - Quick Launcher（全局唤起）                                  │    │
│  │  - 主窗口：Workspace / 会话 / 聊天 / 右侧面板                 │    │
│  │  - EventSource 消费 SSE 流                                    │    │
│  └─────────────────────────────────────────────────────────────┘    │
└──────────────────────────────┬──────────────────────────────────────┘
                               │ spawn sidecar
            bundle.externalBin │
┌──────────────────────────────▼──────────────────────────────────────┐
│  Python Sidecar（裁剪后的 FloodMind）                                │
│  - 移除打包的 PyTorch                                               │
│  - 模型预报 skill 外置（MCP / 用户自装）                            │
│  - Flask 暴露 HTTP API（SSE/NDJSON）                                │
│  - 监听 127.0.0.1:<动态端口>                                         │
└─────────────────────────────────────────────────────────────────────┘
```

### 2.1 关键架构决策

| 决策 | 选择 | 理由 |
|---|---|---|
| 桌面壳 | Tauri 2.x | 轻量、原生 WebView、官方支持 Python sidecar |
| 前端框架 | React 19 + Vite 7 | 生态成熟，与 Tauri 整合最好 |
| 后端集成 | Python HTTP Sidecar | FloodMind SDK 是 Python；Tauri 官方推荐此模式 |
| 流式传输 | SSE / NDJSON over localhost HTTP | 复用 FloodMind 现有协议，WebView 原生支持，不经过 Tauri IPC |
| Python 打包 | PyInstaller `--onedir` | Tauri 官方示例，无 torch 后体积可控 |
| 前端复用 | 不复用 Web 端组件/逻辑 | Web 与 desktop 交互逻辑差异大 |

---

## 3. 技术栈

### 3.1 桌面端

- **Shell**: Tauri 2.x（Rust 1.85+）
- **UI**: React 19 + TypeScript
- **构建**: Vite 7
- **样式**: TailwindCSS 4（与 FloodMind Web 风格可统一，但组件独立实现）
- **状态管理**: Zustand（轻量、TypeScript 友好，足够支撑本应用状态）
- **路由**: 简单状态路由，不引入重型 router
- **流式**: 原生 `EventSource` + `fetch` streaming
- **Tauri Plugins**:
  - `@tauri-apps/plugin-shell` — sidecar 管理
  - `@tauri-apps/plugin-dialog` — 系统文件选择/保存
  - `@tauri-apps/plugin-fs` — 受限文件系统访问
  - `@tauri-apps/plugin-notification` — 系统通知
  - `@tauri-apps/plugin-global-shortcut` — 全局快捷键

### 3.2 后端 Sidecar

- **Runtime**: Python 3.10+
- **Framework**: 复用 FloodMind 现有 Flask HTTP API
- **Agent**: `floodmind.agent.create_flood_agent`
- **Memory**: 复用 FloodMind 双层记忆，但按 Workspace 隔离存储
- **Skills**: 内置轻量 skill；重算力 skill（如模型预报）通过 MCP 或用户自装接入

---

## 4. Workspace 设计

### 4.1 定义

Workspace 是 **本地文件系统目录与 FloodMind 会话上下文的绑定**。一个 Workspace 对应一个用户工作目录。

### 4.2 作用

- 限定 Agent 的默认工作目录，减少搜索空间
- 隔离会话历史、长期记忆、产物、定时任务
- 支持项目级行为规则（`workspace/AGENTS.md`）
- 文件读写默认在 Workspace 内进行

### 4.3 目录结构

```
my-workspace/
├── AGENTS.md                 # 项目级行为规则（可选）
├── .floodmind/
│   ├── sessions/             # 会话历史
│   ├── memory/               # 长期记忆（按 workspace 隔离）
│   ├── outputs/              # 产物输出
│   ├── backups/              # 文件修改备份
│   ├── scheduled-tasks.json  # 定时任务配置
│   └── settings.json         # workspace 级设置
└── <用户原始文件...>
```

### 4.4 交互

- **首次启动**：欢迎页提示“创建工作区”或“打开现有文件夹”，使用 Tauri `dialog.open({ directory: true })` 选择目录。
- **Workspace 切换**：顶部标题栏或左侧边栏显示当前 Workspace，支持下拉切换、最近列表、多 Workspace 打开。
- **新建会话**：默认继承当前 Workspace 上下文。
- **文件操作**：Agent 默认在 Workspace 内搜索和写入文件；操作 Workspace 外路径需权限确认。

---

## 5. 前端交互设计

### 5.1 快速唤起（Quick Launcher）

- 全局快捷键（默认 `Alt + Space` / `Cmd + Shift + F`）
- 屏幕中央浮动输入框
- 输入后：简单任务后台执行并通知；复杂任务打开主窗口展示进度

> Quick Launcher 是否纳入 MVP 待定，见第 11 节。

### 5.2 主窗口布局

```
┌─────────────────────────────────────────────────────────────────────┐
│  标题栏：当前 Workspace ▼    [全局搜索] [设置] [最小化] [关闭]        │
├─────────────┬───────────────────────────────┬───────────────────────┤
│             │                               │                       │
│ 左侧边栏    │      中间聊天主区              │      右侧面板         │
│             │                               │                       │
│ - Workspace │  - 流式 Markdown 输出         │  - Todo / 任务进度    │
│   切换      │  - 工具调用卡片                │  - 制品列表           │
│             │  - 输入框                     │  - 记忆搜索           │
│ - 会话历史  │                               │  - 定时任务           │
│   （按日期）│                               │                       │
│             │                               │                       │
│ - 收藏制品  │                               │                       │
│ - 定时任务  │                               │                       │
│             │                               │                       │
└─────────────┴───────────────────────────────┴───────────────────────┘
```

### 5.3 聊天与流式输出

- 用户输入在底部，Assistant 输出在上方
- 流式 Markdown 渲染，支持图表/图片内嵌
- 消息支持复制、重新生成、分支

### 5.4 工具调用可视化

每个工具调用以紧凑卡片展示：

- 工具名
- 参数摘要（可展开）
- 状态：运行中 / 成功 / 失败
- 结果预览
- 耗时

### 5.5 任务与 Todo

- Agent 自动将任务拆解为 Todo
- 右侧面板实时展示 Todo 进度
- 长任务可最小化到托盘后台执行
- 完成后弹系统通知

### 5.6 制品处理

- 文档/图表/脚本等产物自动保存到 `workspace/.floodmind/outputs/<date>/`
- 制品卡片提供：打开、打开所在位置、另存为、删除
- 临时脚本提供：运行、保存、丢弃

### 5.7 记忆与知识库

- `Ctrl/Cmd + K` 快速搜索长期记忆
- RAG 结果展示来源片段
- 经验树按 Workspace / 标签简化展示

### 5.8 定时任务

- 配置重复任务或一次性任务
- 托盘悬停显示下次执行时间
- 最近执行记录和产物路径一目了然

---

## 6. 本地文件操作

桌面端**不采用“文件上传”模式**，而是直接操作本地文件系统。

### 6.1 读取文件

| 方式 | 实现 |
|---|---|
| 拖拽文件到窗口 | Tauri drag-drop 事件获取路径 |
| 点击“选择文件” | Tauri `dialog.open()` 系统选择器 |
| 直接输入路径 | 高级用户粘贴绝对/相对路径 |
| Agent 主动读取 | Agent 在 Workspace 内搜索所需文件 |

传给后端的是**文件路径**，Python sidecar 作为本地进程直接读取。

### 6.2 写入/编辑文件

- Agent 生成的文档直接保存到 Workspace 输出目录
- 编辑已有文件：用户批准后，Python sidecar 直接写回
- 写回前在 `workspace/.floodmind/backups/` 保留备份
- 保存到其他位置使用 Tauri `dialog.save()`

### 6.3 打开文件/文件夹

- 使用 Tauri `shell.open()` 调用系统默认程序
- 提供“在文件夹中显示”按钮

---

## 7. 后端集成

### 7.1 Sidecar 启动流程

1. Tauri 启动时寻找一个空闲端口（`127.0.0.1:0`）
2. 使用 `tauri-plugin-shell` 启动 Python sidecar，传入端口参数
3. Sidecar 启动后打印 `READY <port>` 到 stdout
4. Rust 读取端口后告知前端 base URL
5. 前端通过 `EventSource` 连接 `/api/chat`

### 7.2 通信协议

| 场景 | 协议 | 说明 |
|---|---|---|
| 流式聊天 | SSE / NDJSON | 复用 FloodMind `/api/chat` |
| 非流式 RPC | HTTP `fetch` | sessions、memory、todos、token-usage 等 |
| 窗口/系统控制 | Tauri `invoke` / `emit` | 通知、托盘、全局快捷键 |
| 文件选择/保存 | Tauri `dialog` | 只有前端能调用原生系统对话框 |

### 7.3 裁剪后的 FloodMind

桌面端 sidecar 运行的 FloodMind 是裁剪版：

- 不内置 PyTorch
- 不内置模型预报 skill
- 保留：Agent Runtime、Skill 系统、Memory、Todo、定时任务、RAG 知识库接入、MCP 客户端
- 模型预报 skill 通过 MCP Server 或用户本地 pip 安装接入

---

## 8. 数据流

```
用户输入
   ↓
Quick Launcher / 主窗口
   ↓
POST /api/init 或 /api/chat
   ↓
Python Sidecar 执行 Agent 循环
   ↓
SSE 流返回事件：
   - text                  → 渲染到聊天流
   - tool_call             → 渲染工具卡片
   - todo                  → 更新右侧面板进度
   - artifact              → 显示制品 + 系统通知
   - permission_request    → 显示底部审批条
   - error                 → 显示错误 + 可重试
```

---

## 9. 安全与权限

### 9.1 权限分类

- **文件写入/删除**：需确认，可记忆规则
- **脚本/Bash 执行**：始终需确认（危险操作）
- **外部 MCP / API 调用**：首次需确认，可记忆
- **Workspace 内文件读取**：默认允许
- **Workspace 外文件读取**：需确认

### 9.2 权限响应

每条权限请求提供三种响应：

- **本次允许**
- **始终允许（本 Workspace）**
- **拒绝**

### 9.3 安全机制

- Sidecar 仅监听 `127.0.0.1`，不暴露公网
- Tauri capabilities 限制前端可访问的 fs 范围
- Workspace 外路径操作必须经用户确认
- 文件编辑前自动备份

---

## 10. 打包与分发

### 10.1 Sidecar 打包

- **默认方案**：PyInstaller `--onedir`
- **备选方案**：`python-build-standalone` + uv
- 无 PyTorch 后，sidecar 体积约 **50–150 MB**

### 10.2 安装包

Tauri 原生支持：

- Windows：`.msi` / `.exe`
- macOS：`.dmg` / `.app`
- Linux：`.AppImage` / `.deb`

### 10.3 代码签名与自动更新

- 正式发版需代码签名（Windows Authenticode、macOS Notarization）
- 使用 Tauri updater plugin 实现自动更新

---

## 11. MVP 范围

### 11.1 必须有（MVP）

- [ ] Tauri 2 + React 19 桌面壳
- [ ] Python sidecar 启动与生命周期管理
- [ ] Workspace 创建/打开/切换
- [ ] Workspace 内会话历史隔离
- [ ] 主窗口聊天 + SSE 流式输出
- [ ] 工具调用/Todo 进度可视化
- [ ] 本地文件直接读写（拖拽、选择、路径）
- [ ] 产物保存到 Workspace 输出目录
- [ ] 基础权限确认（文件写、脚本执行、外部调用）
- [ ] 系统托盘 + 全局快捷键 + 原生通知
- [ ] Windows / macOS 安装包（Linux 打包可放二期）

### 11.2 二期

- [ ] Quick Launcher
- [ ] 长期记忆搜索
- [ ] 定时任务配置
- [ ] MCP Server 可视化配置
- [ ] 模型预报 skill 作为 MCP 接入
- [ ] 多 Workspace 多窗口
- [ ] 深色/浅色主题
- [ ] 自动更新

---

## 12. 待确认事项

以下事项已有推荐方案，如无异议将在实现计划中按推荐执行：

1. **模型预报 skill 外置方式**：推荐作为 **MCP Server** 接入（FloodMind 已内置 MCP 客户端）。
2. **Quick Launcher 是否纳入 MVP**：推荐放在**二期**，MVP 先保证主窗口 + sidecar + Workspace 稳定。
3. **前端状态管理库**：已确定为 **Zustand**。
4. **全局快捷键默认值**：`Alt + Space` 在 Windows 上可能与系统快捷键冲突，建议改为 `Ctrl + Shift + F` / `Cmd + Shift + F`，或在设置中可自定义。

---

## 13. 参考与来源

- [Tauri v2 Sidecar 文档](https://v2.tauri.app/develop/sidecar/)
- [Tauri Shell Plugin](https://tauri.app/plugin/shell/)
- [Claude Code Desktop Docs](https://code.claude.com/docs/en/desktop)
- [Claude Code Permissions](https://code.claude.com/docs/en/permissions)
- [OpenCode Desktop Electron 迁移](https://www.agentupdate.ai/news/opencode-desktop-moves-to-electron/)
- [OpenAI Codex CLI Reference](https://developers.openai.com/codex/cli/reference)

---

*文档待评审。评审通过后将进入实现计划阶段。*
