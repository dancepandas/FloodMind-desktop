def test_read_workspace_file(client, tmp_path, monkeypatch):
    monkeypatch.setenv("FLOODMIND_DESKTOP_WORKSPACE", str(tmp_path))
    (tmp_path / "hello.txt").write_text("world", encoding="utf-8")
    r = client.get("/api/workspace/file?path=hello.txt")
    assert r.status_code == 200
    assert r.get_json()["content"] == "world"


def test_read_workspace_file_forbidden(client, tmp_path, monkeypatch):
    monkeypatch.setenv("FLOODMIND_DESKTOP_WORKSPACE", str(tmp_path))
    r = client.get("/api/workspace/file?path=../etc/passwd")
    assert r.status_code == 403
