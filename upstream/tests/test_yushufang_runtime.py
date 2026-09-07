"""The discussion runtime must never inherit ordinary execution permissions."""
import json
import os
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "dashboard"))
sys.path.insert(0, str(ROOT / "scripts"))
from yushufang_runtime import prepare_local_dispatch_runtime, prepare_runtime, resolve_thinking, DENIED_TOOLS
import pytest


def test_thinking_preserves_requested_levels_without_aliasing_max_to_xhigh():
    capability = {"model": "custom/gpt-5.5", "reasoning": True,
                  "supportedReasoningEfforts": ["low", "medium", "high", "xhigh"]}
    for level in ["low", "medium", "high"]:
        assert resolve_thinking(level, capability) == level
    with pytest.raises(ValueError, match="未声明支持 max"):
        resolve_thinking("max", capability)
    capability["supportedReasoningEfforts"].append("max")
    assert resolve_thinking("max", capability) == "max"
    capability["reasoning"] = False
    with pytest.raises(ValueError, match="不支持所选思考档位"):
        resolve_thinking("medium", capability)


def test_incompatible_thinking_is_not_silently_downgraded():
    with pytest.raises(ValueError, match="未声明支持 max"):
        resolve_thinking("max", {"model": "custom/limited", "supportedReasoningEfforts": ["medium"]})


def test_none_resolves_to_documented_runtime_carrier_not_off():
    cap = {"model": "custom/gpt-5.6-terra", "levels": ["default", "none", "high"],
           "mapping": {"default": "default", "none": "minimal", "high": "high"},
           "wireMapping": {"none": "none", "high": "high"}}
    assert resolve_thinking("none", cap) == "minimal"
    assert resolve_thinking("minimal", cap) == "minimal"
    assert resolve_thinking("default", cap) == "default"


def source_config(tmp_path):
    workspace = tmp_path / "ordinary-workspace"
    skill = workspace / "skills" / "review"
    skill.mkdir(parents=True)
    (skill / "SKILL.md").write_text("# Review\nReview risks.", encoding="utf-8")
    (skill / "danger.sh").write_text("exit 1", encoding="utf-8")
    (workspace / "MEMORY.md").write_text("PRIVATE_OTHER_ROOM", encoding="utf-8")
    config = {
        "agents": {
            "defaults": {"model": "test/model"},
            "list": [{"id": "alpha", "workspace": str(workspace), "skills": ["review"], "tools": {"profile": "full"}}],
        },
        "models": {"providers": {"test": {"baseUrl": "http://127.0.0.1:1/v1", "api": "openai-completions",
            "apiKey": "fixture-secret-only", "models": [{"id": "model", "name": "Model"}],
            "agentRuntime": {"id": "codex"}, "localService": {"command": "/bin/false"}}}},
        "mcp": {"servers": {"docs": {"transport": "streamable-http", "url": "http://127.0.0.1:2/mcp"}}},
        "tools": {"web": {"search": {"enabled": False}, "fetch": {"enabled": True}}},
    }
    path = tmp_path / "original.json"
    path.write_text(json.dumps(config), encoding="utf-8")
    return path


def test_runtime_isolated_model_and_native_tool_policy(tmp_path):
    source = source_config(tmp_path)
    original = source.read_bytes()
    root = tmp_path / "room" / "alpha"
    config, env, summary = prepare_runtime(root, "alpha", source)
    assert source.read_bytes() == original
    assert summary["model"] == "test/model"
    assert summary["skills"] == ["review"]
    assert summary["webSearch"] is False
    assert set(DENIED_TOOLS) <= set(config["tools"]["deny"])
    assert config["tools"]["fs"]["workspaceOnly"]
    assert config["agents"]["list"][0]["subagents"]["allowAgents"] == []
    assert "bundle-mcp" in config["tools"]["allow"]
    assert config["agents"]["defaults"]["models"]["test/model"]["agentRuntime"]["id"] == "openclaw"
    assert "localService" not in config["models"]["providers"]["test"]
    assert "tools/call" not in config["mcp"]["servers"]["docs"]["toolFilter"]["include"]
    assert "exec" not in config["tools"]["allow"]
    child_config = json.loads((root / "openclaw.json").read_text())
    assert "fixture-secret-only" not in (root / "openclaw.json").read_text()
    assert child_config["models"]["providers"]["test"]["apiKey"] == "OPENAI_API_KEY"
    assert child_config["models"]["providers"]["test"]["headers"]["User-Agent"] == "Edict_InnerCourt"
    assert env["OPENAI_API_KEY"] == "fixture-secret-only"
    assert pathlib.Path(env["OPENCLAW_CONFIG_PATH"]) == root / "openclaw.json"
    assert (root / "workspace" / "skills" / "review" / "SKILL.md").exists()
    assert not list((root / "workspace").rglob("*.sh"))
    assert not (root / "workspace" / "MEMORY.md").exists()


