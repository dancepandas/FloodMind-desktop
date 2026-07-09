from floodmind_desktop_sidecar.agent import StubAgent
from floodmind_desktop_sidecar.app import create_app
from floodmind_desktop_sidecar.workspace import WorkspaceManager


def test_session_reset_calls_clear_memory():
    class Spy(StubAgent):
        def __init__(self):
            self.cleared = False

        def clear_memory(self):
            self.cleared = True

    spy = Spy()
    client = create_app(spy).test_client()

    r = client.post("/api/session/reset")
    assert r.status_code == 200
    assert r.get_json() == {"ok": True}
    assert spy.cleared is True


def test_workspace_open_rebinds_agent_memory(tmp_path, monkeypatch):
    class Spy(StubAgent):
        def __init__(self):
            self.rebound = []

        def rebind_workspace(self, path):
            self.rebound.append(path)

    monkeypatch.chdir(tmp_path)  # _app_data_dir() = cwd
    spy = Spy()
    mgr = WorkspaceManager()
    client = create_app(spy, workspace_manager=mgr).test_client()

    folder = tmp_path / "ws"
    folder.mkdir()
    r = client.post("/api/workspace/open", json={"path": str(folder)})
    assert r.status_code == 200
    # rebind receives the resolved workspace path (same as summary["path"]).
    assert spy.rebound == [str(folder.resolve())]
