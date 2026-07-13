# Skills & MCP 管理 CRUD 设计

> 日期: 2026-07-13
> 范围: FloodMind Desktop（Tauri + React + Python sidecar），不改 SDK
> 所属 backlog: "释放所有 SDK 能力" → C/F 组（Skills / MCP 配置）

## 1. 问题与目标

当前桌面端的 Skills / MCP 页面是只读浏览，用户想直接自行配置：

- **Skills**: 启用/停用内置 skill，以及新增、编辑、删除自定义 skill。
- **MCP**: 新增、编辑、删除 MCP 服务器配置，并测试连接。

目标：在现有 `SkillsView` / `McpView` 页面增加管理功能，配置持久化到 `~/.floodmind/`，保存后立即生效（无需重启 sidecar）。

## 2. 已核实的 SDK 事实

- `floodmind.skills.registry.SkillRegistry`:
  - `list_skills()` / `get_skill(name)`：只读浏览。
  - `set_disabled(name, disabled)`：**仅内存生效，不持久化**。
  - `register_skill(skill)`：把 `Skill` 对象注册进当前运行时。
  - `refresh()`：重新扫描 `roots` 并返回 skill 列表。
  - `roots` 包含内置 skill 目录；`writable_root` 指向 `site-packages/skills`（不用于桌面端）。
- `floodmind.skills.skill_curator.discover_skills(skills_dir: Path) -> List[Skill]`：扫描目录下所有 `SKILL.md` 并返回 `Skill` 对象列表。
- `floodmind.skills.base.Skill` 可直接实例化：`(name, description, prompt='', scripts=[], references=[], assets=[], is_knowledge_only=False, skill_dir=None, version='1.0', provides_tools=[], category='execution', compatibility=None)`。
- `floodmind.agent.mcp_client.McpClientPool`:
  - `list_servers()` / `get_server_info(name)`：只读。
  - `connect_server(server_config: dict)` / `disconnect_server(name: str)` / `connect_all(servers: List[dict])` / `disconnect_all()`。
- 桌面端 SDK 主目录 `~/.floodmind/` 已存在 `mcp.json`（`{servers: [...]}`）和空 `skills/` 目录。
- `~/.floodmind/settings.json` 当前包含 `provider`、`model`、`agent`，不含 `skills` 配置。

## 3. 架构

```
SkillsView / McpView (React)
       │
catalog-store.ts ── 新增 CRUD actions
       │
sidecar catalog_api.py ── 读写 skills/mcp 配置、调用 SDK 刷新
       │
~/.floodmind/settings.json (skills.disabled)
~/.floodmind/skills/<name>/{SKILL.md,meta.json}
~/.floodmind/mcp.json
       │
SkillRegistry.set_disabled / register_skill / refresh
McpClientPool.connect_all / disconnect_all
```

## 4. 后端（sidecar）

### 4.1 新增 `catalog_api.py`

纯函数，不 import agent，便于单测（monkeypatch `get_floodmind_home`）。

```python
# Skills
SKILL_NAME_RE = re.compile(r"^[a-z0-9_-]+$")

def list_builtin_skills() -> list[str]: ...

def read_skills_disabled() -> list[str]: ...

def write_skills_disabled(names: list[str]) -> None: ...

def create_skill(name: str, meta: dict, prompt: str) -> dict: ...

def update_skill(name: str, meta: dict, prompt: str) -> dict: ...

def delete_skill(name: str) -> None: ...

def apply_disabled_state(disabled: list[str]) -> None: ...

# MCP
def read_mcp_config() -> dict: ...

def write_mcp_config(servers: list[dict]) -> None: ...

def test_mcp_server(server_config: dict) -> dict: ...
```

**Skills 持久化细节**

- 停用名单：`~/.floodmind/settings.json` -> `"skills": {"disabled": ["csv", "pdf"]}`。
- 自定义 skill 目录：`~/.floodmind/skills/<name>/`。
- 每个自定义 skill 包含：
  - `SKILL.md`：skill prompt / 说明正文。
  - `meta.json`：`{"name","description","category","version","provides_tools":[]}`。
- `create_skill` 校验：
  - 名称匹配 `^[a-z0-9_-]+$`。
  - 不能和内置 skill 重名。
  - 目录不能已存在。