def test_runtime_shared_mode_reuses_canonical_workspace_without_cleaning_it(tmp_path):
    source = source_config(tmp_path)
    workspace = tmp_path / "ordinary-workspace"
    session_store = tmp_path / "canonical-home" / "agents" / "alpha" / "sessions" / "sessions.json"
    state_dir = tmp_path / "canonical-home"

    config, env, summary = prepare_runtime(
        tmp_path / "room" / "alpha",
        "alpha",
        source,
        shared_session=True,
        session_store=session_store,
        state_dir=state_dir,
    )

    assert summary["sessionMode"] == "shared"
    assert summary["memoryAccess"] == "canonical-agent-memory-read-only"
    assert config["agents"]["defaults"]["workspace"] == str(workspace)
    assert config["session"]["store"] == str(session_store)
    assert config["tools"]["fs"]["workspaceOnly"] is True
    assert "memory_search" in config["tools"]["allow"]
    assert "memory_get" in config["tools"]["allow"]
    assert "memory_search" not in config["tools"]["deny"]
    assert "memory_get" not in config["tools"]["deny"]
    assert env["OPENCLAW_STATE_DIR"] == str(state_dir)
    assert env["OPENCLAW_HOME"] == str(state_dir)
    assert (workspace / "skills" / "review" / "SKILL.md").exists()
    assert (workspace / "skills" / "review" / "danger.sh").exists()
    assert (workspace / "MEMORY.md").read_text(encoding="utf-8") == "PRIVATE_OTHER_ROOM"


def test_existing_env_secret_ref_is_materialized_to_child_env_marker(tmp_path):
    source = source_config(tmp_path)
    config = json.loads(source.read_text())
    config["models"]["providers"]["test"]["apiKey"] = {
        "source": "env", "provider": "default", "id": "PARENT_PROVIDER_KEY"
    }
    source.write_text(json.dumps(config), encoding="utf-8")

    # The real desktop dashboard inherits this variable from Electron's
    # in-memory provider environment.  It must not require a gateway token.
    import os
    previous = os.environ.get("PARENT_PROVIDER_KEY")
    os.environ["PARENT_PROVIDER_KEY"] = "fixture-env-secret"
    try:
        child_root = tmp_path / "room" / "alpha"
        child_config, env, _ = prepare_runtime(child_root, "alpha", source)
    finally:
        if previous is None:
            os.environ.pop("PARENT_PROVIDER_KEY", None)
        else:
            os.environ["PARENT_PROVIDER_KEY"] = previous

    assert child_config["models"]["providers"]["test"]["apiKey"] == "OPENAI_API_KEY"
    assert env["OPENAI_API_KEY"] == "fixture-env-secret"
    assert "PARENT_PROVIDER_KEY" not in json.dumps(child_config)


