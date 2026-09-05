"""Build a bounded OpenClaw configuration for 御书房 turns.

New rooms can attach to an Agent's canonical ``agent:<id>:main`` session. The
configuration remains room-local so tool policy is still constrained, while
the session store, state directory and Agent workspace point at the same
working context used by ordinary EDICT dispatches. Legacy rooms continue to
use their isolated room session.
"""
from __future__ import annotations

import copy
import fnmatch
import json
import os
import pathlib
import re
import shutil

from file_lock import atomic_json_write
from model_capabilities import apply_definitions, capability, canonical_thinking, LEVELS

READ_OPERATIONS = ["resources_list", "resources_read", "prompts_list", "prompts_get"]
DENIED_TOOLS = [
    "exec", "process", "write", "edit", "apply_patch", "browser", "canvas", "nodes",
    "cron", "gateway", "message", "sessions_send", "sessions_spawn", "sessions_list",
    "sessions_history", "subagents",
]

# OpenClaw treats a known provider environment name (for example
# ``OPENAI_API_KEY``) as a non-SecretRef auth marker.  Using this marker in a
# room-local config lets the embedded ``agent --local`` path resolve the key
# directly from its child environment instead of opening a gateway websocket
# for ``secrets.resolve``.  The value itself is never written to the config.
_ROOM_PROVIDER_ENV_MARKER = "OPENAI_API_KEY"
_EDICT_PROVIDER_USER_AGENT = "Edict_InnerCourt"
_ENV_SECRET_REF_RE = re.compile(r"^\$\{([A-Z][A-Z0-9_]{0,127})\}$")


def _normalize_openai_base_url(value: object) -> str:
    """Add the conventional ``/v1`` root without changing custom paths."""
    text = str(value or "").strip().rstrip("/")
    if not text:
        return text
    try:
        from urllib.parse import urlsplit, urlunsplit
        parsed = urlsplit(text)
        if parsed.scheme in ("http", "https") and parsed.hostname and parsed.path in ("", "/"):
            return urlunsplit((parsed.scheme, parsed.netloc, "/v1", parsed.query, parsed.fragment)).rstrip("/")
    except ValueError:
        pass
    return text

def resolve_thinking(thinking: str, capability: dict) -> str:
    """Validate against the actual native channel; never alias max to xhigh."""
    if thinking == "default":
        return "default"
    thinking = canonical_thinking(capability, thinking)
    efforts = capability.get("levels", capability.get("supportedReasoningEfforts", []))
    if capability.get("reasoning") is False or thinking not in LEVELS:
        raise ValueError(f"模型 {capability['model']} 不支持所选思考档位，请检查模型配置。")
    if thinking not in efforts:
        raise ValueError(f"模型 {capability['model']} 未声明支持 {thinking}；已声明：{'、'.join(efforts)}。请检查模型配置。")
    return capability.get("mapping", {}).get(thinking, "off" if thinking == "none" else thinking)


