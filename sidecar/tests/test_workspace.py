import pytest

from floodmind_desktop_sidecar.app import create_app
from floodmind_desktop_sidecar.agent import StubAgent
from floodmind_desktop_sidecar.workspace import session_id_for, resolve_user_dir, WorkspaceManager


def test_workspace_files_endpoint(tmp_path, monkeypatch):
    """GET /api/workspace/files returns directory listing, rejects escape."""
    monkeypatch.chdir(tmp_path)
    mgr = WorkspaceManager()
    ws = tmp_path / "ws"
    ws.mkdir()
    (ws / "readme.txt").write_text("hi")
    (ws / "data").mkdir()
    (ws / "data" / "info.csv").write_text("a,b")
    (ws / ".hidden").write_text("nope")
    # SDK-managed state (sessions/checkpoints/artifacts archives) must NOT be
    # referenceable in the @ picker.
    ckpt = ws / ".floodmind" / "sessions" / "s1" / "checkpoints" / "ckpt-1"
    ckpt.mkdir(parents=True)
    (ckpt / "manifest.json").write_text("{}")
    (ckpt / "state.json").write_text("{}")

    client = create_app(StubAgent(), workspace_manager=mgr).test_client()
    client.post("/api/workspace/open", json={"path": str(ws)})

    # Root listing — hidden dirs and .floodmind excluded.
    r = client.get("/api/workspace/files")
    assert r.status_code == 200
    entries = r.get_json()["entries"]
    names = [e["name"] for e in entries]
    assert "readme.txt" in names
    assert "data" in names
    assert ".hidden" not in names
    assert ".floodmind" not in names
    for e in entries:
        assert "name" in e and "type" in e and "path" in e

    # Subdirectory.
    r = client.get("/api/workspace/files?path=data")
    subs = r.get_json()["entries"]
    assert len(subs) == 1
    assert subs[0]["name"] == "info.csv"

    # No workspace open → empty (use a separate dir so mgr2 doesn't pick up
    # the config.json persisted by mgr).
    empty_home = tmp_path / "empty"; empty_home.mkdir()
    monkeypatch.chdir(empty_home)
    mgr2 = WorkspaceManager()
    client2 = create_app(StubAgent(), workspace_manager=mgr2).test_client()
    assert client2.get("/api/workspace/files").get_json()["entries"] == []


