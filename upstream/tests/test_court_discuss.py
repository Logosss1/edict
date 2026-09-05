"""Regression tests for the desktop-backed 朝堂议政 LLM integration."""

from __future__ import annotations

import copy
import json
import pathlib
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "dashboard"))
sys.path.insert(0, str(ROOT / "scripts"))

import court_discuss as court


@pytest.fixture
def isolated_config(tmp_path, monkeypatch):
    config_path = tmp_path / "openclaw.json"
    config_path.write_text(json.dumps({
        "agents": {"defaults": {"model": "custom/gpt-5.6-terra"}},
        "models": {"providers": {"custom": {
            "baseUrl": "http://127.0.0.1:1",
            "api": "openai-completions",
            "apiKey": {"source": "env", "id": "EDICT_PROVIDER_CUSTOM_API_KEY"},
            "models": [{"id": "gpt-5.6-terra"}, {"id": "gpt-4o-mini"}],
        }}},
    }), encoding="utf-8")
    monkeypatch.setenv("OPENCLAW_CONFIG_PATH", str(config_path))
    monkeypatch.setenv("EDICT_PROVIDER_CUSTOM_API_KEY", "fixture-secret")
    monkeypatch.delenv("OPENCLAW_LLM_API_KEY", raising=False)
    monkeypatch.setattr(court, "_read_copilot_token", lambda: None)
    return config_path


def test_desktop_config_selects_bound_model_and_resolves_secret_ref(isolated_config):
    config = court._get_llm_config()
    assert config["provider"] == "custom"
    assert config["model"] == "gpt-5.6-terra"
    assert config["api_key"] == "fixture-secret"
    assert config["base_url"].endswith(":1")


def test_openai_root_url_uses_v1_and_sends_resolved_secret(isolated_config):
    requests = []

    class MockModel(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def do_POST(self):
            size = int(self.headers.get("Content-Length", "0"))
            requests.append((self.path, self.headers.get("Authorization"), self.rfile.read(size)))
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"choices": [{"message": {"content": "ok"}}]}).encode())

    server = ThreadingHTTPServer(("127.0.0.1", 0), MockModel)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        config_path = pathlib.Path(isolated_config)
        config = json.loads(config_path.read_text(encoding="utf-8"))
        config["models"]["providers"]["custom"]["baseUrl"] = f"http://127.0.0.1:{server.server_port}"
        config_path.write_text(json.dumps(config), encoding="utf-8")
        assert court._llm_complete("system", "question") == "ok"
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=3)
    assert requests and requests[0][0] == "/v1/chat/completions"
    assert requests[0][1] == "Bearer fixture-secret"


