import pytest

from floodmind_desktop_sidecar.workspace import session_id_for, resolve_user_dir, WorkspaceManager


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
