"""Tests for the catalog CRUD helpers."""
import json
import pytest

from floodmind_desktop_sidecar.app import create_app
from floodmind_desktop_sidecar.agent import StubAgent


def _client():
    return create_app(StubAgent()).test_client()


def test_read_write_skills_disabled(tmp_path, monkeypatch):
    from floodmind_desktop_sidecar import catalog_api
    monkeypatch.setattr(catalog_api, "_settings_path", lambda: tmp_path / "settings.json")
    assert catalog_api.read_skills_disabled() == []
    catalog_api.write_skills_disabled(["csv", "pdf"])
    assert catalog_api.read_skills_disabled() == ["csv", "pdf"]
    catalog_api.write_skills_disabled([])
    assert catalog_api.read_skills_disabled() == []
