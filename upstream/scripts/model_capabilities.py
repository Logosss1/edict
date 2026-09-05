"""One capability contract for settings, original EDICT tasks and private rooms."""
from __future__ import annotations

import copy
import datetime
import hashlib
import json
import os
import pathlib
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

from file_lock import atomic_json_read, atomic_json_update

LEVELS = ("default", "none", "minimal", "low", "medium", "high", "xhigh", "adaptive", "max", "ultra")
MAPPING_KEYS = {"off", "minimal", "low", "medium", "high", "xhigh", "max"}
METADATA_PATHS = {"reasoning": ("reasoning",), "supportsReasoningEffort": ("compat", "supportsReasoningEffort"),
                  "supportedReasoningEfforts": ("compat", "supportedReasoningEfforts"), "thinkingLevelMap": ("thinkingLevelMap",),
                  "reasoningEffortMap": ("compat", "reasoningEffortMap")}
CATALOG = json.loads(pathlib.Path(__file__).with_suffix(".json").read_text(encoding="utf-8"))["models"]
_PROBE_LOCK = threading.Lock()


def primary(value):
    return value.get("primary", "") if isinstance(value, dict) else (value or "")


def source_path():
    return pathlib.Path(os.environ.get("OPENCLAW_CONFIG_PATH") or
                        pathlib.Path(os.environ.get("EDICT_OPENCLAW_HOME", str(pathlib.Path.home() / ".openclaw"))) / "openclaw.json")


def _read(path):
    value = atomic_json_read(path, {})
    return value if isinstance(value, dict) else {}


def _levels(value):
    if not isinstance(value, list) or len(value) > 9 or any(not isinstance(v, str) or v not in LEVELS[1:] for v in value):
        raise ValueError("思考档位必须是有效数组；default 不属于供应商参数")
    return list(dict.fromkeys(value))


def definition(config, model):
    if not isinstance(model, str) or "/" not in model:
        raise ValueError("请选择已配置的供应商模型")
    provider_id, model_id = model.split("/", 1)
    provider = config.get("models", {}).get("providers", {}).get(provider_id)
    if not isinstance(provider, dict):
        raise ValueError("供应商未配置")
    entry = next((item for item in provider.get("models", []) if isinstance(item, dict) and item.get("id") == model_id), None)
    if entry is None:
        raise ValueError("模型不在供应商目录中")
    return provider, entry


def _connection_fingerprint(provider, entry):
    return hashlib.sha256(json.dumps({"url": entry.get("baseUrl") or provider.get("baseUrl"), "model": entry.get("id"),
        "api": entry.get("api", provider.get("api", "openai-completions"))}, sort_keys=True).encode()).hexdigest()


def _raw_stored(model, data_dir):
    return _read(pathlib.Path(data_dir) / "model_capabilities.json").get("models", {}).get(model, {})


def _stored(provider, entry, model, data_dir):
    saved = _raw_stored(model, data_dir)
    if saved.get("binding") is not None and saved.get("binding") != _connection_fingerprint(provider, entry):
        return {}
    return saved


def _metadata(entry):
    result = {}
    for key, path in METADATA_PATHS.items():
        parent = entry if len(path) == 1 else entry.get(path[0], {})
        if path[-1] in parent:
            result[key] = copy.deepcopy(parent[path[-1]])
    return result


def _base_entry(entry, saved):
    """Remove only metadata still equal to our last overlay, preserving external edits."""
    entry = copy.deepcopy(entry)
    if "baselineMetadata" not in saved or "appliedMetadata" not in saved:
        return entry
    current, applied, baseline = _metadata(entry), saved["appliedMetadata"], saved["baselineMetadata"]
    previous = saved.get("previousAppliedMetadata", {})
    for key, path in METADATA_PATHS.items():
        if not ((key in applied and current.get(key) == applied[key]) or
                (key in previous and current.get(key) == previous[key])):
            continue
        parent = entry if len(path) == 1 else entry.setdefault(path[0], {})
        if key in baseline:
            parent[path[-1]] = copy.deepcopy(baseline[key])
        else:
            parent.pop(path[-1], None)
    if entry.get("compat") == {}:
        entry.pop("compat", None)
    return entry


def restore_definitions(config, data_dir, models=None):
    config = copy.deepcopy(config)
    for provider_id, provider in config.get("models", {}).get("providers", {}).items():
        for index, entry in enumerate(provider.get("models", [])):
            model = provider_id + "/" + entry["id"]
            if models is not None and model not in models:
                continue
            saved = _raw_stored(model, data_dir)
            provider["models"][index] = _base_entry(entry, saved)
    return config


