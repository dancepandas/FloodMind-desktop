# Design: SDK 能力释放路线图（桌面端逐步推进）

日期：2026-08-13
状态：approved

## Context

用户要求「考虑怎么充分释放 SDK 的能力」，确认落点在**桌面端产品功能**，方式为**先盘点再定**。经 SDK v2.0.3 能力全景盘点（Explore 勘察 + sidecar import 对照）后，用户决定**全部加上，按轻重缓急逐步推进**。

### 关键洞察

桌面 sidecar 使用完整运行时 `Agent(bare=False)`，因此大量 SDK 能力**已在底层生效**，真正的缺口是**桌面无可见性/控制面**，外加少数桌面未接通的能力：

- 已生效但无 UI/控制：经验捕获、技能自动生成、渐进式工具加载、插件发现、agent 档案、ContextRuntime、记忆工具、provider codec。
- 未接通：`resume()`/`events_after()` 断点续跑与重连对账、`build_agent_tool` 自定义工具、跨会话全文搜索。

## 路线图（按轻重缓急）

每个阶段是一条独立功能，各自走 **spec → plan → 实现** 周期；本 master spec 只锁定排序与范围边界，细节在各自 spec 细化。

### 阶段 1 — 可靠性与恢复（最高价值，独立）
**断点续跑 + 重连对账**：`Agent.resume(checkpoint_id)` + `events_after(sequence)`。
- sidecar：checkpoint 列表/详情、resume 端点、events_after 游标端点。
- 前端：崩溃/断连后从 checkpoint 继续；流重连后按 sequence 对账（预览态与已提交事件调和）。
- 定位：桌面睡眠/重启/渲染进程重载是常态，恢复能力最贴合、差异化最强。

### 阶段 2 — 记忆与经验（复合增值，最大差异化）
- **经验库**：`TaskExperienceStore`/`ExperienceTree` 暴露为可浏览/搜索案例树（坑、解法、成功率、热度、反馈、归档、维护统计）+ 捕获开关。
- **建议技能**：经验分支达标 → `skill_generator` 生成 draft skill → 审阅/编辑/安装/拒绝（依赖经验库）。

### 阶段 3 — 可扩展性
- **插件管理器**：`FloodmindPlugin` 列出/启用/禁用/加载错误（受信代码提示）。引擎已自动发现，UI 为主。
- **自定义工具**：`build_agent_tool` 宿主定义本地动作（表单 schema/风险/权限策略）注入 agent。
- **技能画廊**：内置技能全套（docx/pdf/pptx/csv/xlsx/data-analysis/plotting/mcp-builder/skill-creator/doc-coauthoring）能力卡、依赖、脚本、拖文件触发。

### 阶段 4 — 诊断与透明
- **工具目录面板**：`ToolLoader` 目录 vs 已加载、只读/破坏性标记、schema 预算。
- **上下文检查器**：`ContextRuntime` 进模型的规则/记忆/环境块 + token 预算。
- **模型连接诊断**：provider codec 路由、推理方言、媒体限制（能力徽章来自模型元数据而非 codec 推断）。

### 阶段 5 — 收尾
- **跨会话全文搜索**：`GlobalSearch`（核对旧布局适配）。
- **plotting 高清图**：`configure_plotting` 一次配置中文字体/300DPI（可选开关）。

## 约束（不变量）

- 桌面端**绝不改 SDK**；SDK 侧问题反馈给用户修；未完善接口桌面加外层壳。
- 每个功能独立可验收：sidecar 单测 + `npm test` + `npm run build` 全绿。
- 功能之间不互相阻塞（阶段 2 内「建议技能」依赖「经验库」除外）。

## 交付物

- 本 master spec 提交入库。
- 逐阶段产出独立 spec → plan → 实现，按顺序推进。