def prepare_runtime(
    root: pathlib.Path,
    agent_id: str,
    source_path: pathlib.Path,
    *,
    shared_session: bool = False,
    session_store: pathlib.Path | None = None,
    state_dir: pathlib.Path | None = None,
) -> tuple[dict, dict, dict]:
    """Return config, child env, and a non-secret capability summary.

    Only research tools survive. MCP is limited to protocol resource/prompt
    reads, not arbitrary tools/call operations. Skill documents are copied,
    but scripts and workspace history are not.
    """
    source = json.loads(source_path.read_text(encoding="utf-8"))
    data_dir = pathlib.Path(os.environ.get("EDICT_DATA_DIR", str(pathlib.Path(__file__).parent.parent / "data")))
    original_source = source
    source = apply_definitions(source, data_dir)
    agents = source.get("agents", {})
    defaults = agents.get("defaults", {})
    agent = next((item for item in agents.get("list", []) if item.get("id") == agent_id), None)
    if not agent:
        raise ValueError(f"OpenClaw 未注册 {agent_id}，请先在模型配置中应用设置")
    raw_model = agent.get("model") or defaults.get("model")
    model = raw_model.get("primary") if isinstance(raw_model, dict) else raw_model
    if not isinstance(model, str) or "/" not in model:
        raise ValueError(f"{agent_id} 尚未绑定自定义供应商模型")
    provider_id = model.split("/", 1)[0]
    provider = copy.deepcopy(source.get("models", {}).get("providers", {}).get(provider_id))
    if not isinstance(provider, dict):
        raise ValueError(f"供应商 {provider_id} 不在已配置目录中")
    if provider.get("api", "openai-completions") == "openai-completions":
        provider["baseUrl"] = _normalize_openai_base_url(provider.get("baseUrl", ""))

    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    original_workspace = pathlib.Path(agent.get("workspace") or defaults.get("workspace") or source_path.parent / f"workspace-{agent_id}").expanduser()
    # Shared turns use the same Agent workspace as ordinary EDICT dispatches
    # so the current task context and memory remain visible. The room config
    # still denies every mutating tool, so the summon is observational.
    # Shared turns must point at the canonical Agent workspace even when it
    # has not been created yet.  Creating the directory is safe; silently
    # falling back to a room-local workspace would make the supposed shared
    # memory boundary misleading.
    workspace = original_workspace if shared_session else root / "workspace"
    workspace.mkdir(exist_ok=True, mode=0o700)
    environment = dict(os.environ)
    api_key = provider.get("apiKey")
    if isinstance(api_key, str) and api_key:
        # Existing desktop configs may still contain a literal value or an
        # env-template ref.  Normalize both to the same child-only env path.
        marker = api_key.strip()
        template = _ENV_SECRET_REF_RE.fullmatch(marker)
        if template:
            api_key = {"source": "env", "provider": "default", "id": template.group(1)}
        elif marker == _ROOM_PROVIDER_ENV_MARKER:
            api_key = {"source": "env", "provider": "default", "id": marker}
        else:
            environment[_ROOM_PROVIDER_ENV_MARKER] = api_key
            provider["apiKey"] = _ROOM_PROVIDER_ENV_MARKER
    if isinstance(api_key, dict):
        if api_key.get("source") != "env":
            raise ValueError("御书房仅接受系统安全存储注入的环境密钥，不执行文件或命令型密钥读取")
        env_id = api_key.get("id")
        if not isinstance(env_id, str) or not env_id.strip():
            raise ValueError("御书房供应商密钥引用无效")
        resolved_key = environment.get(env_id.strip())
        if not isinstance(resolved_key, str) or not resolved_key.strip():
            raise ValueError("供应商密钥未注入当前运行环境，请保存密钥后重新加载看板")
        environment[_ROOM_PROVIDER_ENV_MARKER] = resolved_key.strip()
        # Do not leave a SecretRef in the child config: OpenClaw would ask the
        # gateway to resolve it before the embedded local run starts.
        provider["apiKey"] = _ROOM_PROVIDER_ENV_MARKER
    # External harnesses and local service launchers could bypass tool policy.
    provider["agentRuntime"] = {"id": "openclaw"}
    provider.pop("localService", None)
    # OpenClaw's OpenAI SDK identifies itself as ``OpenAI/JS <version>`` by
    # default. A number of OpenAI-compatible gateways reject that marker with
    # HTTP 403, so the room runtime always uses the desktop application's
    # non-sensitive identifier. Remove case variants to avoid duplicate
    # headers after merging old configurations.
    headers = provider.get("headers") if isinstance(provider.get("headers"), dict) else {}
    headers = {key: value for key, value in headers.items() if str(key).lower() != "user-agent"}
    headers["User-Agent"] = _EDICT_PROVIDER_USER_AGENT
    provider["headers"] = headers
    for entry in provider.get("models", []):
        entry["agentRuntime"] = {"id": "openclaw"}

    allowed_skills = agent.get("skills")
    copied_skills = []
    skill_root = original_workspace / "skills"
    if skill_root.is_dir() and not skill_root.is_symlink():
        if shared_session:
            # Never delete or rewrite the canonical workspace.  The shared
            # room is observational and can read the already-installed skill
            # documents, while every mutating tool remains denied below.
            copied_skills = [
                skill.name for skill in sorted(skill_root.iterdir())
                if skill.is_dir()
                and not skill.is_symlink()
                and (not isinstance(allowed_skills, list) or skill.name in allowed_skills)
                and (skill / "SKILL.md").is_file()
                and not (skill / "SKILL.md").is_symlink()
            ]
        else:
            staged_skills = workspace / "skills"
            if staged_skills.exists():
                shutil.rmtree(staged_skills)
            for skill in sorted(skill_root.iterdir()):
                if not skill.is_dir() or skill.is_symlink() or (isinstance(allowed_skills, list) and skill.name not in allowed_skills):
                    continue
                skill_doc = skill / "SKILL.md"
                if skill_doc.is_file() and not skill_doc.is_symlink():
                    destination = workspace / "skills" / skill.name
                    destination.mkdir(parents=True, exist_ok=True, mode=0o700)
                    # Copy text references only. Never import scripts, memories,
                    # credentials, symlinks, or another room's conversation.
                    for document in skill.rglob("*.md"):
                        if document.is_symlink() or document.stat().st_size > 256_000:
                            continue
                        if document.resolve().is_relative_to(skill.resolve()):
                            target = destination / document.relative_to(skill)
                            target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                            target.write_text(document.read_text(encoding="utf-8"), encoding="utf-8")
                            target.chmod(0o600)
                    copied_skills.append(skill.name)

    servers = {}
    for server_name, original in source.get("mcp", {}).get("servers", {}).items():
        if not isinstance(original, dict) or original.get("enabled") is False:
            continue
        server = copy.deepcopy(original)
        original_filter = server.get("toolFilter", {})
        include, exclude = original_filter.get("include", []), original_filter.get("exclude", [])
        operations = [op for op in READ_OPERATIONS
                      if (not include or any(fnmatch.fnmatchcase(op, pattern) for pattern in include))
                      and not any(fnmatch.fnmatchcase(op, pattern) for pattern in exclude)]
        if not operations:
            continue
        server["toolFilter"] = {"include": operations}
        server["supportsParallelToolCalls"] = False
        # Inline MCP credentials become child-only environment references.
        for field in ("env", "headers"):
            for key, value in server.get(field, {}).items():
                if isinstance(value, str) and re.search(r"key|token|secret|password|authorization|cookie", key, re.I) and "${" not in value:
                    env_key = f"EDICT_ROOM_MCP_SECRET_{len(environment)}"
                    environment[env_key] = value
                    server[field][key] = "${" + env_key + "}"
        servers[server_name] = server

    web = copy.deepcopy(source.get("tools", {}).get("web", {}))
    # Skills inherit their configured selection; all executable tool access
    # remains independently bounded by OpenClaw's enforced allow/deny policy.
    allowed_tools = ["read", "web_search", "web_fetch"]
    if servers:
        # OpenClaw declares this plugin policy entry only when at least one
        # enabled MCP server is materialized for the child runtime.
        allowed_tools.append("bundle-mcp")
    safe_denied_tools = [item for item in DENIED_TOOLS if item not in {"memory_search", "memory_get"}]
    if not shared_session:
        safe_denied_tools.extend(["memory_search", "memory_get"])
    config = {
        "models": {"mode": "replace", "providers": {provider_id: provider}},
        "secrets": {"providers": {"default": {"source": "env"}}},
        "agents": {
            "defaults": {
                "model": {"primary": model, "fallbacks": []},
                "models": {model: {"agentRuntime": {"id": "openclaw"}}},
                "workspace": str(workspace), "skipBootstrap": True,
                "memorySearch": {"enabled": bool(shared_session)},
                "compaction": {"memoryFlush": {"enabled": False}},
            },
            "list": [{
                "id": agent_id, "workspace": str(workspace), "agentDir": str(root / "agent"),
                "model": model, "skills": copied_skills,
                "subagents": {"allowAgents": []},
            }],
        },
        "tools": {
            "profile": "full", "allow": allowed_tools + (["memory_search", "memory_get"] if shared_session else []),
            "deny": safe_denied_tools, "fs": {"workspaceOnly": True},
            "exec": {"security": "deny"}, "elevated": {"enabled": False}, "web": web,
        },
        "mcp": {"servers": servers},
        "session": {"store": str(session_store or root / "sessions.json")},
        "logging": {"level": "silent"},
    }
    path = root / "openclaw.json"
    atomic_json_write(path, config)
    path.chmod(0o600)
    canonical_state_dir = pathlib.Path(state_dir or source_path.parent).expanduser()
    environment.update({
        "OPENCLAW_CONFIG_PATH": str(path),
        "OPENCLAW_STATE_DIR": str(canonical_state_dir if shared_session else root / "state"),
        "OPENCLAW_HOME": str(canonical_state_dir if shared_session else root),
        "EDICT_OPENCLAW_HOME": str(canonical_state_dir if shared_session else root),
    })
    summary = {
        "model": model, "skills": copied_skills, "mcpServers": list(servers),
        "mcpPolicy": "resource-and-prompt-read-only",
        "sessionMode": "shared" if shared_session else "isolated",
        "memoryAccess": "canonical-agent-memory-read-only" if shared_session else "room-isolated",
        "webSearch": web.get("search", {}).get("enabled", True),
        "webFetch": web.get("fetch", {}).get("enabled", True),
        "execution": "denied-during-deliberation",
    }
    summary.update(capability(original_source, model, data_dir))
    selected_model = next((entry for entry in provider.get("models", []) if entry.get("id") == model.split("/", 1)[1]), {})
    if isinstance(selected_model.get("reasoning"), bool):
        summary["reasoning"] = selected_model["reasoning"]
    efforts = selected_model.get("compat", {}).get("supportedReasoningEfforts")
    if isinstance(efforts, list):
        summary["supportedReasoningEfforts"] = efforts
    return config, environment, summary


