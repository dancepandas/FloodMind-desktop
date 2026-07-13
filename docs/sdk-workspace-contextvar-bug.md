# FloodMind SDK — 工作区 contextvar 在 agent 子线程丢失（C 盘写入 bug）

> 影响版本：桌面端 sidecar 当前接入的 FloodMind SDK
> 涉及仓库：**FloodMind SDK**（`native_flood_agent.py` / `path_service.py` / `workspace_service.py`）
> 报告方：FloodMind Desktop（branch `feat/scheduled-tasks`，2026-07-10 复现）
> 严重程度：高（agent 所有相对路径写入/执行都落到 C 盘 AppData，而非用户打开的工作区）

---

## 1. 现象

桌面端打开工作区 `E:\FloodMind测试` 后，让 agent 执行任务（例如 `echo -n "h" > test_plan.txt`）。
预期：文件写到工作区 `E:\FloodMind测试\test_plan.txt`。
实际：文件写到了

```
C:\Users\Administrator\AppData\Roaming\FloodMindDesktop\data\sessions\<session_id>\outputs\test_plan.txt
```

即 agent 在 C 盘的 AppData 会话目录里操作，而不是用户工作区。exec_bash 的 cwd、产物写入、代码执行全部受影响。

---

## 2. 证据链（已确认，非推测）

### 2.1 文件落地位置

实测 `test_plan.txt` 出现在：

```
C:/Users/Administrator/AppData/Roaming/FloodMindDesktop/data/sessions/5bb2bbd9b7574c2c9f6a6111068c5bde/outputs/test_plan.txt
```

工作区 `E:\FloodMind测试` 下**没有**该文件。

### 2.2 宿主确实 set 了 workspace

sidecar 日志：

```
[sidecar] workspace bound: user_dir=E:\FloodMind测试 sid=ws-6b66aec490017d9d164013bc
```

说明桌面端在主线程里调用过 `set_workspace(ws)`，且 `ws.user_dir` 正确指向 E 盘工作区。

### 2.3 那个 C 盘路径只能由 `_get_output_dir()` 的回退分支产生

`native_flood_agent.py`（约 2196-2212 行）：

```python
def _get_output_dir(self, session_id: Optional[str] = None) -> str:
    """主代理产物目录：优先 workspace.user_dir；回退到 session_manager 旧路径。"""
    ws = get_workspace()
    if ws is not None:
        d = str(ws.user_dir)
        os.makedirs(d, exist_ok=True)
        return d                                  # ← 应该走这里（= 工作区）
    sid = session_id or self.session_id
    if sid:
        data_dir = os.environ.get('DATA_DIR', str(Path.cwd() / "data"))
        output_dir = os.path.join(data_dir, "sessions", sid, "outputs")
        os.makedirs(output_dir, exist_ok=True)
        return output_dir                         # ← 实际走了这里（= C 盘 AppData）
    d = get_current_session_output_dir()
    if d:
        return d
    return os.path.abspath(os.path.join("data", "agent_state"))
```

sidecar 进程的 cwd 是 `AppData\Roaming\FloodMindDesktop`（由 Tauri 端 `sidecar.rs` 设定），所以
`Path.cwd() / "data" / "sessions" / <sid> / "outputs"` 正好等于上面实测的那个 C 盘路径。
**因此 `_get_output_dir()` 被调用时 `get_workspace()` 返回了 `None`。**

### 2.4 `_get_output_dir()` 在 SDK 的子线程里被调用

`native_flood_agent.py`（约 2262-2271 行）：

```python
def _run_loop() -> None:
    try:
        logger.info("[RUN_LOOP] === _run_loop started, session=%s ===", self.session_id)
        effective_session_id = resume_session_id or self.session_id
        output_dir = self._get_output_dir(effective_session_id)   # ← 在这里调用
        upload_dir = self._get_upload_dir(effective_session_id)
        self._set_session_context(effective_session_id, output_dir)
        ...
```

而 `_run_loop` 跑在一个**新建的子线程**里（`native_flood_agent.py` 约 2394-2396 行）：

```python
current_ctx = contextvars.copy_context()
t = threading.Thread(target=lambda: current_ctx.run(_run_loop), daemon=True)
t.start()
```

**结论：宿主在主线程里 `set_workspace()` 设置的 `floodmind_workspace` contextvar，
到了 SDK 创建的这个 agent 子线程里 `get_workspace()` 变成了 `None`。**
理论上 `copy_context()` 应当把当前 contextvar 拷贝进子线程，但实测没有带过去。

---

## 3. 根因

