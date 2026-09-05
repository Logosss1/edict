"""Reasoning choices must match declared capabilities, not provider HTTP optimism."""
import copy
import json
import pathlib
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "scripts"))
import model_capabilities as caps


def config(model="gpt-5.6-terra", **entry):
    return {"models": {"providers": {"custom": {"baseUrl": "https://example.invalid/v1",
            "api": "openai-completions", "apiKey": {"source": "env", "id": "TEST_PROVIDER_KEY"},
            "models": [{"id": model, **entry}]}}},
            "agents": {"defaults": {"model": "custom/" + model}, "list": [{"id": "alpha"}]}}


def test_exact_catalog_preserves_all_native_levels_but_not_ultra(tmp_path):
    state = caps.snapshot(config(), tmp_path)
    model = state["models"][0]
    assert model["levels"] == ["default", "none", "low", "medium", "high", "xhigh"]
    assert model["declaredLevels"] == ["none", "low", "medium", "high", "xhigh", "max"]
    assert "max" in model["probeLevels"]
    assert model["mapping"]["none"] == "minimal"
    assert model["source"] == "catalog"
    assert not (tmp_path / "model_capabilities.json").exists()
    assert caps.validate(config(), tmp_path, "none", agent_id="alpha") == "minimal"
    with pytest.raises(ValueError, match="ultra"):
        caps.validate(config(), tmp_path, "ultra", agent_id="alpha")


@pytest.mark.parametrize("model", ["gpt5.6", "GPT-5.6", "unknown-model", "gpt-5.6-preview"])
def test_unknown_aliases_are_not_guessed(tmp_path, model):
    cap = caps.snapshot(config(model), tmp_path)["models"][0]
    assert cap["levels"] == ["default"]
    assert cap["source"] == "unknown"
    assert caps.validate(config(model), tmp_path, "default", model="custom/" + model) == "default"
    with pytest.raises(ValueError):
        caps.validate(config(model), tmp_path, "medium", model="custom/" + model)


def test_explicit_provider_declaration_wins_and_manual_is_clearable(tmp_path):
    cfg = config(reasoning=True, compat={"supportedReasoningEfforts": ["low", "high"]})
    assert caps.snapshot(cfg, tmp_path)["models"][0]["levels"] == ["default", "low", "high"]
    cap = caps.configure(cfg, tmp_path, "custom/gpt-5.6-terra", ["medium", "ultra"])
    assert cap["source"] == "manual"
    assert cap["levels"] == ["default", "medium"]
    assert caps.apply_definitions(cfg, tmp_path)["models"]["providers"]["custom"]["models"][0]["compat"]["supportedReasoningEfforts"] == ["medium"]
    assert cfg["models"]["providers"]["custom"]["models"][0]["compat"]["supportedReasoningEfforts"] == ["low", "high"]
    assert caps.configure(cfg, tmp_path, "custom/gpt-5.6-terra", None)["source"] == "provider"


def test_non_reasoning_model_uses_default_without_fabricated_effort(tmp_path):
    cfg = config(reasoning=False)
    assert caps.snapshot(cfg, tmp_path)["models"][0]["levels"] == ["default"]
    with pytest.raises(ValueError):
        caps.validate(cfg, tmp_path, "none", agent_id="alpha")


def test_explicit_transport_restriction_overrides_catalog_and_effort_list(tmp_path):
    cfg = config(reasoning=True, compat={"supportsReasoningEffort": False, "supportedReasoningEfforts": ["low", "high"]})
    model = caps.snapshot(cfg, tmp_path)["models"][0]
    assert model["levels"] == ["default"]
    assert model["probeLevels"] == []
    with pytest.raises(ValueError):
        caps.validate(cfg, tmp_path, "high", agent_id="alpha")


def test_global_validation_reports_every_affected_incompatible_agent(tmp_path):
    cfg = config()
    cfg["models"]["providers"]["custom"]["models"].append({"id": "limited", "compat": {"supportedReasoningEfforts": ["low"]}})
    cfg["agents"]["list"].extend([{"id": "beta", "model": "custom/limited"}, {"id": "gamma", "model": "custom/limited"}])
    with pytest.raises(ValueError, match="beta.*gamma"):
        caps.validate(cfg, tmp_path, "max", global_profile=True)
    with pytest.raises(ValueError, match="beta.*gamma"):
        caps.validate(cfg, tmp_path, "max", model="custom/gpt-5.6-terra", global_profile=True)