def test_configured_provider_failure_is_not_replaced_by_simulation(isolated_config, monkeypatch):
    monkeypatch.setattr(court, "_llm_complete", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(court, "_sessions", {})
    monkeypatch.setattr(court, "_storage", None)
    monkeypatch.setattr(court, "_attachments", None)
    session = court.create_session("specific question", ["zhongshu", "menxia"])
    before = copy.deepcopy(court.get_session(session["session_id"]))

    result = court.advance_discussion(session["session_id"], "answer this exact question")

    assert result["ok"] is False
    assert "未使用模拟回复" in result["error"]
    after = court.get_session(session["session_id"])
    assert after["round"] == before["round"]
    assert after["messages"] == before["messages"]


def test_current_emperor_question_is_added_to_prompt_once(isolated_config, monkeypatch):
    prompts = []

    def complete(_system, prompt, **_options):
        prompts.append(prompt)
        return json.dumps({"messages": [{
            "official_id": "zhongshu", "name": "中书令", "content": "针对本问回奏",
        }]})

    monkeypatch.setattr(court, "_llm_complete", complete)
    monkeypatch.setattr(court, "_sessions", {})
    monkeypatch.setattr(court, "_storage", None)
    monkeypatch.setattr(court, "_attachments", None)
    session = court.create_session("prompt dedupe", ["zhongshu", "menxia"])

    result = court.advance_discussion(session["session_id"], "UNIQUE_EMPEROR_QUESTION")

    assert result["ok"] is True
    assert prompts and prompts[0].count("UNIQUE_EMPEROR_QUESTION") == 1


def test_transport_error_is_preserved_in_actionable_failure(isolated_config, monkeypatch):
    def fail(*_args, **_kwargs):
        court._set_llm_error("HTTP 502: upstream unavailable")
        return None

    monkeypatch.setattr(court, "_llm_complete", fail)
    monkeypatch.setattr(court, "_sessions", {})
    monkeypatch.setattr(court, "_storage", None)
    monkeypatch.setattr(court, "_attachments", None)
    session = court.create_session("network failure", ["zhongshu"])

    result = court.advance_discussion(session["session_id"], "请回答这个问题")

    assert result["ok"] is False
    assert "HTTP 502" in result["error"]


def test_gongbu_simulation_pool_is_selectable_without_type_error(monkeypatch, tmp_path):
    config_path = tmp_path / "openclaw.json"
    config_path.write_text(json.dumps({"models": {"providers": {}}}), encoding="utf-8")
    monkeypatch.setenv("OPENCLAW_CONFIG_PATH", str(config_path))
    monkeypatch.setattr(court, "_read_copilot_token", lambda: None)
    monkeypatch.setattr(court, "_sessions", {})
    monkeypatch.setattr(court, "_storage", None)
    monkeypatch.setattr(court, "_attachments", None)
    session = court.create_session("模拟工部", ["gongbu"])

    result = court.advance_discussion(session["session_id"], "请给出技术建议")

    assert result["ok"] is True
    assert result["new_messages"][0]["official_id"] == "gongbu"


def test_no_provider_keeps_explicit_demo_marker(monkeypatch, tmp_path):
    config_path = tmp_path / "openclaw.json"
    config_path.write_text(json.dumps({"models": {"providers": {}}}), encoding="utf-8")
    monkeypatch.setenv("OPENCLAW_CONFIG_PATH", str(config_path))
    monkeypatch.delenv("OPENCLAW_LLM_API_KEY", raising=False)
    monkeypatch.setattr(court, "_read_copilot_token", lambda: None)
    monkeypatch.setattr(court, "_sessions", {})
    monkeypatch.setattr(court, "_storage", None)
    monkeypatch.setattr(court, "_attachments", None)

    session = court.create_session("demo", ["zhongshu", "menxia"])
    result = court.advance_discussion(session["session_id"], "demo question")

    assert result["ok"] is True
    assert result["simulated"] is True
    assert result["simulation_notice"]


def test_simulation_keeps_current_question_in_each_reply(monkeypatch, tmp_path):
    config_path = tmp_path / "openclaw.json"
    config_path.write_text(json.dumps({"models": {"providers": {}}}), encoding="utf-8")
    monkeypatch.setenv("OPENCLAW_CONFIG_PATH", str(config_path))
    monkeypatch.delenv("OPENCLAW_LLM_API_KEY", raising=False)
    monkeypatch.setattr(court, "_read_copilot_token", lambda: None)
    monkeypatch.setattr(court, "_sessions", {})
    monkeypatch.setattr(court, "_storage", None)
    monkeypatch.setattr(court, "_attachments", None)

    session = court.create_session("模拟问题", ["zhongshu"])
    first = court.advance_discussion(session["session_id"], "问题甲")
    second = court.advance_discussion(session["session_id"], "问题乙")

    first_content = first["new_messages"][0]["content"]
    second_content = second["new_messages"][0]["content"]
    assert "问题甲" in first_content
    assert "问题乙" in second_content
    assert first_content != second_content


def test_delete_concluded_session_removes_storage_and_attachments(monkeypatch, tmp_path):
    from chat_attachments import AttachmentStore

    data_dir = tmp_path / "data"
    data_dir.mkdir()
    monkeypatch.setattr(court, "_sessions", {})
    monkeypatch.setattr(court, "_storage", data_dir / "court-discussions")
    court._storage.mkdir()
    monkeypatch.setattr(court, "_attachments", AttachmentStore(data_dir))

    session = court.create_session("可删除朝议", ["zhongshu"])
    sid = session["session_id"]
    court._attachments.upload(f"court-{sid}", "材料.txt", b"court attachment")
    court._sessions[sid]["phase"] = "concluded"
    court._persist(court._sessions[sid])

    result = court.delete_session(sid)
    assert result["ok"] is True
    assert court.get_session(sid) is None
    assert not (court._storage / f"{sid}.json").exists()
    assert not (court._attachments.root_dir / f"court-{sid}").exists()


def test_delete_discussing_session_requires_conclusion(monkeypatch):
    monkeypatch.setattr(court, "_sessions", {})
    monkeypatch.setattr(court, "_storage", None)
    monkeypatch.setattr(court, "_attachments", None)
    session = court.create_session("不能删除进行中的朝议", ["zhongshu"])

    result = court.delete_session(session["session_id"])
    assert result["ok"] is False
    assert "散朝" in result["error"]
    assert court.get_session(session["session_id"]) is not None
