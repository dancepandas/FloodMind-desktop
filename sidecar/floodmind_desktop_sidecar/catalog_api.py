from __future__ import annotations

import json
import re
import shutil
from pathlib import Path
from typing import Any

SKILL_NAME_RE = re.compile(r"^[a-z0-9_-]+$")
_BUILTIN_SKILL_NAMES: set[str] | None = None


def _settings_path() -> Path:
    from floodmind.config.settings import _config_path
    return _config_path()


def _write_skill_meta(skill_dir: Path, name: str, description: str, category: str, version: str) -> dict[str, Any]:
    meta = {"name": name, "description": description, "category": category, "version": version, "provides_tools": []}
    (skill_dir / "meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
    return meta


def _skills_home() -> Path:
    from floodmind.config.settings import get_floodmind_home
    home = get_floodmind_home()
    home.mkdir(parents=True, exist_ok=True)
    skills_dir = home / "skills"
    skills_dir.mkdir(exist_ok=True)
    return skills_dir


def _builtin_skill_names() -> set[str]:
    global _BUILTIN_SKILL_NAMES
    if _BUILTIN_SKILL_NAMES is None:
        try:
            from floodmind.skills.registry import get_skill_registry
            reg = get_skill_registry()
            _BUILTIN_SKILL_NAMES = {s["name"] for s in reg.list_skills()}
        except Exception:
            _BUILTIN_SKILL_NAMES = set()
    return _BUILTIN_SKILL_NAMES


def _skills_disabled_path() -> Path:
    return _skills_home() / "disabled.json"


def _legacy_skills_disabled_from_settings() -> list[str]:
    """Fallback: read disabled list from settings.json (pre-migration)."""
    path = _settings_path()
    if not path.exists():
        return []
    try:
        cfg = json.loads(path.read_text(encoding="utf-8"))
        disabled = (cfg.get("skills") or {}).get("disabled") or []
        return [str(x) for x in disabled if isinstance(x, str)]
    except Exception:
        return []


def read_skills_disabled() -> list[str]:
    path = _skills_disabled_path()
    if path.exists():
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            disabled = data.get("disabled") or []
            return [str(x) for x in disabled if isinstance(x, str)]
        except Exception:
            return []
    # One-time migration from settings.json; next write will create disabled.json.
    return _legacy_skills_disabled_from_settings()


def write_skills_disabled(disabled: list[str]) -> None:
    path = _skills_disabled_path()
    path.write_text(
        json.dumps({"disabled": list(dict.fromkeys(disabled))}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def apply_skills_disabled() -> None:
    disabled = set(read_skills_disabled())
    try:
        from floodmind.skills.registry import get_skill_registry
        reg = get_skill_registry()
        # Populate the built-in name cache before any custom skills are
        # registered, so list_builtin_skills() stays accurate after startup.
        _builtin_skill_names()
        for skill in reg.list_skills():
            name = skill.get("name")
            if not name:
                continue
            try:
                reg.set_disabled(name, name in disabled)
            except Exception:
                pass
    except Exception:
        pass


def list_builtin_skills() -> list[str]:
    """Return the names of SDK built-in skills.

    Uses the cached set populated by `apply_skills_disabled()` so custom skills
    registered later are not misclassified as built-in.
    """
    return sorted(_builtin_skill_names())


def _register_custom_skills() -> None:
    home = _skills_home()
    try:
        from floodmind.skills.skill_curator import discover_skills
        from floodmind.skills.registry import get_skill_registry
        skills = discover_skills(home)
        reg = get_skill_registry()
        for skill in skills:
            try:
                reg.register_skill(skill)
            except Exception:
                pass
    except Exception:
        pass


def list_custom_skills() -> list[dict[str, Any]]:
    """Return metadata for custom skills persisted under the skills home."""
    home = _skills_home()
    disabled = set(read_skills_disabled())
    skills: list[dict[str, Any]] = []
    for skill_dir in home.iterdir():
        if not skill_dir.is_dir():
            continue
        meta_path = skill_dir / "meta.json"
        if not meta_path.exists():
            continue
        try:
            meta = json.loads(meta_path.read_text(encoding="utf-8"))
            meta["disabled"] = meta.get("name") in disabled
            meta["builtin"] = False
            skills.append(meta)
        except Exception:
            continue
    return skills


def create_skill(name: str, description: str, category: str, version: str, prompt: str) -> dict[str, Any]:
    if not SKILL_NAME_RE.match(name):
        raise ValueError("skill name must match [a-z0-9_-]+")
    if name in _builtin_skill_names():
        raise ValueError("cannot create skill with same name as built-in")
    skill_dir = _skills_home() / name
    if skill_dir.exists():
        raise ValueError("skill already exists")
    skill_dir.mkdir(parents=True)
    (skill_dir / "SKILL.md").write_text(prompt, encoding="utf-8")
    meta = _write_skill_meta(skill_dir, name, description, category, version)
    _register_custom_skills()
    return meta


def update_skill(name: str, description: str, category: str, version: str, prompt: str) -> dict[str, Any]:
    if name in _builtin_skill_names():
        raise PermissionError("cannot edit built-in skill")
    skill_dir = _skills_home() / name
    if not skill_dir.exists() or not (skill_dir / "SKILL.md").exists():
        raise ValueError("skill not found")
    (skill_dir / "SKILL.md").write_text(prompt, encoding="utf-8")
    meta = _write_skill_meta(skill_dir, name, description, category, version)
    _register_custom_skills()
    return meta


def delete_skill(name: str) -> None:
    if name in _builtin_skill_names():
        raise PermissionError("cannot delete built-in skill")
    skill_dir = _skills_home() / name
    if not skill_dir.exists():
        raise ValueError("skill not found")
    shutil.rmtree(skill_dir)
    try:
        from floodmind.skills.registry import get_skill_registry
        get_skill_registry().set_disabled(name, True)
    except Exception:
        pass
    _register_custom_skills()


def _mcp_path() -> Path:
    from floodmind.config.settings import get_floodmind_home
    home = get_floodmind_home()
    home.mkdir(parents=True, exist_ok=True)
    return home / "mcp.json"


def read_mcp_config() -> list[dict[str, Any]]:
    path = _mcp_path()
    if not path.exists():
        return []
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        servers = data.get("servers") or []
        return [s for s in servers if isinstance(s, dict)]
    except Exception:
        return []


def _reconnect_mcp(servers: list[dict[str, Any]]) -> None:
    try:
        from floodmind.agent.mcp_client import get_mcp_client_pool
        pool = get_mcp_client_pool()
        pool.disconnect_all()
        pool.connect_all(servers)
    except Exception:
        pass


def _validate_mcp_server_transport(server_config: dict[str, Any]) -> None:
    transport = server_config.get("transport")
    if transport not in {"stdio", "sse"}:
        raise ValueError(f"invalid MCP transport {transport!r} for server {server_config.get('name')!r}; must be 'stdio' or 'sse'")


def write_mcp_config(servers: list[dict[str, Any]]) -> None:
    for server in servers:
        _validate_mcp_server_transport(server)
    path = _mcp_path()
    path.write_text(json.dumps({"servers": servers}, ensure_ascii=False, indent=2), encoding="utf-8")
    _reconnect_mcp(servers)


def test_mcp_server(server_config: dict[str, Any]) -> dict[str, Any]:
    """Probe an MCP server with a real handshake (initialize + tools/list).

    On success the connection STAYS in the pool — so the UI status reflects it
    (the caller refreshes the list) and we don't disconnect a server that was
    already working. On failure the connection was never stored, so the pool is
    left untouched."""
    _validate_mcp_server_transport(server_config)
    try:
        from floodmind.agent.mcp_client import get_mcp_client_pool

        pool = get_mcp_client_pool()
        conn = pool.connect_server(server_config)  # raises on a real failure
        return {"ok": True, "error": None, "tools": len(conn.list_tools())}
    except Exception as e:
        return {"ok": False, "error": str(e)}