@pytest.fixture
def provider(monkeypatch):
    calls = []
    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            payload = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            calls.append((self.path, payload, self.headers.get("Authorization")))
            level = payload["reasoning_effort"]
            status, body = 200, {"choices": [{"message": {"content": "OK"}}]}
            if level == "high":
                status, body = 400, {"error": {"message": "Unsupported reasoning_effort value"}}
            elif level == "max":
                status, body = 429, {"error": {"message": "limit"}}
            elif level == "minimal":
                body = {"error": {"message": "not a completion"}}
            elif level == "xhigh":
                status, body = 400, {"error": {"message": "model unavailable"}}
            elif level == "medium":
                status, body = 302, {}
            data = json.dumps(body).encode()
            self.send_response(status)
            if status == 302:
                self.send_header("Location", "https://example.invalid/stolen")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        def log_message(self, *args):
            pass
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    cfg = config("unknown", compat={"supportedReasoningEfforts": list(caps.LEVELS[1:])})
    cfg["models"]["providers"]["custom"]["baseUrl"] = f"http://127.0.0.1:{server.server_port}"
    monkeypatch.setenv("TEST_PROVIDER_KEY", "isolated-fixture-key")
    yield cfg, calls
    server.shutdown()
    server.server_close()
    thread.join()


def test_probe_acceptance_is_not_proof_rejection_disables_and_keys_never_persist(tmp_path, provider):
    cfg, calls = provider
    result = caps.probe(cfg, tmp_path, "custom/unknown", ["low", "high", "medium"], True)
    assert result["results"]["low"]["status"] == "accepted"
    assert "无法据此证明" in result["results"]["low"]["detail"]
    assert result["results"]["high"]["status"] == "unsupported"
    assert "high" not in result["capability"]["levels"]
    assert result["results"]["medium"]["latencyMs"] >= 0
    assert all(call[0] == "/v1/chat/completions" for call in calls)
    assert all(call[2] == "Bearer isolated-fixture-key" for call in calls)
    assert "isolated-fixture-key" not in (tmp_path / "model_capabilities.json").read_text()
    # Explicit retry is allowed even though rejected choices are removed.
    assert caps.probe(cfg, tmp_path, "custom/unknown", ["high"], True)["results"]["high"]["status"] == "unsupported"


def test_probe_rate_limit_stops_batch_and_parse_errors_do_not_imply_unsupported(tmp_path, provider):
    cfg, calls = provider
    result = caps.probe(cfg, tmp_path, "custom/unknown", ["minimal", "xhigh", "max", "low"], True)
    assert set(result["results"]) == {"minimal", "xhigh", "max"}
    assert all(item["status"] == "error" for item in result["results"].values())
    assert len(calls) == 3
    result = caps.probe(cfg, tmp_path, "custom/unknown", ["medium"], True)
    assert result["results"]["medium"]["status"] == "error"
    assert len(calls) == 4


def test_changed_endpoint_or_capability_invalidates_evidence(tmp_path, provider):
    cfg, _ = provider
    caps.probe(cfg, tmp_path, "custom/unknown", ["high"], True)
    assert "high" not in caps.capability(cfg, "custom/unknown", tmp_path)["levels"]
    changed = copy.deepcopy(cfg)
    changed["models"]["providers"]["custom"]["baseUrl"] += "/new"
    assert "high" in caps.capability(changed, "custom/unknown", tmp_path)["levels"]
    changed = copy.deepcopy(cfg)
    changed["models"]["providers"]["custom"]["models"][0]["reasoning"] = True
    assert caps.capability(changed, "custom/unknown", tmp_path)["evidence"] == {}


