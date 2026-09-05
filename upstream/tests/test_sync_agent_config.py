import json
import importlib.util
import sys
from pathlib import Path


def _load_sync_agent_config():
    root = Path(__file__).resolve().parents[1]
    script_path = root / "scripts" / "sync_agent_config.py"
    if str(script_path.parent) not in sys.path:
        sys.path.insert(0, str(script_path.parent))
    spec = importlib.util.spec_from_file_location("sync_agent_config", script_path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_sync_agent_config_accepts_allow_agents_key(tmp_path, monkeypatch):
    sync_agent_config = _load_sync_agent_config()

    cfg = {
        "agents": {
            "defaults": {"model": "openai/gpt-4o"},
            "list": [
                {
                    "id": "taizi",
                    "workspace": str(tmp_path / "ws-taizi"),
                    "allowAgents": ["zhongshu"]
                }
            ]
        }
    }

    cfg_path = tmp_path / "openclaw.json"
    cfg_path.write_text(json.dumps(cfg, ensure_ascii=False))

    monkeypatch.setattr(sync_agent_config, "OPENCLAW_CFG", cfg_path)
    monkeypatch.setattr(sync_agent_config, "DATA", tmp_path / "data")

    sync_agent_config.main()

    out = json.loads((tmp_path / "data" / "agent_config.json").read_text())
    taizi = next(agent for agent in out["agents"] if agent["id"] == "taizi")
    assert taizi["allowAgents"] == ["zhongshu"]


def test_sync_agent_config_keeps_explicit_runtime_agent_list_authoritative(tmp_path, monkeypatch):
    sync_agent_config = _load_sync_agent_config()
    ids = ["taizi", "zhongshu", "menxia", "shangshu", "zaochao"]
    cfg = {"agents": {"list": [{"id": agent_id} for agent_id in ids]}}
    cfg_path = tmp_path / "openclaw.json"
    cfg_path.write_text(json.dumps(cfg), encoding="utf-8")

    monkeypatch.setattr(sync_agent_config, "OPENCLAW_CFG", cfg_path)
    monkeypatch.setattr(sync_agent_config, "OPENCLAW_HOME", tmp_path / "openclaw")
    monkeypatch.setattr(sync_agent_config, "DATA", tmp_path / "data")

    sync_agent_config.main()

    out = json.loads((tmp_path / "data" / "agent_config.json").read_text(encoding="utf-8"))
    assert [agent["id"] for agent in out["agents"]] == ids
    assert "main" not in {agent["id"] for agent in out["agents"]}


def test_runtime_deployment_uses_monkeypatched_config_parent_not_import_time_home(tmp_path, monkeypatch):
    sync_agent_config = _load_sync_agent_config()
    project = tmp_path / "project"
    soul_source = project / "agents" / "taizi" / "SOUL.md"
    script_source = project / "scripts" / "kanban_update.py"
    soul_source.parent.mkdir(parents=True)
    script_source.parent.mkdir(parents=True)
    soul_source.write_text("# isolated soul\n", encoding="utf-8")
    script_source.write_text("print('isolated script')\n", encoding="utf-8")

    runtime_home = tmp_path / "configured-openclaw"
    runtime_home.mkdir()
    cfg_path = runtime_home / "openclaw.json"
    cfg_path.write_text(json.dumps({"agents": {"list": [{"id": "taizi"}]}}), encoding="utf-8")
    import_time_home = tmp_path / "must-not-be-written"

    monkeypatch.setattr(sync_agent_config, "BASE", project)
    monkeypatch.setattr(sync_agent_config, "OPENCLAW_HOME", import_time_home)
    monkeypatch.setattr(sync_agent_config, "OPENCLAW_CFG", cfg_path)
    monkeypatch.setattr(sync_agent_config, "DATA", tmp_path / "data")

    sync_agent_config.main()

    payload = json.loads((tmp_path / "data" / "agent_config.json").read_text(encoding="utf-8"))
    taizi = next(agent for agent in payload["agents"] if agent["id"] == "taizi")
    assert taizi["workspace"] == str(runtime_home / "workspace-taizi")
    assert (runtime_home / "workspace-taizi" / "SOUL.md").read_text(encoding="utf-8") == "# isolated soul\n"
    assert (runtime_home / "agents" / "main" / "SOUL.md").read_text(encoding="utf-8") == "# isolated soul\n"
    assert (runtime_home / "agents" / "taizi" / "sessions").is_dir()
    deployed_script = runtime_home / "workspace-taizi" / "scripts" / "kanban_update.py"
    assert deployed_script.is_symlink()
    assert deployed_script.resolve() == script_source.resolve()
    assert not import_time_home.exists()


def test_collect_openclaw_models_reads_legacy_and_native_provider_catalogs():
    sync_agent_config = _load_sync_agent_config()

    models = sync_agent_config._collect_openclaw_models({
        "providers": {
            "legacy-proxy": {
                "models": ["legacy-model", {"id": "shared-model"}]
            }
        },
        "models": {
            "providers": {
                "native-proxy": {
                    "models": [
                        {"id": "native-model", "name": "Native Model"},
                        {"id": "shared-model"},
                    ]
                },
                "map-proxy": {
                    "models": {"map-model": {"name": "Map Model"}}
                },
            }
        },
    })

    extras = {item["id"]: item for item in models if item["id"] in {
        "legacy-proxy/legacy-model", "native-proxy/native-model",
        "legacy-proxy/shared-model", "native-proxy/shared-model",
        "map-proxy/map-model"
    }}
    assert extras == {
        "legacy-proxy/legacy-model": {"id": "legacy-proxy/legacy-model", "label": "legacy-model", "provider": "legacy-proxy"},
        "native-proxy/native-model": {"id": "native-proxy/native-model", "label": "native-model", "provider": "native-proxy"},
        "legacy-proxy/shared-model": {"id": "legacy-proxy/shared-model", "label": "shared-model", "provider": "legacy-proxy"},
        "native-proxy/shared-model": {"id": "native-proxy/shared-model", "label": "shared-model", "provider": "native-proxy"},
        "map-proxy/map-model": {"id": "map-proxy/map-model", "label": "map-model", "provider": "map-proxy"},
    }


def test_collect_openclaw_models_ignores_malformed_provider_entries():
    sync_agent_config = _load_sync_agent_config()

    models = sync_agent_config._collect_openclaw_models({
        "providers": {"not-a-provider": None, "empty": {"models": "invalid"}},
        "models": {"providers": {"valid": {"models": [None, {}, {"id": "valid-model"}]}}},
    })

    assert any(item["id"] == "valid/valid-model" and item["provider"] == "valid" for item in models)
    assert not any(item["id"] in {"", "None"} for item in models)


def test_collect_openclaw_models_excludes_builtin_catalogs_and_agent_models():
    sync_agent_config = _load_sync_agent_config()

    models = sync_agent_config._collect_openclaw_models({
        "models": {
            "providers": {
                "openai": {"models": [{"id": "gpt-4o"}]},
                "custom": {"models": [{"id": "gpt-5.6-terra"}]},
            }
        },
        "agents": {
            "defaults": {"model": "openai/gpt-4o"},
            "list": [{"id": "taizi", "model": "custom/gpt-5.6-terra"}],
        },
    })

    assert [item["id"] for item in models] == ["custom/gpt-5.6-terra"]
