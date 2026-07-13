# Persona & Rules Editing — SOUL.md + 全局 AGENTS.md

> 日期: 2026-07-13
> 范围: FloodMind Desktop（Tauri + React sidecar），不改 SDK
> 所属 backlog: "释放所有 SDK 能力" → A 组（身份与规则）

## 1. 问题与目标

FloodMind SDK 用两个文件塑造 agent 的长期行为，桌面端目前都没有 UI，用户只能手改磁盘文件：

- `~/.floodmind/SOUL.md` — 智能体**身份**（"你是谁、职责、特质"），系统提示词最高优先级层。
- `~/.floodmind/AGENTS.md` — 全局**行为规则/偏好约束**（绘图风格、文档模板、用词偏好等）。

目标：在"设置"页提供这两个文件的编辑入口，保存后**立刻对后续对话生效**，无需重启。

## 2. 已核实的 SDK 事实（设计依据）

- 桌面端跑的是 `NativeFloodAgent` **full mode**（非 bare）。`_build_stable_prompt()` 用 `load_soul_md() or DEFAULT_FLOODMIND_IDENTITY` 组装身份层 → **SOUL.md 真生效**。
- 桌面端 `_build_agent` 传给 `create_flood_agent` 的 `system_prompt=...` 在 full mode 下**被静默忽略**（只有 bare 模式才用），无法当杠杆，本设计不依赖它。
- `floodmind/profile/soul.py`：
  - `load_soul_md()` 读 `get_floodmind_home()/SOUL.md`，缺失/空返回 `None`，超 `SOUL_MD_MAX_CHARS=20000` 截断并 warning。
  - `DEFAULT_SOUL_MD` 常量（默认身份文本）。
  - `seed_default_soul()`：文件不存在时写默认值（`NativeFloodAgent.__init__` 调用，故首次建 agent 后文件必存在）。
- `floodmind/agent/context_runtime.py:load_project_rules()`：读 `get_floodmind_home()/AGENTS.md`（全局）+ `Path.cwd()/AGENTS.md`（项目级），结果缓存（TTL=`project_context_ttl`），注入 system prompt 的 PROJECT 层。
- 重建 `NativeFloodAgent` = 新 `ContextRuntime` = AGENTS.md 缓存自然清空；`_init_executors()` 重跑 `_build_stable_prompt()` 会重读 SOUL.md。
- **路径不一致警告**：`tools/agent_tool.py:get_agents_md_path("global")` 返回遗留路径 `~/.config/floodmind/AGENTS.md`（agent 自己的 `UpdateProjectInstructions` 工具用），与运行时注入的 `~/.floodmind/AGENTS.md` **不是同一个文件**。本设计**只编辑 `~/.floodmind/AGENTS.md`**（运行时生效那份），不动遗留路径。

## 3. 架构

三个改动点，各一个清晰职责：

```
SettingsView (React)  ──tab: 模型 | 身份 | 规则──
       │ fetch
config-store (Zustand) ── persona 切片：load/saveSoul/saveAgents/resetSoul
       │
sidecar config_api.py ── read/write_soul / read/write_agents_md（纯文件 IO）
       │
app.py 路由 ── GET/POST /api/config/{soul,agents}
       │ 写盘后
FloodMindAgent.reload_persona() ── 重建 agent → 下一条消息即用新身份/规则
```

## 4. 后端（sidecar）

### 4.1 `config_api.py`（在现有文件里加函数）

```python
SOUL_MAX_CHARS = 20_000  # 与 SDK SOUL_MD_MAX_CHARS 对齐

def read_soul() -> dict:
    """返回 {content, isDefault, path}。文件缺失 → 返回 DEFAULT_SOUL_MD + isDefault=True。"""

def write_soul(content: str) -> dict:
    """trim；空串 → 删除文件（回到默认）；>20000 字符 → raise ValueError。
    返回 {content, isDefault, path}。"""

def read_agents_md() -> dict:
    """返回 {content, path}。文件缺失 → content=''。"""

def write_agents_md(content: str) -> dict:
    """trim；空串 → 删除文件。返回 {content, path}。"""
```