def read_tool_activity(room_root: pathlib.Path) -> list[dict]:
    """Read bounded, metadata-only activity from this room's native transcripts."""
    events = {}
    for file in room_root.glob("*/state/agents/*/sessions/*.jsonl"):
        if file.name.endswith(".trajectory.jsonl") or file.is_symlink() or not file.resolve().is_relative_to(room_root.resolve()):
            continue
        agent_id = file.parent.parent.name
        try:
            with file.open("rb") as stream:
                stream.seek(max(0, file.stat().st_size - 128_000))
                lines = stream.read(128_000).decode("utf-8", errors="replace").splitlines()
            for line in lines[-200:]:
                try:
                    entry = json.loads(line)
                except ValueError:
                    continue
                message = entry.get("message", {})
                if message.get("role") == "toolResult":
                    key = (agent_id, message.get("toolCallId"))
                    events[key] = {"agentId": agent_id, "tool": str(message.get("toolName", ""))[:128],
                                   "state": "error" if message.get("isError") else "completed", "at": entry.get("timestamp", "")}
                elif message.get("role") == "assistant" and isinstance(message.get("content"), list):
                    for item in message["content"]:
                        if item.get("type") == "toolCall":
                            events.setdefault((agent_id, item.get("id")), {"agentId": agent_id, "tool": str(item.get("name", ""))[:128],
                                              "state": "running", "at": entry.get("timestamp", "")})
        except OSError:
            continue
    return sorted(events.values(), key=lambda event: event["at"])[-100:]
