from floodmind_desktop_sidecar.task_index import TaskIndex


def test_set_get_remove_roundtrip(tmp_path):
    idx = TaskIndex(tmp_path)
    assert idx.get("sched_aaa") is None
    idx.set("sched_aaa", "/ws/A")
    assert idx.get("sched_aaa") == "/ws/A"
    idx.remove("sched_aaa")
    assert idx.get("sched_aaa") is None


def test_persists_to_disk(tmp_path):
    idx = TaskIndex(tmp_path)
    idx.set("sched_aaa", "/ws/A")
    idx.set("sched_bbb", "/ws/B")
    # A fresh instance reads the same file.
    idx2 = TaskIndex(tmp_path)
    assert idx2.all() == {"sched_aaa": "/ws/A", "sched_bbb": "/ws/B"}


def test_remove_missing_is_noop(tmp_path):
    idx = TaskIndex(tmp_path)
    idx.remove("nope")  # must not raise
    assert idx.all() == {}


def test_overwrite_existing(tmp_path):
    idx = TaskIndex(tmp_path)
    idx.set("sched_aaa", "/ws/A")
    idx.set("sched_aaa", "/ws/C")
    assert idx.get("sched_aaa") == "/ws/C"


def test_corrupt_file_degrades_to_empty(tmp_path):
    (tmp_path / "task_index.json").write_text("{not json", encoding="utf-8")
    idx = TaskIndex(tmp_path)
    assert idx.all() == {}   # corrupt -> empty, not a crash
