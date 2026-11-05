import json
from pathlib import Path

import pytest

from floodmind_desktop_sidecar.permissions import (
    PermissionCache,
    PermissionMode,
    permission_fingerprint,
)


def test_permission_mode_enum():
    assert PermissionMode.ALWAYS_TRUST.value == "always-trust"
    assert PermissionMode.TRUST_ONCE.value == "trust-once"
    assert PermissionMode.ALWAYS_ASK.value == "always-ask"


def test_fingerprint_bash_uses_full_command():
    a = permission_fingerprint("Bash", {"command": "echo hello"})
    b = permission_fingerprint("Bash", {"command": "echo world"})
    c = permission_fingerprint("Bash", {"command": "echo hello"})
    assert a != b
    assert a == c


def test_fingerprint_write_file_uses_path(tmp_path):
    a = permission_fingerprint("WriteFile", {"path": str(tmp_path / "a.txt")})
    b = permission_fingerprint("WriteFile", {"path": str(tmp_path / "b.txt")})
    assert a != b


def test_fingerprint_read_file_workspace_internal(tmp_path):
    # The SDK's read tool is `Read` (input key `file_path`); workspace-internal
    # reads share one fingerprint.
    internal = tmp_path / "file.txt"
    a = permission_fingerprint("Read", {"file_path": str(internal)}, workspace_path=str(tmp_path))
    b = permission_fingerprint("Read", {"file_path": str(tmp_path / "other.txt")}, workspace_path=str(tmp_path))
    assert a == b  # workspace-internal reads share a fingerprint


def test_fingerprint_read_file_external(tmp_path):
    external = tmp_path.parent / "outside.txt"
    a = permission_fingerprint("Read", {"file_path": str(external)}, workspace_path=str(tmp_path))
    b = permission_fingerprint("Read", {"file_path": str(tmp_path / "inside.txt")}, workspace_path=str(tmp_path))
    assert a != b


def test_permission_cache_load_save(tmp_path):
    cache = PermissionCache(str(tmp_path))
    fp = permission_fingerprint("Bash", {"command": "ls"})
    assert not cache.is_approved(fp)
    cache.approve(fp)
    assert cache.is_approved(fp)

    # Re-create cache to verify persistence.
    cache2 = PermissionCache(str(tmp_path))
    assert cache2.is_approved(fp)


def test_permission_cache_clear(tmp_path):
    cache = PermissionCache(str(tmp_path))
    fp = permission_fingerprint("Bash", {"command": "ls"})
    cache.approve(fp)
    cache.clear()
    assert not cache.is_approved(fp)
    # File should also be empty.
    path = tmp_path / ".floodmind" / "permissions.json"
    data = json.loads(path.read_text(encoding="utf-8"))
    assert data["approved"] == []


def test_permission_cache_no_workspace():
    cache = PermissionCache(None)
    fp = permission_fingerprint("Bash", {"command": "ls"})
    cache.approve(fp)  # should not crash
    assert cache.is_approved(fp)  # in-memory approval works even without persistence
