from floodmind_desktop_sidecar.agent import StubAgent
from floodmind_desktop_sidecar.app import create_app


class BgSpy(StubAgent):
    """Records list/kill calls; returns a canned running task."""

    def __init__(self):
        self.list_calls = 0
        self.kill_calls = []

    def list_background_tasks(self):
        self.list_calls += 1
        return [{
            "task_id": "t1",
            "command": "ping -n 100 127.0.0.1",
            "status": "running",
            "exit_code": None,
            "started_at": 1700000000.0,
            "finished_at": None,
            "tail": "Reply from 127.0.0.1: bytes=32",
            "stdout_path": "/x/out.log",
        }]

    def kill_background_task(self, task_id):
        self.kill_calls.append(task_id)
        return True


def test_background_tasks_list(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    spy = BgSpy()
    c = create_app(spy).test_client()
    r = c.get("/api/background-tasks")
    assert r.status_code == 200
    j = r.get_json()
    assert j["tasks"][0]["task_id"] == "t1"
    assert j["tasks"][0]["status"] == "running"
    assert spy.list_calls == 1


def test_background_tasks_kill(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    spy = BgSpy()
    c = create_app(spy).test_client()
    r = c.post("/api/background-tasks/t1/kill")
    assert r.status_code == 200
    assert r.get_json() == {"ok": True}
    assert spy.kill_calls == ["t1"]


def test_background_tasks_stubagent_fallback(tmp_path, monkeypatch):
    """StubAgent has no background methods → empty list, kill → 404."""
    monkeypatch.chdir(tmp_path)
    c = create_app(StubAgent()).test_client()
    r = c.get("/api/background-tasks")
    assert r.status_code == 200
    assert r.get_json() == {"tasks": []}
    r2 = c.post("/api/background-tasks/nope/kill")
    assert r2.status_code == 404


def test_bg_shell_reads_agent_bound_service(tmp_path):
    """v2.0.1：list/kill 走 SDK 公共 Agent 方法，不再碰私有服务。"""
    from floodmind_desktop_sidecar.floodmind_agent import FloodMindAgent

    agent = FloodMindAgent.__new__(FloodMindAgent)

    class FakeAgent:
        def list_background_tasks(self):
            return []

        def kill_background_task(self, task_id):
            return False

    agent._agent = FakeAgent()
    # 空服务 → list 返回 []（访问器路径打通、无崩溃）
    assert agent.list_background_tasks() == []
    # 不存在的任务 kill → False
    assert agent.kill_background_task("nope") is False


def test_retired_agent_tasks_survive_replacement(tmp_path):
    """v2.0.1 壳：agent 重建后，旧 agent 的公共 list_background_tasks 仍被聚合（防误杀）。"""
    from floodmind_desktop_sidecar.floodmind_agent import FloodMindAgent

    agent = FloodMindAgent.__new__(FloodMindAgent)
    agent._retired_agents = []

    class RetiredAgent:
        def list_background_tasks(self):
            return [{
                "task_id": "t-retired", "command": "ping -n 100", "status": "running",
                "exit_code": None, "started_at": 1.0, "finished_at": None,
                "tail": "", "stdout_path": str(tmp_path / "out.log"),
            }]

        def kill_background_task(self, task_id):
            return False

    class ActiveAgent:
        def list_background_tasks(self):
            return []

        def kill_background_task(self, task_id):
            return False

    agent._agent = ActiveAgent()
    agent._retired_agents = [RetiredAgent()]

    tasks = agent.list_background_tasks()
    assert [t["task_id"] for t in tasks] == ["t-retired"]
    assert tasks[0]["status"] == "running"
