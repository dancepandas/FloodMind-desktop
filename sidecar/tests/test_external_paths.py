import json
from pathlib import Path

from floodmind_desktop_sidecar.app import create_app
from floodmind_desktop_sidecar.agent import StubAgent
from floodmind_desktop_sidecar.external_paths import (
    add_external_paths,
    read_external_paths,
    remove_external_path,
)
from floodmind_desktop_sidecar.floodmind_agent import FloodMindAgent


def test_add_remove_roundtrip(tmp_path):
    f = tmp_path / "report.xlsx"
    f.write_bytes(b"x")
    out = add_external_paths(str(tmp_path), [str(f), str(f)])
    assert out == [str(f.resolve())]
    assert read_external_paths(str(tmp_path)) == [str(f.resolve())]
    cfg = tmp_path / ".floodmind" / "external-read-paths.json"
    assert cfg.exists()
    assert json.loads(cfg.read_text(encoding="utf-8")) == {"paths": [str(f.resolve())]}
    out2 = remove_external_path(str(tmp_path), str(f))
    assert out2 == []
    assert read_external_paths(str(tmp_path)) == []


def test_add_keeps_folders_and_filters_missing(tmp_path):
    """Dropped FOLDERS are authorized (whole-tree read); missing paths are dropped."""
    existing_file = tmp_path / "a.txt"
    existing_file.write_text("hi")
    folder = tmp_path / "dir"
    folder.mkdir()
    missing = tmp_path / "gone.txt"
    out = add_external_paths(str(tmp_path), [str(existing_file), str(folder), str(missing)])
    assert out == sorted([str(existing_file.resolve()), str(folder.resolve())])


def test_build_workspace_for_path_injects_readable_roots(tmp_path, monkeypatch):
    """_build_workspace_for_path passes the registered external file as a readable_root."""
    f = tmp_path / "external.txt"
    f.write_text("hi")
    add_external_paths(str(tmp_path), [str(f)])
    captured = {}

    def fake_build(session_id, *, primary_dir=None, writable_roots=(), readable_roots=(), overwrite_protection=False):
        captured["primary_dir"] = str(primary_dir)
        captured["readable_roots"] = tuple(readable_roots)

        class FakeWs:
            workspace_dir = Path(str(primary_dir))

            def ensure(self):
                return self

        return FakeWs()

    monkeypatch.setattr(
        "floodmind.agent.runtime.services.workspace_service.build_folder_workspace",
        fake_build,
    )
    agent = FloodMindAgent.__new__(FloodMindAgent)
    ws = agent._build_workspace_for_path("sid", str(tmp_path))
    assert captured["primary_dir"] == str(tmp_path)
    assert captured["readable_roots"] == (str(f.resolve()),)
    assert ws is not None


def test_real_folder_workspace_file_readable_root_allows_only_that_file(tmp_path):
    """An exact FILE readable_root grants read of only that file, never write."""
    from floodmind.agent.runtime.services.path_service import PathService
    from floodmind.agent.runtime.services.workspace_service import build_folder_workspace

    ws_dir = tmp_path / "ws"
    ws_dir.mkdir()
    outside = tmp_path / "outside"
    outside.mkdir()
    target = outside / "target.txt"
    target.write_text("hi")
    sibling = outside / "sibling.txt"
    sibling.write_text("yo")

    ws = build_folder_workspace("test-session", primary_dir=ws_dir, readable_roots=(target,))
    svc = PathService(workspace=ws)
    assert svc.is_read_allowed(target) is True  # the granted file
    assert svc.is_read_allowed(sibling) is False  # sibling NOT granted
    assert svc.is_write_allowed(target) is False  # read-only grant, no write


def test_registered_path_is_readable_through_real_workspace_build(tmp_path):
    """Full chain: register → real _build_workspace_for_path → PathService allows.

    No monkeypatching: proves a registration the frontend POSTs actually reaches
    the SDK read allow-list (the step that turns "不在允许目录内" into the ASK flow).
    A dropped FOLDER grants its whole tree (files under it become readable).
    """
    from floodmind.agent.runtime.services.path_service import PathService

    ws_root = tmp_path / "ws"
    ws_root.mkdir()
    outside = tmp_path / "outside"
    outside.mkdir()
    target = outside / "report.xlsx"
    target.write_bytes(b"x")
    folder = tmp_path / "skill-dir"
    folder.mkdir()
    (folder / "SKILL.md").write_text("# skill")
    internal = ws_root / "inside.txt"
    internal.write_text("hi")

    add_external_paths(str(ws_root), [str(target), str(folder)])
    agent = FloodMindAgent.__new__(FloodMindAgent)
    ws = agent._build_workspace_for_path("sid", str(ws_root))
    svc = PathService(workspace=ws)
    assert svc.is_read_allowed(target) is True  # registered external file
    assert svc.is_read_allowed(folder) is True  # registered external folder
    assert svc.is_read_allowed(folder / "SKILL.md") is True  # tree under folder
    assert svc.is_read_allowed(internal) is True  # workspace root still covers internals


def test_external_paths_routes(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    f = tmp_path / "ext.txt"
    f.write_text("hi")
    client = create_app(StubAgent()).test_client()

    r = client.get("/api/external-paths")
    assert r.status_code == 200
    assert r.get_json() == {"paths": []}

    r = client.post("/api/external-paths", json={"paths": [str(f)]})
    assert r.status_code == 200
    assert r.get_json()["paths"] == [str(f.resolve())]

    r = client.post("/api/external-paths", json={"paths": []})
    assert r.status_code == 400

    r = client.get("/api/external-paths")
    assert r.get_json()["paths"] == [str(f.resolve())]

    r = client.delete("/api/external-paths", json={"path": str(f)})
    assert r.status_code == 200
    assert r.get_json()["paths"] == []