def test_probe_confirmation_batch_limit_and_concurrency(tmp_path, provider):
    cfg, calls = provider
    with pytest.raises(ValueError, match="确认"):
        caps.probe(cfg, tmp_path, "custom/unknown", ["low"])
    with pytest.raises(ValueError, match="1 至 8"):
        caps.probe(cfg, tmp_path, "custom/unknown", list(caps.LEVELS[1:]), True)
    caps._PROBE_LOCK.acquire()
    try:
        with pytest.raises(ValueError, match="正在进行"):
            caps.probe(cfg, tmp_path, "custom/unknown", ["low"], True)
    finally:
        caps._PROBE_LOCK.release()
    assert calls == []


def test_probe_rejects_unsupported_protocol_and_unsafe_url(tmp_path):
    cfg = config()
    cfg["models"]["providers"]["custom"]["api"] = "anthropic-messages"
    with pytest.raises(ValueError, match="协议"):
        caps.probe(cfg, tmp_path, "custom/gpt-5.6-terra", ["low"], True)
    cfg["models"]["providers"]["custom"]["api"] = "openai-completions"
    cfg["models"]["providers"]["custom"]["baseUrl"] = "https://user:password@example.invalid"
    with pytest.raises(ValueError, match="URL"):
        caps.probe(cfg, tmp_path, "custom/gpt-5.6-terra", ["low"], True)


def test_declared_metadata_apply_does_not_invalidate_its_own_evidence(tmp_path, provider):
    cfg, _ = provider
    caps.configure(cfg, tmp_path, "custom/unknown", ["low", "high"])
    caps.probe(cfg, tmp_path, "custom/unknown", ["low", "high"], True)
    applied = caps.apply_definitions(cfg, tmp_path)
    cap = caps.capability(applied, "custom/unknown", tmp_path)
    assert cap["levels"] == ["default", "low"]
    assert cap["evidence"]["high"]["status"] == "unsupported"


def test_probe_after_changing_an_already_applied_manual_profile_keeps_evidence(tmp_path, provider):
    cfg, _ = provider
    caps.configure(cfg, tmp_path, "custom/unknown", ["low"])
    applied = caps.apply_definitions(cfg, tmp_path)
    caps.configure(applied, tmp_path, "custom/unknown", ["high"])
    result = caps.probe(applied, tmp_path, "custom/unknown", ["high"], True)
    assert result["capability"]["evidence"]["high"]["status"] == "unsupported"
    assert result["capability"]["levels"] == ["default"]


def test_unknown_probe_requires_declaration_and_known_ultra_is_not_guessed(tmp_path):
    for model, level in [("unknown", "low"), ("gpt-5.6-terra", "ultra")]:
        with pytest.raises(ValueError, match="声明"):
            caps.probe(config(model), tmp_path, "custom/" + model, [level], True, "fixture-key")


def test_manual_declaration_is_bound_to_endpoint_and_protocol(tmp_path):
    cfg = config("unknown")
    caps.configure(cfg, tmp_path, "custom/unknown", ["low", "max"])
    assert caps.capability(cfg, "custom/unknown", tmp_path)["source"] == "manual"
    changed = copy.deepcopy(cfg)
    changed["models"]["providers"]["custom"]["baseUrl"] = "https://replacement.invalid/v1"
    assert caps.capability(changed, "custom/unknown", tmp_path)["levels"] == ["default"]
    changed = copy.deepcopy(cfg)
    changed["models"]["providers"]["custom"]["api"] = "anthropic-messages"
    assert caps.capability(changed, "custom/unknown", tmp_path)["source"] == "unknown"


def test_explicit_mapping_is_preserved_and_incompatible_choices_not_offered(tmp_path):
    cfg = config(thinkingLevelMap={"high": "medium", "max": "xhigh"})
    cap = caps.capability(cfg, "custom/gpt-5.6-terra", tmp_path)
    assert "high" not in cap["levels"]
    assert "max" not in cap["levels"]
    assert cap["wireMapping"]["max"] == "xhigh"
    updated = caps.apply_definitions(cfg, tmp_path)
    assert updated["models"]["providers"]["custom"]["models"][0]["thinkingLevelMap"]["max"] == "xhigh"