`floodmind_workspace` contextvar **没有可靠地传播到 SDK 自己创建的 agent 子线程**。
`_run_loop` 运行在 `threading.Thread(...)` 里，`contextvars.copy_context()` 在本场景下
未能把宿主在主线程设置的 workspace 带入子线程（具体机制见 §5 诊断步骤确认）。

由于 workspace 丢失，下游所有依赖 `get_workspace()` 的解析全部回退到 AppData 会话目录：

- `_get_output_dir()` → `data/sessions/<sid>/outputs`（C 盘）
- `_get_upload_dir()` → 同样回退
- `PathService._effective_workspace()` → `None` → 动态写/读根为空

---

## 4. 为什么不能只补一个下游函数（权限冲突）

`get_workspace()` 是多个子系统的**共同读取点**，不是只有 `_get_output_dir` 一个消费者：

| 消费方 | 位置 | 作用 | contextvar 丢失时的后果 |
|---|---|---|---|
| `_get_output_dir` | `native_flood_agent.py:2196` | exec_bash cwd / 产物目录 | cwd 变 AppData |
| `_get_upload_dir` | `native_flood_agent.py:2214` | 上传目录 | 上传落 AppData |
| `PathService._effective_workspace` | `path_service.py:72` | `_dynamic_write_roots` / `_dynamic_read_roots` | **写/读白名单为空** |
| （子代理）exec cwd 选择 | `base_tools.py:_impl_exec_bash` | exec cwd 优先级 | 影响子代理 |

PathService 的写校验（`path_service.py:165` `is_write_allowed`）第一步就是 `_dynamic_write_roots()`：

```python
def is_write_allowed(self, resolved: Path) -> bool:
    ...
    for prefix in self._dynamic_write_roots():        # ← ws 为 None 时返回 []
        if self._is_relative_to(resolved, prefix):
            return True
    for prefix in self._static_write_allowed_prefixes:
        ...
```

`_dynamic_write_roots()`（`path_service.py:81`）：

```python
def _dynamic_write_roots(self) -> list:
    ws = self._effective_workspace()
    if ws is None:
        return []                                     # ← workspace 不在工作区写白名单
    return [ws.user_dir, ws.sandbox_base, *ws.writable_roots]
```

因此如果**只**把 `_get_output_dir` 钉死到工作区（而不修 `get_workspace()`），会出现：

- `exec_bash`（shell 直跑，**绕过** PathService 路径校验）→ 能写工作区；
- `Write` / 走路径校验的工具 → `get_workspace()` 仍为 `None` → `_dynamic_write_roots()` 返回空 →
  工作区**不在写白名单** → 写入被拒（`写入路径 ... 不在允许目录内`）。

**两条写入路径行为不一致**，这就是"只补一个函数"会和 SDK 权限子系统冲突的原因。
所以修复**必须在 `get_workspace()` 这个源头**进行，让所有消费方重新一致。

> 附注：`path_service.py:76` 的 `get_workspace` 是**局部 import**（运行时读模块属性），
> 而 `native_flood_agent.py:47` 是**模块级 import**（导入时绑定）。
> 任何在 SDK 外部打补丁的方案都要同时覆盖这两种绑定方式，极易遗漏——这也是
> 应当直接在 SDK 内部修复的另一个理由。

---

## 5. 诊断步骤（先加一行日志，确认丢失发生在哪一层）

为了确认 workspace 是在"子线程边界"丢失，还是更早就丢了（例如宿主 `set_workspace()`
和 `agent.stream()` 不在同一线程），在 `native_flood_agent.py` 的 `stream()` 入口和
`_run_loop` 开头各加一条诊断日志：

```python
# stream() 方法入口（主线程，宿主已 set_workspace）
logger.info("[WS-DIAG] stream entry: get_workspace()=%s thread=%s",
            get_workspace(), threading.current_thread().ident)

# _run_loop() 开头（子线程）
logger.info("[WS-DIAG] _run_loop start: get_workspace()=%s thread=%s",
            get_workspace(), threading.current_thread().ident)
```

判读：

- **entry 非 None、`_run_loop` 为 None** → 子线程边界丢失，§6 的修改直接解决。
- **entry 也是 None** → 宿主 `set_workspace()` 与 `agent.stream()` 不在同一线程
  （流式响应消费 generator 的线程模型问题）。此时需要让宿主**显式把 workspace 传给 agent**
  （实例属性），见 §7 彻底方案。

---

## 6. 推荐修复（最小改动，根治）

**核心思路：不依赖 contextvar 跨 SDK 子线程传播。在 `stream()` 入口（主线程，宿主已 set）
把 workspace 取出来，进 `_run_loop`（子线程）第一行重新 `set_workspace()`。**
这样 `_get_output_dir` / `_get_upload_dir` / `PathService` 写读根全部重新一致，无权限冲突。

