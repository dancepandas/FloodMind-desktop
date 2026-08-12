# SDK v2.0.0 适配 + Harness 稳定性硬化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让桌面端在 SDK v2.0.0 上跑通（pin/测试/后台任务加壳），并真实跑各类任务压 harness、修稳定性问题。

**Architecture:** 桌面端是 SDK 的薄调用方。v2.0.0 核心公共 API（Agent/ModelClient/Workspace/build_folder_workspace/permission hook/stream）稳定，事件类型保留。需要适配的：settings 种子、后台任务服务访问、测试断言、MCP 行为。加外层壳访问 SDK 未完全公共化的接口。

**Tech Stack:** Python 3.13 sidecar (Flask) + Tauri 2/React 19 前端。

## Global Constraints

- **SDK 侧问题 → 反馈用户修，桌面端绝不改 SDK。**
- SDK 未完善接口 → 桌面端加外层壳（getattr 兜底），SDK 完善后去壳。
- **SDK 只来自 dev 仓库 `git+https://github.com/dancepandas/FloodMind.git@main`**；本地装包用代理下载 main tarball。
- 质量检查必须用 **opus 子代理** 验证（每任务完成后）。
- 测试全绿、`npm run build` 通过、`git diff --check` 无空白错误。

---

## 阶段一：v2.0.0 适配

### Task 1: SDK 依赖 pin 到 dev 仓库 main

**Files:**
- Modify: `sidecar/pyproject.toml:8`

- [ ] **Step 1: 改 pin**

`sidecar/pyproject.toml` 第 8 行：
```toml
"floodmind @ git+https://github.com/dancepandas/FloodMind.git@main",
```

- [ ] **Step 2: 验证**

`grep floodmind sidecar/pyproject.toml` → 指向 dev 仓库 `@main`。
本机安装变通：`curl -x http://127.0.0.1:7897 -o $HOME/fm-main.tar.gz https://github.com/dancepandas/FloodMind/archive/refs/heads/main.tar.gz && pip install --no-build-isolation --no-deps --force-reinstall $HOME/fm-main.tar.gz`

- [ ] **Step 3: Commit**

```bash
git add sidecar/pyproject.toml
git commit -m "chore(sdk): pin floodmind to dev repo @main (v2.0.0)"
```

### Task 2: 侧边启动种子 settings + 修 test_read_seeds

v2.0.0 不再隐式种子 `settings.json`（`initialize_floodmind_home()` 是显式函数）。桌面端依赖 settings 文件 → 启动时调用它。

**Files:**
- Modify: `sidecar/floodmind_desktop_sidecar/__main__.py`（main() 开头）
- Modify: `sidecar/tests/conftest.py`（isolated_home 相关）或 `sidecar/tests/test_config.py`

- [ ] **Step 1: sidecar 启动时种子**

`__main__.py` 的 `main()` 里、`WorkspaceManager()` 之前加：
```python
from floodmind.config.settings import initialize_floodmind_home
try:
    initialize_floodmind_home()  # v2.0.0 不再隐式种子；宿主显式建 settings.json
except Exception as e:
    print(f"[sidecar] initialize_floodmind_home failed: {e}", file=sys.stderr)
```

- [ ] **Step 2: 修测试**

`sidecar/tests/test_config.py` 的 `isolated_home` fixture：在 reload 前调用 `initialize_floodmind_home()`，让 `read_model_config()` 能读到种子模板：
```python
def isolated_home(tmp_path, monkeypatch):
    monkeypatch.setenv("FLOODMIND_HOME", str(tmp_path))
    monkeypatch.setattr(config_api, "_legacy_config_path", lambda: tmp_path / "legacy_config.json")
    from floodmind.config.settings import initialize_floodmind_home, reload_config
    initialize_floodmind_home()  # v2.0.0 显式种子
    reload_config()
    yield tmp_path
    reload_config()
```
若种子模板的 providers 已含 `dashscope`（确认存在），原断言 `any(p["id"] == "dashscope" ...)` 保持；若模板 provider 变了，改断言匹配实际模板。