def test_ultra_is_not_offered_even_with_an_invalid_runtime_alias(tmp_path):
    cfg = config(thinkingLevelMap={"ultra": "max"})
    caps.configure(cfg, tmp_path, "custom/gpt-5.6-terra", ["medium", "max", "ultra"])
    cap = caps.capability(cfg, "custom/gpt-5.6-terra", tmp_path)
    assert "ultra" not in cap["levels"]
    assert cap["wireMapping"]["ultra"] == "max"
    assert "ultra" not in cap["probeLevels"]
    updated = caps.apply_definitions(cfg, tmp_path)
    assert "ultra" not in updated["models"]["providers"]["custom"]["models"][0]["compat"]["supportedReasoningEfforts"]
    assert caps.capability(updated, "custom/gpt-5.6-terra", tmp_path)["wireMapping"]["ultra"] == "max"


def test_declared_adaptive_and_ultra_are_excluded_by_runtime_contract(tmp_path):
    cfg = config("custom-model", compat={"supportedReasoningEfforts": ["adaptive", "ultra", "high"]})
    cap = caps.capability(cfg, "custom/custom-model", tmp_path)
    assert cap["levels"] == ["default", "high"]
    assert cap["probeLevels"] == ["high"]
    assert any("adaptive" in warning for warning in cap["warnings"])
    assert any("ultra" in warning for warning in cap["warnings"])
    with pytest.raises(ValueError, match="声明"):
        caps.probe(cfg, tmp_path, "custom/custom-model", ["adaptive"], True, "unused-key")


def test_reset_restores_original_metadata_after_manual_overlay_was_persisted(tmp_path):
    cfg = config("custom-model")
    model = "custom/custom-model"
    caps.configure(cfg, tmp_path, model, ["high", "max"])
    applied = caps.apply_definitions(cfg, tmp_path)
    assert applied["models"]["providers"]["custom"]["models"][0]["compat"]["supportedReasoningEfforts"] == ["high", "max"]
    result = caps.configure(applied, tmp_path, model, None)
    assert result["source"] == "unknown"
    assert result["levels"] == ["default"]
    restored = caps.restore_definitions(applied, tmp_path)
    assert restored == cfg
    assert caps.apply_definitions(applied, tmp_path) == cfg
    assert "apiKey" not in (tmp_path / "model_capabilities.json").read_text()


def test_reset_preserves_external_metadata_changes_and_other_model_overrides(tmp_path):
    cfg = config("custom-model", compat={"supportsReasoningEffort": True, "supportedReasoningEfforts": ["low"]})
    cfg["models"]["providers"]["custom"]["models"].append({"id": "second"})
    model = "custom/custom-model"
    caps.configure(cfg, tmp_path, model, ["high"])
    caps.configure(cfg, tmp_path, "custom/second", ["max"])
    applied = caps.apply_definitions(cfg, tmp_path)
    applied["models"]["providers"]["custom"]["models"][0]["compat"]["supportedReasoningEfforts"] = ["medium"]
    applied["models"]["providers"]["custom"]["models"][0]["compat"]["supportsDeveloperRole"] = True
    result = caps.configure(applied, tmp_path, model, None)
    assert result["levels"] == ["default", "medium"]
    restored = caps.restore_definitions(applied, tmp_path, {model})
    first, second = restored["models"]["providers"]["custom"]["models"]
    assert first["compat"]["supportedReasoningEfforts"] == ["medium"]
    assert first["compat"]["supportsDeveloperRole"] is True
    assert second["compat"]["supportedReasoningEfforts"] == ["max"]


def test_reset_after_unapplied_manual_changes_still_removes_last_persisted_overlay(tmp_path):
    cfg = config("custom-model")
    model = "custom/custom-model"
    caps.configure(cfg, tmp_path, model, ["low"])
    applied = caps.apply_definitions(cfg, tmp_path)
    caps.configure(applied, tmp_path, model, ["high"])
    caps.configure(applied, tmp_path, model, ["max"])
    assert caps.configure(applied, tmp_path, model, None)["source"] == "unknown"
    assert caps.restore_definitions(applied, tmp_path) == cfg


