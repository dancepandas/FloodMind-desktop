"""Tests for the catalog CRUD helpers."""
import importlib

from floodmind_desktop_sidecar import catalog_api


def test_read_write_skills_disabled(tmp_path, monkeypatch):
    settings_mod = importlib.import_module("floodmind.config.settings")
    monkeypatch.setattr(settings_mod, "_config_path", lambda: tmp_path / "settings.json")

    assert catalog_api.read_skills_disabled() == []
    catalog_api.write_skills_disabled(["csv", "pdf"])
    assert catalog_api.read_skills_disabled() == ["csv", "pdf"]
    catalog_api.write_skills_disabled([])
    assert catalog_api.read_skills_disabled() == []
