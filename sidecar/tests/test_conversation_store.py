from pathlib import Path

from floodmind_desktop_sidecar.conversation_store import ConversationStore


def _store(tmp_path):
    # Deterministic, strictly-increasing clock so ordering + updated_at are stable.
    ticks = iter(range(10_000))
    clock = lambda: __import__("datetime").datetime(2026, 1, 1, 0, 0, second=next(ticks))  # noqa: E731
    return ConversationStore(tmp_path, clock=clock)


def test_create_assigns_ids_and_persists(tmp_path):
    s = _store(tmp_path)
    rec = s.create("/ws/A", title="hello")
    assert rec["id"].startswith("conv-")
    assert rec["session_id"]                   # non-empty uuid hex
    assert rec["workspace"] == "/ws/A"
    assert rec["title"] == "hello"
    assert rec["turns"] == []
    assert rec["created_at"] == rec["updated_at"]
    # Persisted to disk.
    assert s.get(rec["id"]) == rec


def test_list_filters_by_workspace_and_marks_active(tmp_path):
    s = _store(tmp_path)
    a1 = s.create("/ws/A")
    a2 = s.create("/ws/A")
    b1 = s.create("/ws/B")
    # create() sets active -> a2 is A's active, b1 is B's active.
    items = s.list("/ws/A")
    assert {i["id"] for i in items} == {a1["id"], a2["id"]}
    assert next(i for i in items if i["id"] == a2["id"])["active"] is True
    assert next(i for i in items if i["id"] == a1["id"])["active"] is False
    assert {i["id"] for i in s.list("/ws/B")} == {b1["id"]}
    # list items carry only summary fields.
    assert set(items[0]) == {"id", "title", "updated_at", "active"}


def test_list_orders_by_updated_at_desc(tmp_path):
    s = _store(tmp_path)
    old = s.create("/ws/A")
    new = s.create("/ws/A")
    s.append_turns(old["id"], [{"role": "user", "content": "x"}])  # bumps old's updated_at later
    ids = [i["id"] for i in s.list("/ws/A")]
    assert ids[0] == old["id"]                    # most-recently-updated first
    assert ids[1] == new["id"]


def test_append_turns_extends_and_bumps_updated_at(tmp_path):
    s = _store(tmp_path)
    rec = s.create("/ws/A")
    before = rec["updated_at"]
    out = s.append_turns(rec["id"], [{"role": "user", "content": "hi"}, {"role": "assistant", "blocks": []}])
    assert len(out["turns"]) == 2
    assert out["updated_at"] >= before
    assert s.get(rec["id"])["turns"] == [
        {"role": "user", "content": "hi"},
        {"role": "assistant", "blocks": []},
    ]


def test_append_turns_missing_returns_none(tmp_path):
    s = _store(tmp_path)
    assert s.append_turns("conv-nope", []) is None


def test_update_title(tmp_path):
    s = _store(tmp_path)
    rec = s.create("/ws/A")
    assert s.update_title(rec["id"], "新标题") is True
    assert s.get(rec["id"])["title"] == "新标题"
    assert s.update_title("conv-nope", "x") is False


def test_delete_removes_record_memory_dir_and_clears_active(tmp_path):
    s = _store(tmp_path)
    rec = s.create("/ws/A")
    # Simulate the SDK memory dir the agent would create: <root>/<session_id>/memory
    mem = tmp_path / rec["session_id"] / "memory"
    mem.mkdir(parents=True)
    (mem / "chat_history.json").write_text("{}", encoding="utf-8")

    sid = s.delete(rec["id"])
    assert sid == rec["session_id"]
    assert s.get(rec["id"]) is None              # record gone
    assert not mem.exists()                      # memory dir gone
    assert s.get_active("/ws/A") is None         # active pointer cleared
    assert s.delete(rec["id"]) is None           # already gone -> None


def test_set_and_get_active(tmp_path):
    s = _store(tmp_path)
    a = s.create("/ws/A")
    b = s.create("/ws/A")
    s.set_active("/ws/A", a["id"])
    assert s.get_active("/ws/A") == a["id"]
    assert next(i for i in s.list("/ws/A") if i["id"] == a["id"])["active"] is True


def test_traversal_conv_id_is_treated_as_missing(tmp_path):
    """A conv_id from the URL path must not escape the store root (C2)."""
    s = _store(tmp_path)
    # Drop a sibling file outside the conversations dir that a traversal would hit.
    victim = tmp_path / "secret.json"
    victim.write_text('{"pwned": true}', encoding="utf-8")

    bad = "../../secret"
    assert s.get(bad) is None
    assert s.append_turns(bad, [{"role": "user", "content": "x"}]) is None
    assert s.update_title(bad, "hax") is False
    assert s.delete(bad) is None
    # Nothing outside the store was touched.
    assert victim.read_text(encoding="utf-8") == '{"pwned": true}'


def test_invalid_format_conv_id_is_missing(tmp_path):
    s = _store(tmp_path)
    assert s.get("conv-nope") is None
    assert s.get("not-a-conv-id") is None
    assert s.delete("conv-deadbeefdeadbeef") is None  # 16 hex chars, wrong length