def test_changed_connection_does_not_turn_owned_overlay_into_provider_declaration(tmp_path):
    cfg = config("custom-model")
    model = "custom/custom-model"
    caps.configure(cfg, tmp_path, model, ["low", "max"])
    applied = caps.apply_definitions(cfg, tmp_path)
    applied["models"]["providers"]["custom"]["baseUrl"] = "https://replacement.invalid/v1"
    cap = caps.capability(applied, model, tmp_path)
    assert cap["source"] == "unknown"
    assert cap["levels"] == ["default"]


def test_global_default_does_not_revalidate_untouched_thinking_overrides(tmp_path):
    cfg = config()
    cfg["models"]["providers"]["custom"]["models"].append({"id": "limited", "compat": {"supportedReasoningEfforts": ["low"]}})
    cfg["agents"]["list"].append({"id": "beta", "model": "custom/limited", "thinkingDefault": "low"})
    assert caps.validate(cfg, tmp_path, "high", global_profile=True) == "high"


def test_none_carrier_is_explicit_persistent_and_reversed_for_settings(tmp_path):
    cfg = config()
    cap = caps.capability(cfg, "custom/gpt-5.6-terra", tmp_path)
    assert cap["mapping"]["none"] == "minimal"
    assert cap["wireMapping"]["none"] == "none"
    applied = caps.apply_definitions(cfg, tmp_path)
    entry = applied["models"]["providers"]["custom"]["models"][0]
    assert entry["compat"]["reasoningEffortMap"]["minimal"] == "none"
    applied["agents"]["defaults"]["thinkingDefault"] = "minimal"
    # A restart reads the actual native JSON, not an in-memory UI alias.
    restarted = json.loads(json.dumps(applied))
    agent = caps.snapshot(restarted, tmp_path)["agents"][0]
    assert agent["thinkingDefault"] == "none"
    assert agent["runtimeThinkingDefault"] == "minimal"
    assert caps.validate(restarted, tmp_path, "minimal", agent_id="alpha") == "minimal"


@pytest.mark.parametrize("entry", [
    {"compat": {"supportedReasoningEfforts": ["none", "minimal", "high"]}},
    {"compat": {"supportedReasoningEfforts": ["none", "high"], "reasoningEffortMap": {"minimal": "low"}}},
    {"compat": {"supportedReasoningEfforts": ["none", "high"]}, "thinkingLevelMap": {"minimal": "high"}},
])
def test_none_carrier_conflicts_are_not_silently_overwritten(tmp_path, entry):
    cfg = config("custom-model", **entry)
    cap = caps.capability(cfg, "custom/custom-model", tmp_path)
    assert "none" not in cap["levels"]
    assert "none" not in cap["probeLevels"]
    assert any("none" in warning and "映射" in warning for warning in cap["warnings"])
    assert "high" in cap["levels"]
    applied = caps.apply_definitions(cfg, tmp_path)["models"]["providers"]["custom"]["models"][0]
    if "reasoningEffortMap" in entry.get("compat", {}):
        assert applied["compat"]["reasoningEffortMap"] == entry["compat"]["reasoningEffortMap"]
    if "thinkingLevelMap" in entry:
        assert applied["thinkingLevelMap"]["minimal"] == entry["thinkingLevelMap"]["minimal"]


def test_none_carrier_metadata_is_restored_when_manual_declaration_is_reset(tmp_path):
    cfg = config("custom-model")
    model = "custom/custom-model"
    caps.configure(cfg, tmp_path, model, ["none", "high"])
    applied = caps.apply_definitions(cfg, tmp_path)
    assert applied["models"]["providers"]["custom"]["models"][0]["compat"]["reasoningEffortMap"] == {"minimal": "none"}
    caps.configure(applied, tmp_path, model, None)
    assert caps.restore_definitions(applied, tmp_path) == cfg


def test_global_none_rejects_mixed_runtime_mappings_including_default_model(tmp_path):
    cfg = config()
    cfg["models"]["providers"]["custom"]["models"].append({
        "id": "other", "api": "anthropic-messages", "compat": {"supportedReasoningEfforts": ["none", "high"]}})
    cfg["agents"]["list"] = [{"id": "alpha", "model": "custom/other"}]
    with pytest.raises(ValueError, match="不同的运行时"):
        caps.validate(cfg, tmp_path, "none", global_profile=True)


