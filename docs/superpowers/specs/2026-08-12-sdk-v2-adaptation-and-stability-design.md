# Design: SDK v2.0.0 桌面端适配 + Harness 稳定性硬化

日期：2026-08-12
状态：approved

## Context

FloodMind SDK 从 v1.1.9 大版本升级到 **v2.0.0**（forward-only Journal 架构迁移、事件/记忆重构、删除 web/TUI 前端）。桌面端（Tauri 2 + React + Python sidecar）需要适配到新 SDK，并**真实跑各类任务压 harness、优化工程与稳定性**。

### 铁律（用户约束）
- **SDK 侧问题 → 反馈给用户修，桌面端绝不改 SDK**。
- SDK 未完善处 → 桌面端**加外层壳**，后续 SDK 完善后去壳。
- **SDK 只允许来自 dev 仓库 `https://github.com/dancepandas/FloodMind.git`**（当前 pin `@main`，本地装包用代理下载分支 tarball——git+ partial-clone 在本机必失败）。
- 文档以 dev 仓库最新文档为准，而非 tag 同步文档。

### 探索结论（已确认）
- v2.0.0 main 分支（`4e42794`）修复了 `approve_unresolved_exec_writes` 等 3 个缺失符号的 import 阻断。
- 核心事件类型保留：`answer_delta`（token）、`thought_delta`（reasoning）、`action_start`/`action_end`（tool）→ 桌面端 `translate_event` 兼容。
- `resolve_model` 的「静默错配回退」bug（MiniMax-M3/openai → deepseek-v4-pro）在 v2.0.0 main 已修复。
- 桌面端 sidecar 测试在 v2.0.0 上：**226 过 / 3 败**（3 个都是测试侧问题）。
- 后台任务服务 API 变更：`get_background_task_service()` 全局单例 → `BackgroundTaskService(base_dir=...)` 绑定到 agent（`raw._background_task_service`）。

## 阶段一：v2.0.0 适配

### 1. SDK 依赖 pin
- `sidecar/pyproject.toml`：`floodmind @ git+https://github.com/dancepandas/FloodMind.git@main`。

### 2. 修复 3 个测试（均为测试侧）
- `test_config.py::test_read_seeds_template_when_no_settings`：v2.0.0 种子模板不再含 `dashscope` provider → 更新断言。
- `test_floodmind_agent.py::test_mcp_call_health_tracks_outcome`：v2.0.0 MCP health 跟踪行为变化 → 更新断言。
- `test_floodmind_agent.py::test_mcp_tool_names_sanitized_for_openai_endpoints`：`FakeConn` 缺 `transport` 属性 → mock 补 `transport`。

### 3. 后台任务生产代码加壳
- `floodmind_agent.list_background_tasks()` / `kill_background_task()` 目前用 `get_background_task_service()`（v2.0.0 不存在）。
- 改为从 `agent.raw._background_task_service` 取（`getattr` 兜底，None 时返回空 / False）。
- SDK 后续暴露公共访问后去壳。

### 4. 全量回归 + 冒烟
- sidecar 全量测试 + 前端 `npm test` + `npm run build`。

## 阶段二：多开各类任务实验 + 稳定性硬化

真实跑一批覆盖性任务压桌面端，每类观察事件流转、UI 状态、产物、稳定性：

| 实验类 | 覆盖点 |
|---|---|
| 对话/推理 | 多轮 思考→工具→中间回答→最终回答（`thought_delta`/`answer_delta`、「模型思考中」指示、循环折叠交互） |
| 工具类 | 文件读写/搜索/Bash（含 `run_in_background` 后台 shell + 任务面板） |
| MCP | hydro-rag / chronos / ocr-table 三类外部服务 |
| 外部文件授权 | 工作区外文件拖入/预览/读取授权 |
| 定时任务 | 创建/立即运行/运行历史 |
| 多会话并发 | 新任务切换、空会话清理 |
| 稳定性 | 长任务中断、断流、重复发送、权限 ask 流、后台任务轮询 |

### 处理原则
- 桌面端 harness 问题（事件丢 / UI 错 / 状态错 / 竞态）→ **直接修**。
- SDK 行为 bug / 缺能力 → **反馈给用户**（不改 SDK）。
- SDK 未完善接口 → 桌面端**加外层壳**，SDK 完善后去壳。

## 交付物
- 每类任务的实验结果 + 问题清单（桌面端修的 / SDK 反馈的）。
- harness 稳定性改进（代码 + 测试）。

## 验证
- 阶段一：sidecar 测试全绿（目标 229 个全过）、前端测试全绿、build 通过。
- 阶段二：每类实验冒烟通过；发现的问题全部处理（桌面端修或 SDK 反馈）；回归全绿。