- 全部用 `get_floodmind_home()` 定位文件（`from floodmind.config.settings import get_floodmind_home`）。
- `DEFAULT_SOUL_MD` 从 `floodmind.profile.soul` import，不复制常量。
- 写盘 `write_text(encoding="utf-8")`；删除用 `unlink(missing_ok=True)`。
- 纯函数 + 显式异常，不 import agent，便于单测（monkeypatch `get_floodmind_home` 指向 tmp）。

### 4.2 `app.py` 路由（4 个）

```
GET  /api/config/soul    → read_soul()
POST /api/config/soul    → write_soul(body["content"])；成功后 agent.reload_persona()（best-effort）
GET  /api/config/agents  → read_agents_md()
POST /api/config/agents  → write_agents_md(body["content"])；成功后 agent.reload_persona()
```

- POST 体：`{"content": "..."}`。`content` 缺失当空串处理（=删除）。
- `write_soul` 抛 `ValueError`（超长）→ 400 `{error}`。其它异常 → 500。
- `reload_persona()` 返回值放进响应：`{ok:true, reloaded:bool, ...read_result}`（reloaded=false 表示文件写了但重建失败，下次重启仍生效）。

### 4.3 `floodmind_agent.py`：`reload_persona()`

镜像现有 `reload_model()` 的重建模式，只重建不改模型：

```python
def reload_persona(self) -> bool:
    sid = self._agent.session_id
    _, persist_dir = self._memory_target(sid)
    self._agent = self._build_agent(sid, persist_dir)  # 复用 persist_dir → 历史不丢
    self._set_workspace()  # 重新绑定当前工作区 + _init_executors() 刷新提示词（重读 SOUL.md）
    return True
```

- 重建后调 `_set_workspace()`：把当前工作区重新 bind 到新 agent，并 `_init_executors()` 把新 SOUL.md 烘进缓存提示词 → **下一条消息即生效**（不必等下一次 stream 的 `_set_workspace`）。
- 历史保留：复用 `_memory_target(sid)` 的 `persist_dir`，DualMemory 从盘重载（与 `reload_model` 一致）。
- 并发安全：streaming 中的生成器持有旧 `self._agent` 引用，重赋值不影响在飞流；且 UI 在 streaming 时禁用保存（见 §5），实际不会并发。

## 5. 前端

### 5.1 `config-store.ts` 加 persona 切片

```ts
interface PersonaState {
  soul: string;
  soulIsDefault: boolean;
  agents: string;
  personaLoading: boolean;
  personaSaving: boolean;
  personaError: string | null;
  loadPersona: () => Promise<void>;
  saveSoul: (text: string) => Promise<void>;
  saveAgents: (text: string) => Promise<void>;
  resetSoul: () => Promise<void>;  // = saveSoul('') → 后端删文件 → 回到默认
}
```

- `loadPersona` 并行 GET 两个端点，填 store。
- `saveSoul/saveAgents`：客户端先校验 SOUL ≤20000 字符（超了直接置 `personaError`，不发请求）；POST 成功后用响应里的 `content/isDefault` 更新 store，并清 `personaError`。
- API 调用放本文件内的小 fetch 包装（与现有 config 调用同风格）。

### 5.2 `SettingsView.tsx` 改为三 tab

- 新增 local state `tab: 'model' | 'identity' | 'rules'`，默认 `'model'`（保留现有模型表单为模型 tab 内容）。
- tab 栏 UI：三个按钮，active 高亮。
- 进入 `identity`/`rules` tab 时（且未加载过）调 `loadPersona()`。
- `streaming = useChatStore(s => s.streaming)` —— **streaming 时身份/规则 tab 的"保存"按钮 disabled**，旁边提示 "任务执行中，结束后保存生效"（模型 tab 不受影响，模型保存本来就有自己的逻辑）。