def test_old_model_controls_reverse_mapping_before_model_only_change(tmp_path):
    cfg = config()
    cfg["models"]["providers"]["custom"]["models"].append({
        "id": "minimal-native", "compat": {"supportedReasoningEfforts": ["minimal", "high"]}})
    requested = caps.model_thinking(cfg, tmp_path, "custom/gpt-5.6-terra", "minimal")
    assert requested == "none"
    with pytest.raises(ValueError, match="none"):
        caps.validate(cfg, tmp_path, requested, model="custom/minimal-native")
    assert caps.model_thinking(cfg, tmp_path, "custom/minimal-native", "minimal") == "minimal"


@pytest.mark.parametrize("model", ["gpt-5.6", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"])
def test_official_gpt56_completions_only_offers_tool_safe_none(tmp_path, model):
    cfg = config(model)
    cfg["models"]["providers"]["custom"]["baseUrl"] = "https://api.openai.com/v1"
    cap = caps.capability(cfg, "custom/" + model, tmp_path)
    assert cap["levels"] == ["default", "none"]
    assert cap["mapping"]["none"] == "minimal"
    assert "high" in cap["probeLevels"]
    assert any("强制发送 none" in warning and "API 接纳检测" in warning for warning in cap["warnings"])
    with pytest.raises(ValueError, match="high"):
        caps.validate(cfg, tmp_path, "high", model="custom/" + model)


def test_official_gpt55_completions_does_not_offer_omitted_efforts(tmp_path):
    cfg = config("gpt-5.5")
    cfg["models"]["providers"]["custom"]["baseUrl"] = "https://api.openai.com/v1/"
    cap = caps.capability(cfg, "custom/gpt-5.5", tmp_path)
    assert cap["levels"] == ["default"]
    assert cap["probeLevels"] == ["low", "medium", "high", "xhigh"]
    assert any("省略思考参数" in warning for warning in cap["warnings"])


def test_official_tool_restriction_does_not_spread_to_custom_urls_protocols_or_aliases(tmp_path):
    cfg = config()
    cfg["models"]["providers"]["custom"]["baseUrl"] = "https://custom.invalid/v1"
    assert "high" in caps.capability(cfg, "custom/gpt-5.6-terra", tmp_path)["levels"]
    cfg["models"]["providers"]["custom"]["baseUrl"] = "https://api.openai.com.evil.invalid/v1"
    assert "high" in caps.capability(cfg, "custom/gpt-5.6-terra", tmp_path)["levels"]
    cfg["models"]["providers"]["custom"]["baseUrl"] = "https://api.openai.com/v1"
    cfg["models"]["providers"]["custom"]["api"] = "openai-responses"
    assert "high" in caps.capability(cfg, "custom/gpt-5.6-terra", tmp_path)["levels"]
    unknown = config("gpt-5.6-preview", compat={"supportedReasoningEfforts": ["high"]})
    unknown["models"]["providers"]["custom"]["baseUrl"] = "https://api.openai.com/v1"
    assert caps.capability(unknown, "custom/gpt-5.6-preview", tmp_path)["levels"] == ["default", "high"]


def test_model_specific_url_is_the_native_policy_and_evidence_binding(tmp_path):
    cfg = config(baseUrl="https://api.openai.com/v1")
    assert caps.capability(cfg, "custom/gpt-5.6-terra", tmp_path)["levels"] == ["default", "none"]
    before = caps._connection_fingerprint(*caps.definition(cfg, "custom/gpt-5.6-terra"))
    cfg["models"]["providers"]["custom"]["models"][0]["baseUrl"] = "https://custom.invalid/v1"
    assert "high" in caps.capability(cfg, "custom/gpt-5.6-terra", tmp_path)["levels"]
    assert caps._connection_fingerprint(*caps.definition(cfg, "custom/gpt-5.6-terra")) != before


def test_custom_completions_max_is_declared_and_probeable_but_never_native(tmp_path):
    cfg = config()
    cap = caps.capability(cfg, "custom/gpt-5.6-terra", tmp_path)
    assert "max" in cap["declaredLevels"]
    assert "max" in cap["probeLevels"]
    assert "max" not in cap["levels"]
    assert "max" not in cap["runtimeLevels"]
    assert "max" not in cap["mapping"]
    assert cap["wireMapping"]["max"] == "max"
    assert any("原生 CLI" in warning and "不会降为 xhigh" in warning for warning in cap["warnings"])
    with pytest.raises(ValueError, match="max"):
        caps.validate(cfg, tmp_path, "max", agent_id="alpha")
    assert caps.validate(cfg, tmp_path, "xhigh", agent_id="alpha") == "xhigh"


def test_manual_declaration_cannot_bypass_custom_provider_max_limit(tmp_path):
    cfg = config("custom-model")
    cap = caps.configure(cfg, tmp_path, "custom/custom-model", ["max"])
    assert cap["source"] == "manual"
    assert cap["declaredLevels"] == ["max"]
    assert cap["probeLevels"] == ["max"]
    assert cap["levels"] == ["default"]


def test_native_openai_provider_profile_is_not_treated_as_custom_provider(tmp_path):
    cfg = config()
    cfg["models"]["providers"]["openai"] = cfg["models"]["providers"].pop("custom")
    cfg["agents"]["defaults"]["model"] = "openai/gpt-5.6-terra"
    cap = caps.capability(cfg, "openai/gpt-5.6-terra", tmp_path)
    assert "max" in cap["levels"]
    assert cap["mapping"]["max"] == "max"
    assert caps.validate(cfg, tmp_path, "max", agent_id="alpha") == "max"


def test_http_api_shape_configuration_and_secret_boundary(tmp_path, monkeypatch):
    sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "dashboard"))
    import server
    home = tmp_path / "openclaw"
    home.mkdir()
    cfg = config()
    cfg["models"]["providers"]["custom"]["apiKey"] = "never-return-this-key"
    (home / "openclaw.json").write_text(json.dumps(cfg))
    monkeypatch.setattr(server, "OCLAW_HOME", home)
    monkeypatch.setattr(server, "DATA", tmp_path)
    monkeypatch.setattr(server.Handler, "_check_auth", lambda self: False)
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    base = f"http://127.0.0.1:{httpd.server_port}"
    def request(route, body=None):
        req = caps.urllib.request.Request(base + route, data=None if body is None else json.dumps(body).encode(),
                                         headers={"Content-Type": "application/json"})
        with caps.urllib.request.urlopen(req) as response:
            return json.load(response)
    try:
        result = request("/api/model-capabilities")
        assert result["models"][0]["model"] == "custom/gpt-5.6-terra"
        assert result["agents"][0]["thinkingDefault"] == "default"
        assert "never-return-this-key" not in json.dumps(result)
        assert request("/api/model-capabilities/validate", {"agentId": "alpha", "thinking": "none"})["thinking"] == "minimal"
        changed = request("/api/model-capabilities/configure", {"model": "custom/gpt-5.6-terra", "levels": ["low"]})
        assert changed["capability"]["source"] == "manual"
        assert changed["capability"]["levels"] == ["default", "low"]
        with pytest.raises(caps.urllib.error.HTTPError) as error:
            request("/api/model-capabilities/validate", {"agentId": "alpha", "thinking": "max"})
        assert error.value.code == 400
        assert json.loads((home / "openclaw.json").read_text()) == cfg
        (home / "openclaw.json").write_text(json.dumps(caps.apply_definitions(cfg, tmp_path)))
        reset = request("/api/model-capabilities/configure", {"model": "custom/gpt-5.6-terra", "levels": None})
        assert reset["capability"]["source"] == "catalog"
        stored_model = json.loads((home / "openclaw.json").read_text())["models"]["providers"]["custom"]["models"][0]
        assert "supportedReasoningEfforts" not in stored_model.get("compat", {})
    finally:
        httpd.shutdown()
        httpd.server_close()
        thread.join()