### 6.1 `native_flood_agent.py` — `stream()` 建线程那段（约 2394 行）

```python
# 宿主在本线程已 set_workspace()；contextvar 不会可靠传播到下面的子线程，
# 所以这里显式捕获，进 _run_loop 重新绑定。
_parent_workspace = get_workspace()

current_ctx = contextvars.copy_context()

def _runner():
    current_ctx.run(_run_loop)

t = threading.Thread(target=_runner, daemon=True)
t.start()
```

### 6.2 `native_flood_agent.py` — `_run_loop()` 开头（约 2262 行，`try:` 之后第一件事）

```python
def _run_loop() -> None:
    try:
        logger.info("[RUN_LOOP] === _run_loop started, session=%s ===", self.session_id)

        # 子线程不会继承 floodmind_workspace contextvar，显式重绑，
        # 保证 _get_output_dir / _get_upload_dir / PathService 写读根全部一致。
        if _parent_workspace is not None:
            set_workspace(_parent_workspace)

        effective_session_id = resume_session_id or self.session_id
        output_dir = self._get_output_dir(effective_session_id)
        upload_dir = self._get_upload_dir(effective_session_id)
        self._set_session_context(effective_session_id, output_dir)
        # ...（原有逻辑不变）
```

> `set_workspace` 来自 `floodmind.agent.runtime.services.workspace_service`，按需 import。
> 若 `get_workspace` 已在文件顶部 import，`set_workspace` 一并加上即可。

### 6.3 修复后自愈的链路

| 消费方 | 修复后 |
|---|---|
| `_get_output_dir` | → `ws.user_dir` = 工作区 ✅ |
| `_get_upload_dir` | → 工作区内 ✅ |
| `PathService._dynamic_write_roots` | `[user_dir, sandbox_base, ...]` 含工作区 ✅（写工具不再被拒）|
| `PathService._dynamic_read_roots` | 含工作区 ✅ |
| `exec_bash` cwd | `SESSION_CONTEXT["output_dir"]` = 工作区 ✅ |

---

## 7. 彻底方案（可选，长期更稳）

workspace 本质是"每个 agent run 的属性"，不应该靠隐式 contextvar 在线程间漂移。
建议在 `NativeFloodAgent` 上加一个**显式 workspace 实例属性**：

1. `NativeFloodAgent` 增加 `workspace` 属性（构造时由宿主传入，或提供 `set_workspace(ws)` 方法）。
2. `_run_loop` 开头：`if self._workspace is not None: set_workspace(self._workspace)`。
3. `_get_output_dir` / `_get_upload_dir` 优先读 `self._workspace`，contextvar 仅作兜底（网页版）。

桌面端 `build_workspace(...)` 已经构造好了 `Workspace` 对象，可直接传给 agent；
网页版继续走 contextvar。这样桌面/网页都不再依赖跨线程 contextvar 传播，最稳。

---

## 8. 验证清单

修复后用桌面端复现任务（如 `echo -n "h" > test_plan.txt`），确认：