- `update_skill` / `delete_skill` 只能操作自定义 skill；尝试改内置 skill 抛 `PermissionError`（后端 403）。
- 改动后：
  - 对自定义 skill 调用 `discover_skills(home_skills_dir)` 并 `register_skill` 每一个；
  - 或统一调 `SkillRegistry.refresh()` 并重新 `apply_disabled_state`。

**MCP 持久化细节**

- 统一读写 `~/.floodmind/mcp.json`。
- server schema：
  ```json
  {
    "name": "fs",
    "transport": "stdio",
    "command": "python",
    "args": ["mcp_server.py"],
    "env": {"KEY": "value"}
  }
  ```
  SSE 时：`{"name","transport":"sse","url":"http://..."}`。
- `transport` 仅允许 `stdio` / `sse`。
- `name` 唯一且非空。
- 保存后调用 `McpClientPool.disconnect_all()` + `connect_all(servers)` 重新连接。
- `test_mcp_server` 单独对单个 server config 调用 `connect_server`，返回 `{ok:bool, error?:str}`。

### 4.2 `app.py` 新增/调整路由

**Skills**

```
GET    /api/skills              → 现有；返回 skills 列表（含 disabled 字段）
GET    /api/skills/<name>       → 现有
POST   /api/skills/<name>/disabled {disabled:bool}
POST   /api/skills              {name, description, category, version, prompt}
PUT    /api/skills/<name>       {description, category, version, prompt}
DELETE /api/skills/<name>
```

**MCP**

```
GET    /api/mcp                 → 现有
GET    /api/mcp/<name>          → 现有
POST   /api/mcp                 {name, transport, command?, args?, env?, url?}
PUT    /api/mcp/<name>          {transport, command?, args?, env?, url?}
DELETE /api/mcp/<name>
POST   /api/mcp/<name>/test     → {ok:bool, error?:str}
```

状态码：
- 200 成功；
- 400 参数错误 / 名称不合法 / transport 不合法 / 重名；
- 403 尝试修改/删除内置 skill；
- 404 skill/server 不存在；
- 500 文件 IO / SDK 异常。

### 4.3 启动时应用停用状态

在 `FloodMindAgent` 初始化完成（或 sidecar 启动）后，读取 `~/.floodmind/settings.json` 的 `skills.disabled`，对每个名字调用 `SkillRegistry.set_disabled(name, True)`。

## 5. 前端

### 5.1 `catalog-store.ts` 扩展

新增 state 字段：

```ts
skillSaving: boolean;
skillError: string | null;
mcpSaving: boolean;
mcpError: string | null;
mcpTesting: boolean;
```

新增 actions：

```ts
setSkillDisabled(name: string, disabled: boolean): Promise<void>;
createSkill(skill: SkillForm): Promise<void>;
updateSkill(name: string, skill: SkillForm): Promise<void>;
deleteSkill(name: string): Promise<void>;
createMcpServer(server: McpServerForm): Promise<void>;
updateMcpServer(name: string, server: McpServerForm): Promise<void>;
deleteMcpServer(name: string): Promise<void>;
testMcpServer(name: string): Promise<{ok:boolean; error?:string}>;
```

`SkillForm = { name?, description, category, version, prompt }`
`McpServerForm = { name?, transport: 'stdio'|'sse', command?, args: string[], env: Record<string,string>, url? }`

保存成功后重新 `loadSkills()` / `loadMcp()` 并刷新当前 detail。

### 5.2 `SkillsView.tsx`

- 列表顶部增加「新建 Skill」按钮（PageHeader actions 区域）。
- 详情区：
  - 内置 skill：显示开关 `启用 / 停用`；无编辑/删除。
  - 自定义 skill：显示「编辑」「删除」按钮。
- 新增/编辑共用 `SkillEditModal`。
- 删除前二次确认：`window.confirm` 或自定义确认弹窗。

### 5.3 `McpView.tsx`

- 列表顶部增加「新建 MCP 服务器」按钮。
- 详情区显示「编辑」「删除」「测试连接」。
- 新增/编辑共用 `McpEditModal`。
- 测试连接时显示 loading，结果显示在按钮旁。

### 5.4 新增组件

- `src/components/SkillEditModal.tsx`
- `src/components/McpEditModal.tsx`