**身份 tab**：
- `<textarea>`（受控，本地 draft），monospace，足够高（~16 行）。
- 字符计数 `len/20000`，超 20000 计数变红 + 保存禁用。
- 按钮：`保存`（disabled 当 streaming/saving/内容未变/超长）、`恢复默认`（调 `resetSoul`）。
- 顶部一行说明："SOUL.md 决定智能体的身份与职责，对所有会话生效。"

**规则 tab**：
- `<textarea>` + `保存`（disabled 当 streaming/saving/内容未变）。
- 说明："全局行为规则（AGENTS.md）。绘图风格、文档模板、用词偏好等。留空则无全局规则。"

### 5.3 样式（app.css）

- `.settings-tabs` + `.settings-tab` / `.settings-tab.active`（复用现有按钮/边框变量）。
- `.persona-editor textarea`、`.char-counter`、`.char-counter.over`。
- 与现有 `.save-btn` 复用。

## 6. 数据流（保存 SOUL 一次）

1. 用户改 SOUL → 点保存 → `saveSoul(text)` → 客户端校验长度 → `POST /api/config/soul {content:text}`。
2. sidecar `write_soul` 写盘 → `agent.reload_persona()`：`_build_agent`（新 NativeFloodAgent，新 ContextRuntime，AGENTS 缓存清空）→ `_set_workspace()`（重 bind 工作区 + `_init_executors` 把新 SOUL 烘进提示词）。
3. 响应 `{ok, reloaded, content, isDefault, path}` → store 更新，按钮恢复。
4. 用户下一条消息 → `stream()` → `_set_workspace()` 再 bind（幂等）→ LLM 看到新身份。

## 7. 边界与错误

- **streaming 时保存**：UI 禁用（推荐，简单可靠）。不做 pending-重建。
- **SOUL 超长**：前端 400 拦截 + 后端 `ValueError`→400 双保险。
- **文件 IO 失败**（权限/磁盘）：后端 500，前端 `personaError` 显示。
- **`reload_persona` 失败**：文件已写盘，响应 `reloaded:false`，下次重启仍生效；前端可提示"已保存，下次启动生效"。
- **空内容语义**：SOUL 空 = 删文件回默认；AGENTS 空 = 无全局规则（删文件）。两端点统一"空=删除"。
- **并发编辑**：单用户桌面，last-write-wins，不处理。

## 8. 测试

### sidecar（pytest，monkeypatch `get_floodmind_home` → tmp 目录）
- `GET /api/config/soul` 无文件 → 200，`content==DEFAULT_SOUL_MD`，`isDefault==true`。
- `POST /api/config/soul {content:"X"}` → 200，文件落盘，`isDefault==false`，`reload_persona` 被调一次。
- `POST /api/config/soul {content:"x"*20001}` → 400。
- `POST /api/config/soul {content:"  "}` → 文件被删，再 GET `isDefault==true`。
- `GET/POST /api/config/agents` 读写 + `reload_persona`；空内容删文件。
- `FloodMindAgent.reload_persona` smoke：`self._agent` 变成新对象（`id` 变化），workspace 仍绑定（`_workspace is not None`）。

### 前端（vitest）
- config-store `saveSoul`：POST 带对 body，flipping `personaSaving`，成功后 store 用响应更新；超长不发请求。
- SettingsView：渲染 3 个 tab；切到 identity 显示 SOUL textarea；`streaming=true` 时保存按钮 disabled。

## 9. 不在本期范围

- **工作区级 AGENTS.md**：SDK 读 `Path.cwd()/AGENTS.md`，sidecar cwd 是 AppData → 不生效。需要改 SDK 让它从工作区根读（同 workspace contextvar 那类修复）。另开 spec。
- **Markdown 实时预览**：本期用纯 textarea，保持简单。
- **遗留路径 `~/.config/floodmind/AGENTS.md`**：不动。
- **mcp.json / search.json 编辑**：属 C/F 组，后续 spec。