def _none_uses_minimal(provider, entry, levels):
    # OpenClaw 2026.7.1-2 drops CLI off, then completions defaults to high.
    return (entry.get("api", provider.get("api", "openai-completions")) == "openai-completions"
            and "none" in levels and "minimal" not in levels
            and entry.get("compat", {}).get("reasoningEffortMap", {}).get("minimal", "none") == "none"
            and entry.get("thinkingLevelMap", {}).get("minimal", "minimal") == "minimal")


def _official_tool_policy(provider, entry):
    if entry.get("api", provider.get("api", "openai-completions")) != "openai-completions":
        return None
    try:
        host = urllib.parse.urlsplit(entry.get("baseUrl") or provider.get("baseUrl", "")).hostname
    except ValueError:
        return None
    if host != "api.openai.com":
        return None
    if entry["id"] == "gpt-5.5":
        return "default"
    if entry["id"] in {"gpt-5.6", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"}:
        return "none"
    return None


def _fingerprint(provider, entry, override):
    known = CATALOG.get(entry.get("id"), {})
    compat = copy.deepcopy(entry.get("compat", known.get("compat", {})))
    reasoning = entry.get("reasoning", known.get("reasoning"))
    levels = override if override is not None else compat.get("supportedReasoningEfforts", [])
    if override is not None:
        reasoning = bool(override)
        compat.update({"supportsReasoningEffort": bool(override), "supportedReasoningEfforts": override})
    if _none_uses_minimal(provider, entry, levels):
        compat.setdefault("reasoningEffortMap", {}).setdefault("minimal", "none")
    mapping = {**known.get("thinkingLevelMap", {}), **entry.get("thinkingLevelMap", {})}
    for level in levels:
        if ("off" if level == "none" else level) in MAPPING_KEYS:
            mapping.setdefault("off" if level == "none" else level, level)
    relevant = {"url": entry.get("baseUrl") or provider.get("baseUrl"), "api": entry.get("api", provider.get("api")),
                "model": entry.get("id"), "reasoning": reasoning,
                "compat": compat, "mapping": mapping, "manual": override}
    return hashlib.sha256(json.dumps(relevant, sort_keys=True).encode()).hexdigest()


def capability(config, model, data_dir):
    provider, entry = definition(config, model)
    entry = _base_entry(entry, _raw_stored(model, data_dir))
    saved = _stored(provider, entry, model, data_dir)
    override = saved.get("levels")
    compat = entry.get("compat") or {}
    warnings = []
    if override is not None:
        levels, source = _levels(override), "manual"
        warnings.append("手动声明尚不代表供应商实际支持。")
    elif entry.get("reasoning") is False or compat.get("supportsReasoningEffort") is False:
        levels, source = [], "provider"
    elif isinstance(compat.get("supportedReasoningEfforts"), list):
        levels = [item for item in compat["supportedReasoningEfforts"] if item in LEVELS[1:]]
        source = "provider"
    elif entry["id"] in CATALOG:
        levels = CATALOG[entry["id"]]["compat"]["supportedReasoningEfforts"][:]
        source = "catalog"
        warnings.append("来自精确模型目录；自定义供应商可能采用不同实现。")
    else:
        levels, source = [], "unknown"
        warnings.append("供应商未声明思考档位，请保持模型默认或手动声明后检测。")
    declared_levels = levels[:]
    wire_mapping = {}
    runtime_mapping = {}
    usable = []
    explicit_mapping = entry.get("thinkingLevelMap", {})
    effort_mapping = compat.get("reasoningEffortMap", {})
    for level in levels:
        wire = explicit_mapping.get("off" if level == "none" else level, level)
        wire = effort_mapping.get(wire, wire)
        wire_mapping[level] = wire
        if level in {"ultra", "adaptive"}:
            warnings.append(f"当前运行时不能为 {level} 配置合法的原生参数映射，请选择已支持的具体思考档位。")
            continue
        elif wire != level:
            warnings.append(f"{level} 被供应商映射为 {wire}，为避免静默改档暂不开放。")
            continue
        if level == "none" and entry.get("api", provider.get("api", "openai-completions")) == "openai-completions":
            if not _none_uses_minimal(provider, entry, levels):
                warnings.append("none 无法安全映射：minimal 已是模型档位或存在不同参数映射，暂不开放 none。")
                continue
            runtime_mapping[level] = "minimal"
            warnings.append("OpenClaw 2026.7.1-2 兼容：none 通过 CLI minimal 承载，实际发送 reasoning_effort=none。")
        else:
            runtime_mapping[level] = "off" if level == "none" else level
        usable.append(level)
    fingerprint = _fingerprint(provider, entry, override)
    evidence = saved.get("evidence", {}) if saved.get("fingerprint") == fingerprint else {}
    probe_levels = [level for level in usable if level != "ultra"]
    tool_policy = _official_tool_policy(provider, entry)
    if tool_policy == "none":
        usable = [level for level in usable if level == "none"]
        warnings.append("当前 OpenClaw 在官方 Chat Completions 工具调用中强制发送 none，仅开放模型默认和 none。API 接纳检测不代表原生工具流程可用；其他档位请使用运行时支持的协议。")
    elif tool_policy == "default":
        usable = []
        warnings.append("当前 OpenClaw 在 GPT-5.5 官方 Chat Completions 工具调用中省略思考参数，仅开放模型默认。API 接纳检测不代表原生工具流程可用；显式档位请使用运行时支持的协议。")
    if (model.split("/", 1)[0] != "openai"
            and entry.get("api", provider.get("api", "openai-completions")) == "openai-completions"
            and "max" in usable):
        usable = [level for level in usable if level != "max"]
        warnings.append("供应商声明支持 max，但 OpenClaw 2026.7.1-2 的自定义供应商原生 CLI 通道不支持此档位。可检测 API 是否接纳，不开放设置，也不会降为 xhigh。")
    levels = [level for level in usable if evidence.get(level, {}).get("status") != "unsupported"]
    mapping = {level: runtime_mapping[level] for level in levels}
    return {"model": model, "providerId": model.split("/", 1)[0], "modelId": entry["id"],
            "levels": ["default", *levels], "runtimeLevels": ["default", *mapping.values()],
            "mapping": {"default": "default", **mapping}, "source": source, "warnings": warnings,
            "wireMapping": wire_mapping, "declaredLevels": declared_levels, "probeLevels": probe_levels, "evidence": evidence}


def canonical_thinking(cap, value):
    if value == "off" or (value == "minimal" and cap.get("mapping", {}).get("none") == "minimal"):
        return "none"
    return value


def model_thinking(config, data_dir, model, value):
    if value != "minimal":
        return "none" if value == "off" else value
    return canonical_thinking(capability(config, model, data_dir), value)


def snapshot(config, data_dir):
    models = []
    for provider_id, provider in config.get("models", {}).get("providers", {}).items():
        if isinstance(provider, dict):
            for entry in provider.get("models", []):
                if isinstance(entry, dict) and isinstance(entry.get("id"), str):
                    models.append(capability(config, provider_id + "/" + entry["id"], data_dir))
    defaults = config.get("agents", {}).get("defaults", {})
    agents = [{"agentId": agent.get("id"), "model": primary(agent.get("model")) or primary(defaults.get("model")),
               "thinkingDefault": agent.get("thinkingDefault", defaults.get("thinkingDefault", "default"))}
              for agent in config.get("agents", {}).get("list", []) if isinstance(agent, dict)]
    for agent in agents:
        cap = next((item for item in models if item["model"] == agent["model"]), {})
        agent["runtimeThinkingDefault"] = agent["thinkingDefault"]
        agent["thinkingDefault"] = canonical_thinking(cap, agent["thinkingDefault"])
    return {"ok": True, "models": models, "agents": agents}


def validate(config, data_dir, thinking, model=None, agent_id=None, global_profile=False):
    if thinking == "off":
        thinking = "none"
    if thinking not in LEVELS:
        raise ValueError("无效的思考档位")
    state = snapshot(config, data_dir)
    targets = state["agents"] if global_profile else [next((a for a in state["agents"] if a["agentId"] == agent_id), {})]
    raw_agents = config.get("agents", {}).get("list", [])
    if global_profile:
        overridden = {agent.get("id") for agent in config.get("agents", {}).get("list", [])
                      if isinstance(agent, dict) and "thinkingDefault" in agent}
        targets = [target for target in targets if target["agentId"] not in overridden]
        targets.append({"agentId": "默认配置", "model": primary(config.get("agents", {}).get("defaults", {}).get("model"))})
    if not global_profile and not model and not targets[0]:
        raise ValueError("Agent 未注册或尚未绑定模型")
    conflicts = []
    runtime_values = set()
    for target in targets or [{}]:
        selected = model or target.get("model") or primary(config.get("agents", {}).get("defaults", {}).get("model"))
        if global_profile and model:
            original = next((agent for agent in raw_agents if agent.get("id") == target.get("agentId")), {})
            selected = primary(original.get("model")) or model
        cap = capability(config, selected, data_dir)
        requested = canonical_thinking(cap, thinking)
        if requested not in cap["levels"]:
            conflicts.append(f"{target.get('agentId') or selected}: {thinking} 不在可用档位中")
        else:
            runtime_values.add(cap["mapping"][requested])
    if conflicts:
        raise ValueError("；".join(conflicts))
    if len(runtime_values) != 1:
        raise ValueError("所选模型需要不同的运行时思考参数，不能共用一个全局默认值")
    return runtime_values.pop()


def configure(config, data_dir, model, levels):
    provider, entry = definition(config, model)
    previous = _raw_stored(model, data_dir)
    baseline = _base_entry(entry, previous)
    clean = _levels(levels) if levels is not None else None
    binding = _connection_fingerprint(provider, entry)
    def update(state):
        models = state.setdefault("models", {})
        record = {"binding": binding, "baselineMetadata": _metadata(baseline)}
        if "appliedMetadata" in previous:
            record["appliedMetadata"] = previous["appliedMetadata"]
            record["previousAppliedMetadata"] = {key: value for key, value in _metadata(entry).items()
                if previous["appliedMetadata"].get(key) == value or previous.get("previousAppliedMetadata", {}).get(key) == value}
        if clean is not None:
            record["levels"] = clean
        models[model] = record
        return state
    atomic_json_update(pathlib.Path(data_dir) / "model_capabilities.json", update, {})
    if clean is not None:
        projected = apply_definitions(config, data_dir)
        _, projected_entry = definition(projected, model)
        def remember(state):
            item = state.setdefault("models", {}).get(model, {})
            if item.get("binding") == binding and item.get("levels") == clean:
                item["appliedMetadata"] = _metadata(projected_entry)
            return state
        atomic_json_update(pathlib.Path(data_dir) / "model_capabilities.json", remember, {})
    return capability(config, model, data_dir)


def apply_definitions(config, data_dir):
    """Copy only supported OpenClaw schema fields; never put EDICT evidence in config."""
    config = restore_definitions(config, data_dir)
    for item in snapshot(config, data_dir)["models"]:
        provider, entry = definition(config, item["model"])
        known = CATALOG.get(entry["id"], {})
        for key, value in known.items():
            if key not in entry:
                entry[key] = copy.deepcopy(value)
        levels = item["levels"][1:]
        if item["source"] == "manual":
            provider, _ = definition(config, item["model"])
            declared = _stored(provider, entry, item["model"], data_dir).get("levels", [])
            wire_levels = list(dict.fromkeys(item["wireMapping"][level] for level in declared
                if level in item["probeLevels"] or (level == "ultra" and level in item["levels"])))
            entry["reasoning"] = bool(wire_levels)
            entry.setdefault("compat", {}).update({"supportsReasoningEffort": bool(wire_levels), "supportedReasoningEfforts": wire_levels})
            levels = declared
        if levels:
            for level in levels:
                if ("off" if level == "none" else level) in MAPPING_KEYS:
                    entry.setdefault("thinkingLevelMap", {}).setdefault("off" if level == "none" else level, level)
        if _none_uses_minimal(provider, entry, item["probeLevels"]):
            entry.setdefault("compat", {}).setdefault("reasoningEffortMap", {}).setdefault("minimal", "none")
    return config


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def _secret(provider, injected):
    if isinstance(injected, str) and injected:
        return injected
    key = provider.get("apiKey")
    if isinstance(key, dict) and key.get("source") == "env":
        key = os.environ.get(key.get("id", ""), "")
    elif isinstance(key, str) and key.startswith("${") and key.endswith("}"):
        key = os.environ.get(key[2:-1], "")
    if isinstance(key, str) and key:
        return key
    raise ValueError("供应商密钥不可用，请通过桌面安全存储连接供应商")


def _response_bytes(response, started, limit):
    """Bound total response time as well as bytes, including a slow trickle."""
    wire = response.fp if isinstance(response, urllib.error.HTTPError) else response
    chunks, size = [], 0
    while size <= limit:
        if wire.isclosed():
            break
        remaining = 10 - (time.monotonic() - started)
        if remaining <= 0:
            raise TimeoutError()
        wire.fp.raw._sock.settimeout(remaining)
        chunk = wire.read1(min(16384, limit + 1 - size))
        if not chunk:
            break
        chunks.append(chunk)
        size += len(chunk)
    if size > limit:
        raise ValueError("response limit")
    return b"".join(chunks)


def probe(config, data_dir, model, levels, confirmed=False, api_key=None):
    if confirmed is not True:
        raise ValueError("检测会消耗供应商额度，请先明确确认")
    levels = _levels(levels)
    if not levels or len(levels) > 8:
        raise ValueError("一次检测须选择 1 至 8 个档位")
    provider, entry = definition(config, model)
    entry = _base_entry(entry, _raw_stored(model, data_dir))
    declared = capability(config, model, data_dir)["probeLevels"]
    if any(level not in declared for level in levels):
        raise ValueError("检测档位须先由供应商、精确模型目录或手动配置声明；不能猜测未知参数")
    if entry.get("api", provider.get("api", "openai-completions")) != "openai-completions":
        raise ValueError("当前检测仅支持 OpenAI Chat Completions 兼容协议")
    url = urllib.parse.urlsplit(entry.get("baseUrl") or provider.get("baseUrl", ""))
    if url.scheme not in ("https", "http") or not url.hostname or url.username or url.password or url.query or url.fragment:
        raise ValueError("供应商 URL 无效")
    if url.scheme == "http" and url.hostname not in ("localhost", "127.0.0.1", "::1"):
        raise ValueError("非本地供应商检测必须使用 HTTPS")
    secret = _secret(provider, api_key)
    base = urllib.parse.urlunsplit(url).rstrip("/")
    endpoint = base + ("/chat/completions" if url.path.rstrip("/").endswith("/v1") else "/v1/chat/completions")
    path = pathlib.Path(data_dir) / "model_capabilities.json"
    saved = _stored(provider, entry, model, data_dir)
    fingerprint = _fingerprint(provider, entry, saved.get("levels"))
    if not _PROBE_LOCK.acquire(blocking=False):
        raise ValueError("已有思考档位检测正在进行，请稍后重试")
    results = {}
    try:
        opener = urllib.request.build_opener(_NoRedirect())
        for level in levels:
            start = time.monotonic()
            status, detail, stop = "error", "", False
            payload = {"model": entry["id"], "messages": [{"role": "user", "content": "Reply OK."}],
                       "reasoning_effort": level, "max_completion_tokens": 32, "stream": False}
            request = urllib.request.Request(endpoint, data=json.dumps(payload).encode(),
                                            headers={"Content-Type": "application/json", "Authorization": "Bearer " + secret})
            try:
                with opener.open(request, timeout=10) as response:
                    raw = _response_bytes(response, start, 131072)
                    result = json.loads(raw)
                    if isinstance(result, dict) and isinstance(result.get("choices"), list) and any(
                            isinstance(choice, dict) and isinstance(choice.get("message"), dict) for choice in result["choices"]):
                        status, detail = "accepted", "接口接受请求；无法据此证明模型实际采用该思考档位"
                    else:
                        detail = "供应商响应格式异常，未判定档位是否支持"
            except urllib.error.HTTPError as exc:
                if exc.code in (401, 403, 429):
                    detail, stop = f"HTTP {exc.code}：认证失败或额度/限流限制，检测已停止", True
                elif exc.code in (400, 422):
                    try:
                        raw = _response_bytes(exc, start, 16384).decode("utf-8", errors="replace").lower()
                    except Exception:
                        raw = ""
                    rejected = ("reasoning_effort" in raw or "reasoning effort" in raw) and any(word in raw for word in ("unsupported", "not supported", "invalid", "allowed"))
                    status = "unsupported" if rejected else "error"
                    detail = "供应商明确拒绝此思考参数" if rejected else f"HTTP {exc.code}：请求失败，未判定档位是否支持"
                else:
                    detail = f"HTTP {exc.code}：请求失败，未判定档位是否支持"
                exc.close()
            except Exception:
                detail = "检测超时、网络错误或响应解析失败；未判定档位是否支持"
            results[level] = {"status": status, "detail": detail, "latencyMs": round((time.monotonic() - start) * 1000),
                              "checkedAt": datetime.datetime.now(datetime.timezone.utc).isoformat()}
            if stop:
                break
        def update(state):
            models = state.setdefault("models", {})
            item = models.setdefault(model, {})
            if item.get("levels") is not None and item.get("binding") != _connection_fingerprint(provider, entry):
                item = models[model] = {}
            if _fingerprint(provider, entry, item.get("levels")) == fingerprint:
                evidence = item.get("evidence", {}) if item.get("fingerprint") == fingerprint else {}
                item.update({"fingerprint": fingerprint, "evidence": {**evidence, **results}})
            return state
        atomic_json_update(path, update, {})
    finally:
        _PROBE_LOCK.release()
    return {"ok": True, "results": results, "capability": capability(config, model, data_dir)}