def test_workspace_files_rejects_escape(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    mgr = WorkspaceManager()
    ws = tmp_path / "ws"; ws.mkdir()
    client = create_app(StubAgent(), workspace_manager=mgr).test_client()
    client.post("/api/workspace/open", json={"path": str(ws)})
    assert client.get("/api/workspace/files?path=../../etc").status_code == 403


def test_workspace_files_upload(tmp_path, monkeypatch):
    """POST /api/workspace/files writes base64 files into the workspace."""
    import base64
    monkeypatch.chdir(tmp_path)
    mgr = WorkspaceManager()
    ws = tmp_path / "ws"; ws.mkdir()
    client = create_app(StubAgent(), workspace_manager=mgr).test_client()
    client.post("/api/workspace/open", json={"path": str(ws)})

    content = base64.b64encode(b"hello").decode("ascii")
    r = client.post("/api/workspace/files", json={
        "files": [
            {"path": "notes.txt", "content": content},
            {"path": "sub/dir/data.csv", "content": base64.b64encode(b"a,b").decode("ascii")},
        ]
    })
    assert r.status_code == 200
    body = r.get_json()
    assert set(body["files"]) == {"notes.txt", "sub/dir/data.csv"}
    assert (ws / "notes.txt").read_bytes() == b"hello"
    assert (ws / "sub" / "dir" / "data.csv").read_bytes() == b"a,b"


def test_workspace_files_upload_rejects_escape(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    mgr = WorkspaceManager()
    ws = tmp_path / "ws"; ws.mkdir()
    client = create_app(StubAgent(), workspace_manager=mgr).test_client()
    client.post("/api/workspace/open", json={"path": str(ws)})

    assert client.post("/api/workspace/files", json={
        "files": [{"path": "../outside.txt", "content": ""}]
    }).status_code == 400


def test_session_id_for_is_stable_and_unique():
    a = session_id_for("D:/work/foo")
    b = session_id_for("D:/work/foo")
    c = session_id_for("D:/work/bar")
    assert a == b
    assert a != c
    assert a.startswith("ws-") and len(a) <= 32


def test_resolve_user_dir_normalizes_and_validates(tmp_path):
    assert resolve_user_dir(str(tmp_path)) == tmp_path.resolve()


def test_resolve_user_dir_rejects_missing():
    with pytest.raises(ValueError):
        resolve_user_dir("Z:/no/such/dir/here")


def test_workspace_manager_open_sets_current_and_recent(tmp_path, monkeypatch):
    home = tmp_path / "appdata"
    home.mkdir()
    monkeypatch.chdir(home)  # _app_data_dir() = cwd

    mgr = WorkspaceManager()
    assert mgr.current() is None

    folder1 = tmp_path / "ws1"; folder1.mkdir()
    folder2 = tmp_path / "ws2"; folder2.mkdir()

    mgr.open(str(folder1))
    assert mgr.current()["path"] == str(folder1.resolve())
    assert mgr.recent()[0]["path"] == str(folder1.resolve())

    mgr.open(str(folder2))
    assert mgr.current()["path"] == str(folder2.resolve())
    paths = [r["path"] for r in mgr.recent()]
    assert paths[0] == str(folder2.resolve())
    assert str(folder1.resolve()) in paths  # demoted, not removed

    # Persists across a new instance.
    mgr2 = WorkspaceManager()
    assert mgr2.current()["path"] == str(folder2.resolve())


def test_workspace_manager_forget_removes_from_recent(tmp_path, monkeypatch):
    home = tmp_path / "appdata"; home.mkdir()
    monkeypatch.chdir(home)
    mgr = WorkspaceManager()
    f1 = tmp_path / "ws1"; f1.mkdir()
    f2 = tmp_path / "ws2"; f2.mkdir()
    mgr.open(str(f1)); mgr.open(str(f2))   # current = f2, recent = [f2, f1]

    summary, changed = mgr.forget(str(f1.resolve()))   # forget a non-current
    paths = [r["path"] for r in summary["recent"]]
    assert str(f1.resolve()) not in paths
    assert str(f2.resolve()) in paths
    assert changed is False
    assert summary["current"]["path"] == str(f2.resolve())


def test_workspace_manager_forget_current_switches_to_next(tmp_path, monkeypatch):
    home = tmp_path / "appdata"; home.mkdir()
    monkeypatch.chdir(home)
    mgr = WorkspaceManager()
    f1 = tmp_path / "ws1"; f1.mkdir()
    f2 = tmp_path / "ws2"; f2.mkdir()
    mgr.open(str(f1)); mgr.open(str(f2))   # current = f2

    summary, changed = mgr.forget(str(f2.resolve()))   # forget current
    assert changed is True
    assert summary["current"]["path"] == str(f1.resolve())


def test_workspace_manager_forget_last_clears_current(tmp_path, monkeypatch):
    home = tmp_path / "appdata"; home.mkdir()
    monkeypatch.chdir(home)
    mgr = WorkspaceManager()
    f1 = tmp_path / "ws1"; f1.mkdir()
    mgr.open(str(f1))                       # current = f1, only entry

    summary, changed = mgr.forget(str(f1.resolve()))
    assert changed is True
    assert summary["recent"] == []
    assert summary["current"] is None


def test_workspace_forget_endpoint(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    mgr = WorkspaceManager()
    f1 = tmp_path / "ws1"; f1.mkdir()
    f2 = tmp_path / "ws2"; f2.mkdir()
    client = create_app(StubAgent(), workspace_manager=mgr).test_client()
    client.post("/api/workspace/open", json={"path": str(f1)})
    client.post("/api/workspace/open", json={"path": str(f2)})

    r = client.post("/api/workspace/forget", json={"path": str(f1.resolve())})
    assert r.status_code == 200
    paths = [x["path"] for x in r.get_json()["recent"]]
    assert str(f1.resolve()) not in paths

    # missing path -> 400
    assert client.post("/api/workspace/forget", json={}).status_code == 400