- [ ] **Step 3: 运行测试**

Run: `python -m pytest sidecar/tests/test_config.py::test_read_seeds_template_when_no_settings -q`
Expected: PASS

- [ ] **Step 4: 回归 + Commit**

Run: `python -m pytest sidecar/tests/ -q` 不新增失败。
```bash
git add sidecar/floodmind_desktop_sidecar/__main__.py sidecar/tests/test_config.py
git commit -m "fix(sdk-v2): seed settings via initialize_floodmind_home at startup"
```

### Task 3: 修 MCP 相关 2 个测试

**Files:**
- Modify: `sidecar/tests/test_floodmind_agent.py`（test_mcp_call_health_tracks_outcome、test_mcp_tool_names_sanitized_for_openai_endpoints）

- [ ] **Step 1: 诊断 test_mcp_call_health_tracks_outcome**

运行看失败详情。v2.0.0 MCP health 跟踪行为变化——`pool.call_health()` 对失败调用返回 `ok=True`。读 `floodmind/agent/mcp_client.py` 的 `call_health()`/health 记录逻辑，确认新行为（可能改为探测 ping 而非依赖上次调用结果）。

- [ ] **Step 2: 修断言**

按新行为更新测试断言（mock 的 DownConn/UpConn 与断言需匹配 v2.0.0 health 语义）。若 health 改为对 server 主动探测，测试需提供探测结果。

- [ ] **Step 3: FakeConn 加 transport**

`test_mcp_tool_names_sanitized_for_openai_endpoints` 的 `FakeConn` 类补 `transport` 属性（v2.0.0 `mcp_client.py` 读 `conn.transport`）：
```python
class FakeConn:
    transport = "stdio"  # 或测试所需值
    ...
```

- [ ] **Step 4: 运行测试**

Run: `python -m pytest sidecar/tests/test_floodmind_agent.py::test_mcp_call_health_tracks_outcome sidecar/tests/test_floodmind_agent.py::test_mcp_tool_names_sanitized_for_openai_endpoints -q`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add sidecar/tests/test_floodmind_agent.py
git commit -m "fix(sdk-v2): update MCP health + tool-name tests for v2.0.0 API"
```

### Task 4: 后台任务生产代码加壳（agent 绑定服务）

v2.0.0：`get_background_task_service()` 全局单例移除，`BackgroundTaskService(base_dir=...)` 绑定到 `NativeFloodAgent._background_task_service`。

**Files:**
- Modify: `sidecar/floodmind_desktop_sidecar/floodmind_agent.py`（list_background_tasks / kill_background_task）

- [ ] **Step 1: 加壳访问服务**

把 `from floodmind.agent.runtime.services.background_task_service import get_background_task_service` 替换为从 agent 取绑定服务（getattr 兜底）：
```python
def _bg_service(self):
    raw = getattr(self._agent, "raw", None)
    return getattr(raw, "_background_task_service", None)

def list_background_tasks(self) -> list[dict]:
    svc = self._bg_service()
    if svc is None:
        return []
    sid = getattr(self._agent, "session_id", None)
    if not sid:
        return []
    out = []
    for t in svc.list(sid):
        tail = t.tail
        if not tail:
            try:
                tail = _tail_file(t.stdout_path, 200)
            except Exception:
                tail = ""
        out.append({
            "task_id": t.task_id, "command": t.command, "status": t.status,
            "exit_code": t.exit_code, "started_at": t.started_at,
            "finished_at": t.finished_at, "tail": tail, "stdout_path": t.stdout_path,
        })
    return out

def kill_background_task(self, task_id: str) -> bool:
    svc = self._bg_service()
    if svc is None:
        return False
    sid = getattr(self._agent, "session_id", None)
    if not sid or not task_id:
        return False
    return bool(svc.kill(sid, task_id))