两者复用现有 `.modal-*` 样式。

### 5.5 表单字段

**SkillEditModal**

| 字段 | 说明 |
|------|------|
| 名称 | 新建可填；编辑只读。校验 `[a-z0-9_-]+`、不能与内置重名。 |
| 描述 | 单行文本。 |
| 分类 | 单行文本，默认 `execution`。 |
| 版本 | 单行文本，默认 `1.0`。 |
| SKILL.md | 多行 textarea，主内容。 |

**McpEditModal**

| 字段 | 说明 |
|------|------|
| 名称 | 新建可填；编辑只读。 |
| 传输类型 | select：`stdio` / `sse`。 |
| 命令 / URL | `stdio` 时显示命令输入框；`sse` 时显示 URL 输入框。 |
| 参数 | textarea，每行一个，保存时转数组。 |
| 环境变量 | 键值对列表，可添加/删除。 |

## 6. 数据流

### 6.1 停用内置 skill

1. 用户拨动开关 → `setSkillDisabled(name, disabled)`。
2. `POST /api/skills/<name>/disabled`。
3. 后端读 settings.json，更新 `skills.disabled`，写回。
4. 立即调用 `SkillRegistry.set_disabled(name, disabled)`。
5. 前端重新 `loadSkills()`，列表显示最新状态。

### 6.2 新建自定义 skill

1. 用户填表 → `createSkill(form)`。
2. `POST /api/skills`。
3. 后端创建目录、写 `SKILL.md` + `meta.json`。
4. 调用 `discover_skills(home_skills_dir)` 并 `register_skill(skill)`。
5. 返回 200 → 前端清空表单、关闭 Modal、`loadSkills()`、选中新建项。

### 6.3 MCP 保存

1. 用户填表 → `createMcpServer` / `updateMcpServer`。
2. `POST/PUT /api/mcp[/<name>]`。
3. 后端写 `mcp.json`。
4. `McpClientPool.disconnect_all()` + `connect_all(servers)`。
5. 返回 200 → 前端 `loadMcp()`，显示连接状态。

## 7. 边界与错误

- **streaming 时保存**：UI 禁用保存/删除按钮（与模型配置保持一致）。
- **内置 skill 保护**：删除/编辑返回 403，前端隐藏相关按钮。
- **名称冲突**：自定义 skill 或 MCP 名称已存在时返回 400。
- **MCP 连接失败**：保存时即使连接失败也允许保存（先落盘），前端显示警告；测试连接单独反馈错误。
- **空内容**：SKILL.md 允许为空字符串，但不允许 name 为空。
- **并发编辑**：单用户桌面，last-write-wins。

## 8. 测试

### 8.1 Sidecar（pytest，monkeypatch `get_floodmind_home` → tmp）

- `GET /api/skills` 包含 `disabled` 状态。
- `POST /api/skills/<name>/disabled` 更新 settings.json 并调用 `set_disabled`。
- 自定义 skill CRUD：创建目录/文件、编辑、删除；删除内置 skill 返回 403。
- 自定义 skill 名称非法 / 与内置重名 → 400。
- MCP CRUD：读/写 `mcp.json`，保存后 `connect_all` 被调用。
- MCP test：`POST /api/mcp/<name>/test` 返回 `ok` / `error`。
- `apply_disabled_state` 在启动时被调用。

### 8.2 前端（vitest）

- `catalog-store`：
  - `setSkillDisabled` 成功/失败状态。
  - `createSkill` 成功后刷新列表。
  - `testMcpServer` 返回连接结果。
- `SkillsView`：
  - 内置 skill 详情显示开关、无删除按钮。
  - 自定义 skill 详情显示编辑/删除按钮。
  - Modal 打开、提交、关闭。
- `McpView`：
  - 新建/编辑 Modal 切换 transport 时显示对应字段。
  - 删除前确认。

## 9. 不在本期范围

- 上传 skill zip / 多文件脚本编辑（本期只编辑 SKILL.md + meta.json）。
- MCP 高级配置：headers、SSE 认证、timeout。
- MCP server 的 add/edit 原始 JSON 模式。
- 批量导入/导出 skills 或 MCP 配置。
- 工作区级 AGENTS.md（已另开 spec）。