def test_local_dispatch_runtime_keeps_agent_policy_but_avoids_gateway_secret_resolution(tmp_path):
    source = source_config(tmp_path)
    config = json.loads(source.read_text())
    config["models"]["providers"]["test"]["apiKey"] = {
        "source": "env", "provider": "default", "id": "PARENT_PROVIDER_KEY"
    }
    source.write_text(json.dumps(config), encoding="utf-8")

    child_config, env, summary = prepare_local_dispatch_runtime(
        tmp_path / "dispatch" / "alpha",
        "alpha",
        source,
        base_environment={"PARENT_PROVIDER_KEY": "fixture-local-secret"},
    )

    assert summary["model"] == "test/model"
    assert child_config["agents"]["list"][0]["workspace"] == str(tmp_path / "ordinary-workspace")
    assert child_config["models"]["mode"] == "replace"
    assert list(child_config["models"]["providers"]) == ["test"]
    assert child_config["models"]["providers"]["test"]["apiKey"] == "OPENAI_API_KEY"
    assert env["OPENAI_API_KEY"] == "fixture-local-secret"
    assert "fixture-local-secret" not in (tmp_path / "dispatch" / "alpha" / "openclaw.json").read_text()
    assert env["OPENCLAW_CONFIG_PATH"].endswith("/dispatch/alpha/openclaw.json")


def test_existing_env_secret_ref_without_injected_value_is_actionable(tmp_path):
    source = source_config(tmp_path)
    config = json.loads(source.read_text())
    config["models"]["providers"]["test"]["apiKey"] = {
        "source": "env", "provider": "default", "id": "MISSING_PROVIDER_KEY"
    }
    source.write_text(json.dumps(config), encoding="utf-8")

    with pytest.raises(ValueError, match="密钥未注入"):
        prepare_runtime(tmp_path / "room" / "alpha", "alpha", source)


def test_existing_openai_env_marker_is_not_treated_as_literal_key(tmp_path, monkeypatch):
    source = source_config(tmp_path)
    config = json.loads(source.read_text())
    config["models"]["providers"]["test"]["apiKey"] = "OPENAI_API_KEY"
    source.write_text(json.dumps(config), encoding="utf-8")
    monkeypatch.setenv("OPENAI_API_KEY", "fixture-marker-secret")

    child_config, env, _ = prepare_runtime(tmp_path / "room" / "alpha", "alpha", source)

    assert child_config["models"]["providers"]["test"]["apiKey"] == "OPENAI_API_KEY"
    assert env["OPENAI_API_KEY"] == "fixture-marker-secret"


def test_host_only_openai_provider_url_is_normalized_for_room_runtime(tmp_path):
    source = source_config(tmp_path)
    config = json.loads(source.read_text())
    config["models"]["providers"]["test"]["baseUrl"] = "https://api.example.com"
    source.write_text(json.dumps(config), encoding="utf-8")

    child_config, _, _ = prepare_runtime(tmp_path / "room" / "alpha", "alpha", source)

    assert child_config["models"]["providers"]["test"]["baseUrl"] == "https://api.example.com/v1"


def test_explicit_custom_openai_provider_path_is_preserved(tmp_path):
    source = source_config(tmp_path)
    config = json.loads(source.read_text())
    config["models"]["providers"]["test"]["baseUrl"] = "https://gateway.example/api/v1"
    source.write_text(json.dumps(config), encoding="utf-8")

    child_config, _, _ = prepare_runtime(tmp_path / "room" / "alpha", "alpha", source)

    assert child_config["models"]["providers"]["test"]["baseUrl"] == "https://gateway.example/api/v1"


def test_mcp_filters_never_broaden_existing_policy(tmp_path):
    source = source_config(tmp_path)
    config = json.loads(source.read_text())
    config["mcp"]["servers"]["docs"]["toolFilter"] = {"include": ["resources_*"], "exclude": ["resources_read"]}
    source.write_text(json.dumps(config))
    overlay, _, _ = prepare_runtime(tmp_path / "room", "alpha", source)
    assert overlay["mcp"]["servers"]["docs"]["toolFilter"]["include"] == ["resources_list"]


def test_disabled_mcp_servers_do_not_add_unknown_bundle_mcp_allowlist(tmp_path):
    source = source_config(tmp_path)
    config = json.loads(source.read_text())
    config["mcp"]["servers"]["docs"]["enabled"] = False
    source.write_text(json.dumps(config), encoding="utf-8")

    overlay, _, _ = prepare_runtime(tmp_path / "room", "alpha", source)

    assert overlay["mcp"]["servers"] == {}
    assert "bundle-mcp" not in overlay["tools"]["allow"]