```
（`_bg_service` 是桌面端外层壳：SDK 以后暴露公共访问后，去掉 getattr 直接取。）

- [ ] **Step 2: 前端 status 类型扩展**

v2.0.0 `BackgroundTask.status` 新增 `starting/kill_requested/terminating/kill_failed/orphaned`。改 `src/state/background-task-store.ts` 的 `BgTaskStatus`，并把 `starting` 计入运行中（`runningCount`）：
```ts
export type BgTaskStatus = "starting" | "running" | "kill_requested" | "terminating" | "completed" | "failed" | "killed" | "kill_failed" | "orphaned";
// runningCount: status 属于 {"starting","running","kill_requested","terminating"} 算运行中
```
`BackgroundTasksPanel.tsx` 的 `STATUS_LABELS` 补新状态的显示文案（运行中/终止请求/终止中/终止失败/孤儿）。

- [ ] **Step 3: 运行测试**

Run: `python -m pytest sidecar/tests/test_background_tasks_api.py -q` + `npx vitest run src/state/background-task-store.test.ts src/components/BackgroundTasksPanel.test.tsx`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add sidecar/floodmind_desktop_sidecar/floodmind_agent.py src/state/background-task-store.ts src/components/BackgroundTasksPanel.tsx
git commit -m "feat(sdk-v2): background tasks via agent-bound service (outer shell) + new statuses"
```

### Task 5: 全量回归 + opus 质量检查

- [ ] **Step 1: 回归**

Run: `python -m pytest sidecar/tests/ -q`（全绿）、`npx vitest run`（全绿）、`npm run build`、`git diff --check`。

- [ ] **Step 2: opus 子代理质量检查**

用 `Agent` 工具（model=opus）审查阶段一的全部 diff：SDK 兼容性、壳实现、测试质量。修复 opus 发现的问题。

- [ ] **Step 3: 冒烟启动**

`npm run tauri dev` 启动，验证 sidecar 健康、对话能跑。

---

## 阶段二：多开任务实验 + 稳定性硬化

每类实验：真实跑 → 记录事件流转/UI/稳定性 → 桌面端问题直接修（含测试）→ SDK 问题反馈用户 → opus 子代理验证修改。

### Task 6: 对话/推理实验
- 多轮 思考→工具→中间回答→最终回答；验证 `thought_delta`/`answer_delta`、「模型思考中」指示、循环折叠。
- 发现 `translate_event` 对 v2.0.0 新增事件（projection_committed/round_events 等）的透传是否无害。

### Task 7: 工具类实验
- 文件读写/搜索/Bash；`run_in_background` 后台 shell + 任务面板 + kill。

### Task 8: MCP 实验
- hydro-rag / chronos / ocr-table 三类外部服务调用；health 状态。

### Task 9: 外部文件授权实验
- 工作区外文件拖入/预览/读取授权链。

### Task 10: 定时任务实验
- 创建/立即运行/历史。

### Task 11: 多会话 + 稳定性实验
- 新任务切换、空会话清理、长任务中断、断流、重复发送、权限 ask、后台轮询竞态。

### Task 12: 汇总 + 收尾
- 问题清单（桌面端修 / SDK 反馈）整理进 spec。
- opus 子代理对阶段二全部改动做质量检查。
- 全量回归 + build + diff-check。

---

## Self-Review（写计划时的自查）

- Spec 覆盖：阶段一（pin/3测试/加壳/回归）✓ 阶段二（7类实验+硬化）✓ 铁律（反馈/加壳/dev仓库/opus）✓。
- 占位符：测试修复的 Step 用「诊断后更新」描述——实现时按实际新行为填断言（v2.0.0 MCP health 语义需读源码确认）。
- 类型一致：`_bg_service`/`list_background_tasks`/`kill_background_task` 签名与现有前端调用一致；`BgTaskStatus` 与 `STATUS_LABELS` 同步扩展。