- [ ] `[WS-DIAG] _run_loop start` 日志里 `get_workspace()` 非 None（指向 E 盘工作区）。
- [ ] `test_plan.txt` 出现在 `E:\FloodMind测试\`，而**不是** AppData。
- [ ] agent 用相对名读取工作区文件（如 `pd.read_excel("huokou.xlsx")`）能成功。
- [ ] 走 PathService 校验的 `Write` 工具写工作区**不再被拒**（无"写入路径不在允许目录内"）。
- [ ] 切换工作区后，新会话的写入落到新工作区。

---

## 9. 附：关键文件与行号（修复时所参考的 SDK 版本）

| 文件 | 行号 | 内容 |
|---|---|---|
| `native_flood_agent.py` | ~2196 | `_get_output_dir`（含 C 盘回退分支）|
| `native_flood_agent.py` | ~2214 | `_get_upload_dir` |
| `native_flood_agent.py` | ~2262 | `_run_loop` 起点（建议在此重绑 workspace）|
| `native_flood_agent.py` | ~2269 | `_run_loop` 内调用 `_get_output_dir` |
| `native_flood_agent.py` | ~2394 | `copy_context()` + 建子线程（建议在此捕获 workspace）|
| `native_flood_agent.py` | 47 | 模块级 `from ... import get_workspace` |
| `path_service.py` | 72-79 | `_effective_workspace`（局部 import get_workspace）|
| `path_service.py` | 81-86 | `_dynamic_write_roots` |
| `path_service.py` | 165 | `is_write_allowed` |
| `workspace_service.py` | 21-33 | `_workspace_var` / `get_workspace` / `set_workspace` |
| `base_tools.py` | ~602-620 | `_impl_exec_bash` 的 cwd 优先级 |

> 行号随 SDK 版本会漂移，以函数名/代码片段为准。

---

## 10. 跟进 Bug（已确认，SDK 侧待修）：`bind_workspace` 未刷新缓存的 prompt

> 状态：§6 的 contextvar 修复已合入 SDK（`bind_workspace` + `_run_loop` 重绑），
> 但又暴露出第二个、相关的 bug。桌面端 sidecar 已加临时绕过（bind 后重跑
> `_init_executors()`），但**根因在 SDK，应正式修复**。

### 现象

contextvar 修复后，`_get_output_dir()` / `_get_upload_dir()` / PathService 写读根
**都已正确指向工作区**（日志可证：`_run_loop` 子线程里 `_get_output_dir → E:\工作区`）。
但 agent 仍往 C 盘 AppData 写 —— 因为 **LLM 自己在命令里写了 AppData 绝对路径**：

```
执行命令: echo "hi" > "C:\...\FloodMindDesktop\data\sessions\<sid>\outputs\hello.txt"
```

路径里带的是**当前** session_id，说明是 SDK 在本次会话里把这个 AppData 路径
注入给了 LLM。

### 根因

`native_flood_agent.py` 的 `_init_executors()`（`__init__` 时经 line 328 调用，
**只跑一次**）把 `会话输出目录` 烘焙进 prompt 并缓存：

```python
def _init_executors(self) -> None:          # native_flood_agent.py:983
    ...
    output_dir = self._get_output_dir()     # line 994 —— 构造时调用
    upload_dir = self._get_upload_dir()
    ...
    session_env = (
        f"会话输出目录: {output_dir}\n"       # line 1005 —— AppData fallback 路径
        f"上传目录: {upload_dir}\n"
        ...
    )
    self._session_env = session_env          # line 1015 —— 缓存
    ...
    orchestrator_prompts = [self._build_stable_prompt(..., session_env=session_env, ...)]  # 也缓存了
```

**问题链**：

1. `__init__` → `_init_executors()` 在**构造时**调用。
2. 此刻 `self._workspace` 还是 `None`（宿主的 `bind_workspace(ws)` 在构造**之后**才调）。
3. 于是 `_get_output_dir()` 走 fallback → `data/sessions/<sid>/outputs`（AppData）。
4. 这个 AppData 路径被烘焙进 `self._session_env` 和 `orchestrator_prompts`，**永久缓存**。
5. 之后 `bind_workspace(ws)` 改了 `self._workspace`，但**没刷新**这些缓存。
6. 每次 LLM 调用都用缓存的 prompt → LLM 一直被告知"输出目录是 C:\...\outputs" → 往 C 盘写。

也就是说：`bind_workspace` 让运行时路径解析（`_get_output_dir` 等）对了，但
**LLM 看到的 prompt 里仍是旧的 AppData 路径**，二者不一致。

### 建议的 SDK 修复（任选其一，推荐 A）

**A. `bind_workspace` 刷新缓存 prompt（最小、对症）**

在 `bind_workspace` 里设完 `self._workspace` 后，重建依赖 output_dir 的缓存：

```python
def bind_workspace(self, ws: Optional["Workspace"]) -> None:
    self._workspace = ws
    # _init_executors 在 __init__ 时把 output_dir 烘焙进了 _session_env /
    # orchestrator_prompts；切换 workspace 后必须刷新，否则 LLM 仍按旧路径写。
    self._init_executors()
```

（`_init_executors` 幂等可重入：只重建 `_session_env` / `orchestrator_prompts` /
`_context_runtime` 等只读缓存，无破坏性副作用。）

**B. output_dir 改为 lazy 解析（更彻底）**

把 `_session_env` 里 `{output_dir}` 改成占位符，在每次构建 LLM message 时
（`_session_env` 的消费点，约 line 1099）现取 `_get_output_dir()` 填充，
而不是构造时固化。这样 workspace 任何时刻切换都立即生效，无需手动刷新。

### 桌面端临时绕过（已生效，待 SDK 修复后可删）

sidecar `floodmind_agent.py` 在 `bind_workspace(ws)` 之后立即重跑 `_init_executors()`：

```python
self._agent.bind_workspace(ws)
try:
    self._agent._init_executors()      # 刷新被构造时固化的 prompt
except Exception as e:
    print(f"[sidecar] _init_executors refresh failed: {e}", file=sys.stderr)
```

headless 路径（`run_headless`）同样处理。SDK 修复后这段可移除。

### 验证

修复后 agent 生成的写命令里**不应再出现** `data/sessions/.../outputs` 路径，
文件应直接落到工作区（`echo "hi" > hello.txt` → 工作区根目录）。

