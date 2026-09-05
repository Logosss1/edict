"""Focused tests for the persistent 御书房 service."""

from __future__ import annotations

import json
import pathlib
import sys
import threading
import time
from http.client import HTTPConnection
from http.server import HTTPServer

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "dashboard"))
sys.path.insert(0, str(ROOT / "scripts"))

from yushufang import YushufangService


CATALOG = {
    "alpha": {"name": "甲臣", "role": "工部"},
    "beta": {"name": "乙臣", "role": "刑部"},
    "outsider": {"name": "外臣", "role": "户部"},
}


class FakeProcess:
    instances: list["FakeProcess"] = []
    release = threading.Event()
    block = False

    def __init__(self, command, **kwargs):
        self.command = command
        self.kwargs = kwargs
        self.returncode = 0
        self.pid = None
        self.terminated = False
        self.stdout = json.dumps(
            {
                "status": "ok",
                "result": {
                    "meta": {"finalAssistantVisibleText": f"答复 {command[command.index('--agent') + 1]}\n待御批：无"},
                    "payloads": [],
                },
            },
            ensure_ascii=False,
        )
        self.stderr = ""
        type(self).instances.append(self)

    def communicate(self, timeout=None):
        if type(self).block:
            type(self).release.wait(timeout=timeout)
        return self.stdout, self.stderr

    def poll(self):
        return self.returncode if self.terminated else None

    def terminate(self):
        self.terminated = True
        type(self).release.set()


class QuestionAwareProcess(FakeProcess):
    """Fixture model that changes its reply when the current question changes."""

    def __init__(self, command, **kwargs):
        super().__init__(command, **kwargs)
        prompt = command[command.index("--message") + 1]
        current = next(
            (line.split("：", 1)[1] for line in prompt.splitlines() if line.startswith("本轮皇上最新圣谕：")),
            "当前问题",
        )
        self.stdout = json.dumps(
            {
                "status": "ok",
                "result": {
                    "meta": {"finalAssistantVisibleText": f"答复 {current}\n待御批：无"},
                    "payloads": [],
                },
            },
            ensure_ascii=False,
        )


class ProposalProcess(FakeProcess):
    """Fake OpenClaw reply that creates a pending approval proposal."""

    def __init__(self, command, **kwargs):
        super().__init__(command, **kwargs)
        self.stdout = json.dumps(
            {
                "status": "ok",
                "result": {
                    "meta": {
                        "finalAssistantVisibleText": (
                            "方案：先完成评估。\n"
                            "风险/验收：确认评估结果。\n"
                            "待御批：\n- 先行评估"
                        )
                    },
                    "payloads": [],
                },
            },
            ensure_ascii=False,
        )


def make_service(tmp_path, *, process_factory=FakeProcess):
    FakeProcess.instances.clear()
    FakeProcess.release = threading.Event()
    FakeProcess.block = False
    return YushufangService(
        tmp_path / "data",
        openclaw_bin="/test/openclaw",
        agent_catalog=lambda: CATALOG,
        process_factory=process_factory,
        command_timeout_seconds=30,
        runtime_preparer=lambda *_args: ({}, {}, {"model": "test/mock", "levels": ["default", "low", "medium", "high", "max"]}),
    )


def room_from(result):
    assert result["ok"], result
    return result["room"]


def _start_http_server(service, monkeypatch):
    """Run the real dashboard Handler against an injected Yushufang service."""
    import server as srv

    monkeypatch.setattr(srv, "DATA", service.data_dir)
    monkeypatch.setattr(srv, "_YUSHUFANG_SERVICE", service)
    monkeypatch.setattr(srv, "requires_auth", lambda _path: False)
    httpd = HTTPServer(("127.0.0.1", 0), srv.Handler)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    return httpd, thread


def _http_json(httpd, method, path, payload=None):
    body = None
    headers = {}
    if payload is not None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        headers["Content-Type"] = "application/json"
    conn = HTTPConnection("127.0.0.1", httpd.server_port, timeout=5)
    try:
        conn.request(method, path, body=body, headers=headers)
        response = conn.getresponse()
        status = response.status
        data = json.loads(response.read().decode("utf-8"))
        return status, data
    finally:
        conn.close()


def test_open_room_persists_isolated_invited_members_and_keys(tmp_path):
    service = make_service(tmp_path)

    room = room_from(service.open_room("设计发布方案", ["alpha", "beta"], thinking="high"))
    path = tmp_path / "data" / "yushufang" / "active" / f"{room['id']}.json"

    assert path.exists()
    stored = json.loads(path.read_text(encoding="utf-8"))
    assert stored["thinking"] == "high"
    assert [member["id"] for member in stored["members"]] == ["alpha", "beta"]
    assert stored["agentSessions"]["alpha"]["sessionKey"] == f"agent:alpha:yushufang:{room['id']}"
    assert "agentSessions" not in room  # secrets/internal routing metadata stay server-side
    assert service.open_room("bad", ["outsider", "not-registered"])["ok"] is False


def test_public_room_schema_exposes_room_id_phase_and_participants(tmp_path):
    service = make_service(tmp_path)

    opened = room_from(service.open_room("检查公开接口契约", ["alpha", "beta"], thinking="low"))
    assert opened["roomId"] == opened["id"]
    assert opened["phase"] == "idle"
    assert [item["id"] for item in opened["participants"]] == ["alpha", "beta"]
    assert all(item["state"] == "present" for item in opened["participants"])
    assert "agentSessions" not in opened

    fetched = service.get_room(opened["roomId"])
    assert fetched["ok"] is True
    assert fetched["room"]["roomId"] == opened["roomId"]
    assert fetched["room"]["phase"] == "idle"
    assert [item["id"] for item in fetched["room"]["participants"]] == ["alpha", "beta"]

    listed = service.list_rooms()
    assert listed["ok"] is True
    assert listed["rooms"][0]["roomId"] == opened["roomId"]
    assert listed["rooms"][0]["phase"] == "idle"


def test_only_one_unfinished_room_can_exist_at_a_time(tmp_path):
    service = make_service(tmp_path)
    first = room_from(service.open_room("唯一进行中的议事", ["alpha"]))

    blocked = service.open_room("不应同时开启", ["beta"])
    assert blocked["ok"] is False
    assert "只能有一场" in blocked["error"]

    assert service.conclude(first["id"])["ok"] is True
    second = room_from(service.open_room("上一场结束后开启", ["beta"]))
    assert second["id"] != first["id"]


def test_delete_ended_room_removes_record_attachments_and_runtime(tmp_path):
    service = make_service(tmp_path)
    room = room_from(service.open_room("可删除的密档", ["alpha"]))
    service.attachments.upload(room["id"], "记录.txt", b"private attachment")
    runtime_dir = service.root_dir / "runtime" / room["id"]
    runtime_dir.mkdir(parents=True)
    (runtime_dir / "trace.txt").write_text("runtime", encoding="utf-8")

    assert service.delete(room["id"])["ok"] is False
    assert service.conclude(room["id"])["ok"] is True
    assert service.archive(room["id"])["ok"] is True
    assert service.delete(room["id"])["ok"] is True
    assert not (service.archive_dir / f"{room['id']}.json").exists()
    assert not (service.root_dir / "runtime" / room["id"]).exists()
    assert not (service.attachments.root_dir / room["id"]).exists()
    assert service.list_rooms(include_archived=True)["rooms"] == []


def test_catalog_uses_registered_runtime_agents_without_implicit_default_roster(tmp_path):
    data_dir = tmp_path / "data"
    data_dir.mkdir()
    (data_dir / "agent_config.json").write_text(
        json.dumps({"agents": [{"id": "only-agent", "label": "唯一臣工", "role": "专员"}]}),
        encoding="utf-8",
    )

    service = YushufangService(data_dir, openclaw_bin="/test/openclaw")

    listed = service.list_agents()
    assert listed["ok"] is True
    assert [item["id"] for item in listed["agents"]] == ["only-agent"]
    assert service.open_room("只召见已注册 Agent", ["only-agent"])["ok"] is True
    assert service.open_room("默认名单不应混入", ["taizi"])["ok"] is False


def test_speak_runs_real_agents_serially_with_private_session_keys(tmp_path):
    service = make_service(tmp_path)
    room = room_from(service.open_room("提出实施建议", ["alpha", "beta"]))

    result = service.speak(room["id"], "请给出落地方案", thinking="max")
    assert result["ok"] is True
    assert service.wait_for_idle(room["id"], timeout=3)

    assert [p.command[p.command.index("--agent") + 1] for p in FakeProcess.instances] == ["alpha", "beta"]
    assert [p.command[p.command.index("--session-key") + 1] for p in FakeProcess.instances] == [
        f"agent:alpha:yushufang:{room['id']}",
        f"agent:beta:yushufang:{room['id']}",
    ]
    assert all(p.command[p.command.index("--thinking") + 1] == "max" for p in FakeProcess.instances)
    assert all("--json" in p.command and "--message" in p.command for p in FakeProcess.instances)
    assert pathlib.Path(FakeProcess.instances[0].kwargs["cwd"]).is_dir()
    assert pathlib.Path(FakeProcess.instances[0].kwargs["cwd"]).name == "alpha"
    assert all(p.kwargs["cwd"] != str(tmp_path) for p in FakeProcess.instances)

    stored = service.get_room(room["id"])["room"]
    assert [item["authorId"] for item in stored["messages"] if item["kind"] == "agent"] == ["alpha", "beta"]
    assert "outsider" not in "\n".join(p.command[-1] for p in FakeProcess.instances)


def test_none_runtime_carrier_is_not_misreported_as_requested_minimal(tmp_path):
    service = make_service(tmp_path)
    service.runtime_preparer = lambda *_args: ({}, {}, {
        "model": "custom/gpt-5.6-sol", "levels": ["default", "none", "high"],
        "mapping": {"default": "default", "none": "minimal", "high": "high"},
        "wireMapping": {"none": "none", "high": "high"}})
    room = room_from(service.open_room("检查思考兼容", ["alpha"], thinking="none"))
    assert service.speak(room["id"], "请提出方案")["ok"]
    assert service.wait_for_idle(room["id"], timeout=3)
    command = FakeProcess.instances[0].command
    assert command[command.index("--thinking") + 1] == "minimal"
    cap = service.get_room(room["id"])["room"]["capabilities"]["alpha"]
    assert cap["requestedThinking"] == "none"
    assert cap["runtimeThinking"] == "minimal"
    assert cap["effectiveThinking"] == "none"


def test_unsupported_native_max_is_rejected_before_consuming_message(tmp_path, monkeypatch):
    from yushufang_runtime import prepare_runtime
    service = make_service(tmp_path)
    source = tmp_path / "openclaw.json"
    source.write_text(json.dumps({
        "models": {"providers": {"custom": {"api": "openai-completions", "models": [{"id": "gpt-5.6-sol"}]}}},
        "agents": {"defaults": {"model": "custom/gpt-5.6-sol"}, "list": [{"id": "alpha"}]},
    }))
    monkeypatch.setenv("OPENCLAW_CONFIG_PATH", str(source))
    service.runtime_preparer = prepare_runtime
    room = room_from(service.open_room("检查原生能力", ["alpha"]))
    result = service.speak(room["id"], "不应消耗这条消息", thinking="max")
    assert result["ok"] is False
    assert "max" in result["error"]
    stored = service.get_room(room["id"])["room"]
    assert stored["messages"] == room["messages"]
    assert stored["status"] == "active"
    assert FakeProcess.instances == []


def _failed_native_room(tmp_path, monkeypatch):
    from yushufang_runtime import prepare_runtime
    service = make_service(tmp_path)
    source = tmp_path / "openclaw.json"
    source.write_text(json.dumps({
        "models": {"providers": {"custom": {"api": "openai-completions", "apiKey": "fixture-only",
            "models": [{"id": "gpt-5.6-sol", "name": "Fixture"}]}}},
        "agents": {"defaults": {"model": "custom/gpt-5.6-sol"}, "list": [{"id": "alpha"}, {"id": "beta"}]},
    }))
    monkeypatch.setenv("OPENCLAW_CONFIG_PATH", str(source))
    monkeypatch.setenv("EDICT_DATA_DIR", str(service.data_dir))
    service.runtime_preparer = prepare_runtime
    room = room_from(service.open_room("恢复旧会话", ["alpha", "beta"]))
    emperor = service._message("emperor", "提出方案", run_id="run-fixture")
    reply = service._message("agent", "甲臣已完成的回奏", author_id="alpha", run_id="run-fixture")
    def fail(current):
        current["thinking"] = "max"
        current["status"] = "paused"
        current["messages"].extend([emperor, reply])
        current["run"] = {"id": "run-fixture", "status": "failed", "thinking": "max",
            "participantIds": ["alpha", "beta"], "nextIndex": 2, "messageId": emperor["id"],
            "successfulAgentIds": ["alpha"], "errors": [{"agentId": "beta", "error": "max unsupported"}],
            "cancelRequested": False}
        return current
    service._mutate_active(room["id"], fail)
    return service, service.get_room(room["id"])["room"]


def test_resume_uses_explicit_new_thinking_only_for_unfinished_agents(tmp_path, monkeypatch):
    service, before = _failed_native_room(tmp_path, monkeypatch)
    httpd, thread = _start_http_server(service, monkeypatch)
    try:
        status, result = _http_json(httpd, "POST", "/api/yushufang/resume",
                                   {"roomId": before["id"], "thinkingDefault": "xhigh"})
        assert status == 200
        assert result["ok"] is True
        assert service.wait_for_idle(before["id"], timeout=3)
    finally:
        httpd.shutdown()
        httpd.server_close()
        thread.join(timeout=2)
    assert [process.command[process.command.index("--agent") + 1] for process in FakeProcess.instances] == ["beta"]
    assert FakeProcess.instances[0].command[FakeProcess.instances[0].command.index("--thinking") + 1] == "xhigh"
    stored = service.get_room(before["id"])["room"]
    assert stored["messages"][:len(before["messages"])] == before["messages"]
    assert len([message for message in stored["messages"] if message.get("authorId") == "alpha"]) == 1
    assert stored["thinking"] == stored["run"]["thinking"] == "xhigh"
    assert set(stored["run"]["successfulAgentIds"]) == {"alpha", "beta"}
    assert stored["run"]["errors"] == []


def test_resume_invalid_or_unchanged_unsupported_thinking_preserves_failure_state(tmp_path, monkeypatch):
    service, before = _failed_native_room(tmp_path, monkeypatch)
    path = service.active_dir / (before["id"] + ".json")
    original = path.read_bytes()
    for thinking in (None, "max", "ultra", "invalid", ""):
        result = service.resume(before["id"], thinking=thinking)
        assert result["ok"] is False
        assert path.read_bytes() == original
        assert FakeProcess.instances == []
    stored = service.get_room(before["id"])["room"]
    assert stored["run"]["errors"] == before["run"]["errors"]
    assert stored["run"]["successfulAgentIds"] == ["alpha"]
    assert stored["run"]["thinking"] == "max"


def test_prompt_allows_research_but_prohibits_execution_and_preserves_room_scope(tmp_path):
    service = make_service(tmp_path)
    room = room_from(service.open_room("评估系统风险", ["alpha", "beta"]))

    service.speak(room["id"], "只分析，不要直接改代码")
    assert service.wait_for_idle(room["id"], timeout=3)
    first_prompt = FakeProcess.instances[0].command[-1]

    assert "当前殿内受邀臣子：甲臣、乙臣" in first_prompt
    assert "本轮皇上最新圣谕" in first_prompt
    assert "外臣" not in first_prompt
    assert "可以使用已配置的联网能力、Skills 与 MCP" in first_prompt
    assert "严禁执行命令、运行脚本、修改/创建/删除文件" in first_prompt
    assert "派发/创建/推进/取消 EDICT 任务" in first_prompt


def test_repeated_reply_for_a_different_question_is_not_recorded_as_success(tmp_path):
    service = make_service(tmp_path)
    room = room_from(service.open_room("拒绝陈旧回奏", ["alpha"]))

    assert service.speak(room["id"], "问题甲")["ok"]
    assert service.wait_for_idle(room["id"], timeout=3)
    assert service.speak(room["id"], "问题乙")["ok"]
    assert service.wait_for_idle(room["id"], timeout=3)

    stored = service.get_room(room["id"])["room"]
    replies = [message for message in stored["messages"] if message.get("kind") == "agent"]
    errors = [message for message in stored["messages"] if message.get("kind") == "error"]
    assert [message["content"] for message in replies] == ["答复 alpha\n待御批：无"]
    assert stored["phase"] == "failed"
    assert errors and "不同问题相同的答复" in errors[-1]["content"]


def test_same_question_is_not_rejected_as_a_repeated_reply(tmp_path):
    service = make_service(tmp_path)
    room = room_from(service.open_room("允许重问", ["alpha"]))

    assert service.speak(room["id"], "同一个问题")["ok"]
    assert service.wait_for_idle(room["id"], timeout=3)
    assert service.speak(room["id"], "同一个问题")["ok"]
    assert service.wait_for_idle(room["id"], timeout=3)

    stored = service.get_room(room["id"])["room"]
    assert stored["phase"] == "idle"
    assert len([message for message in stored["messages"] if message.get("kind") == "agent"]) == 2


def test_cancel_stops_current_process_and_resume_restarts_interrupted_member(tmp_path):
    service = make_service(tmp_path)
    FakeProcess.block = True
    room = room_from(service.open_room("分阶段实施", ["alpha", "beta"]))
    service.speak(room["id"], "给出方案")

    deadline = time.time() + 3
    while time.time() < deadline:
        current = service.get_room(room["id"])["room"].get("run") or {}
        if current.get("currentAgentId") == "alpha":
            break
        time.sleep(0.01)
    assert service.get_room(room["id"])["room"]["run"]["currentAgentId"] == "alpha"

    cancelled = service.cancel(room["id"])
    assert cancelled["ok"] is True
    assert FakeProcess.instances[0].terminated is True
    assert service.wait_for_idle(room["id"], timeout=3)
    paused = service.get_room(room["id"])["room"]
    assert paused["status"] == "paused"
    assert len(FakeProcess.instances) == 1

    FakeProcess.block = False
    resumed = service.resume(room["id"])
    assert resumed["ok"] is True
    assert service.wait_for_idle(room["id"], timeout=3)
    # The interrupted answer was never recorded, so recovery must restart
    # that Agent before moving serially to the remaining participant.
    assert [p.command[p.command.index("--agent") + 1] for p in FakeProcess.instances] == ["alpha", "alpha", "beta"]


def test_remove_current_member_and_disband_prevent_future_turns(tmp_path):
    service = make_service(tmp_path)
    FakeProcess.block = True
    room = room_from(service.open_room("评估", ["alpha", "beta"]))
    service.speak(room["id"], "给出建议")

    deadline = time.time() + 3
    while time.time() < deadline:
        current = service.get_room(room["id"])["room"].get("run") or {}
        if current.get("currentAgentId") == "alpha":
            break
        time.sleep(0.01)
    removed = service.remove_participant(room["id"], "alpha")
    assert removed["ok"] is True
    assert FakeProcess.instances[0].terminated is True
    assert service.wait_for_idle(room["id"], timeout=3)

    FakeProcess.block = False
    room_after = service.get_room(room["id"])["room"]
    assert next(item for item in room_after["members"] if item["id"] == "alpha")["state"] == "removed"
    assert service.disband(room["id"])["ok"] is True
    assert service.speak(room["id"], "再次请示")["ok"] is False


def test_conclude_collects_pending_approval_and_archive_is_separate(tmp_path):
    service = make_service(tmp_path)
    room = room_from(service.open_room("发布流程", ["alpha"]))
    service.speak(room["id"], "请给实施建议")
    assert service.wait_for_idle(room["id"], timeout=3)

    concluded = service.conclude(room["id"], [{"title": "由皇上确认后再执行", "detail": "不得自动操作"}])
    assert concluded["ok"] is True
    assert all(item["approvalRequired"] for item in concluded["proposedActions"])
    assert all(item["status"] == "pending_approval" for item in concluded["proposedActions"])
    archived = service.archive(room["id"])
    assert archived["ok"] is True
    assert not (tmp_path / "data" / "yushufang" / "active" / f"{room['id']}.json").exists()
    assert (tmp_path / "data" / "yushufang" / "archive" / f"{room['id']}.json").exists()
    assert service.list_rooms(include_archived=True)["rooms"][0]["status"] == "archived"


def test_approval_is_rejected_before_conclusion_even_for_pending_proposal(tmp_path):
    service = make_service(tmp_path, process_factory=ProposalProcess)
    room = room_from(service.open_room("结案前不得御批", ["alpha"]))
    service.speak(room["roomId"], "请给出实施建议")
    assert service.wait_for_idle(room["roomId"], timeout=3)

    active = service.get_room(room["roomId"])["room"]
    assert active["phase"] == "idle"
    assert active["proposedActions"]
    action_id = active["proposedActions"][0]["id"]

    rejected = service.approve(room["roomId"], action_id, True)
    assert rejected["ok"] is False
    assert "仅议事结束后才能进行御批" in rejected["error"]

    unchanged = service.get_room(room["roomId"])["room"]["proposedActions"][0]
    assert unchanged["status"] == "pending_approval"
    assert "approved" not in unchanged or unchanged["approved"] is False


def test_approval_records_decision_without_execution(tmp_path):
    service = make_service(tmp_path)
    room = room_from(service.open_room("御批只记录决定", ["alpha"]))
    concluded = service.conclude(
        room["roomId"],
        [{"title": "仅记录批准，不执行命令", "detail": "等待皇上另行发起执行"}],
    )
    assert concluded["ok"] is True
    action_id = concluded["proposedActions"][0]["id"]
    process_count = len(FakeProcess.instances)

    approved = service.approve(room["roomId"], action_id, True)
    assert approved["ok"] is True
    assert approved["action"]["id"] == action_id
    assert approved["action"]["approved"] is True
    assert approved["action"]["status"] == "approved"
    assert approved["action"]["executionState"] == "awaiting_explicit_execution"
    assert len(FakeProcess.instances) == process_count

    execution = service.execute_approved(room["roomId"], action_id)
    assert execution["ok"] is False
    assert "不执行拟办事项" in execution["error"]
    assert len(FakeProcess.instances) == process_count

    persisted = service.get_room(room["roomId"])["room"]
    persisted_action = next(item for item in persisted["proposedActions"] if item["id"] == action_id)
    assert persisted["phase"] == "concluded"
    assert persisted_action["status"] == "approved"
    assert persisted_action["executionState"] == "awaiting_explicit_execution"
    assert persisted["run"] is None


def test_server_yushufang_routes_expose_schema_and_gate_approval(tmp_path, monkeypatch):
    service = make_service(tmp_path)
    httpd, thread = _start_http_server(service, monkeypatch)
    try:
        status, roster = _http_json(httpd, "GET", "/api/yushufang/officials")
        assert status == 200
        assert roster["officials"] == roster["agents"]
        assert {item["id"] for item in roster["officials"]} == set(CATALOG)
        status, opened_result = _http_json(
            httpd,
            "POST",
            "/api/yushufang/open",
            {"topic": "HTTP 御书房契约", "officials": ["alpha"]},
        )
        assert status == 200
        opened = opened_result["room"]
        room_id = opened["roomId"]
        assert opened["phase"] == "idle"
        assert [item["id"] for item in opened["participants"]] == ["alpha"]

        status, listed_result = _http_json(httpd, "GET", "/api/yushufang/rooms")
        assert status == 200
        listed_room = next(item for item in listed_result["rooms"] if item["roomId"] == room_id)
        assert listed_room["phase"] == "idle"
        assert [item["id"] for item in listed_room["participants"]] == ["alpha"]

        status, before_conclusion = _http_json(
            httpd,
            "POST",
            "/api/yushufang/approve",
            {"roomId": room_id, "actionId": "proposal-before-conclusion", "approved": True},
        )
        assert status == 400
        assert before_conclusion["ok"] is False
        assert "仅议事结束后才能进行御批" in before_conclusion["error"]

        status, concluded_result = _http_json(
            httpd,
            "POST",
            "/api/yushufang/conclude",
            {"roomId": room_id, "proposedActions": [{"title": "HTTP 只记录批准"}]},
        )
        assert status == 200
        concluded = concluded_result["room"]
        assert concluded["roomId"] == room_id
        assert concluded["phase"] == "concluded"
        action_id = concluded_result["proposedActions"][0]["id"]

        status, approved_result = _http_json(
            httpd,
            "POST",
            "/api/yushufang/approve",
            {"roomId": room_id, "actionId": action_id, "approved": True},
        )
        assert status == 200
        assert approved_result["ok"] is True
        assert approved_result["action"]["status"] == "approved"
        assert approved_result["action"]["executionState"] == "awaiting_explicit_execution"
        assert not FakeProcess.instances

        status, execute_result = _http_json(
            httpd,
            "POST",
            "/api/yushufang/execute-approved",
            {"roomId": room_id, "actionId": action_id},
        )
        assert status == 409
        assert execute_result["ok"] is False
        assert not FakeProcess.instances

        status, fetched_result = _http_json(httpd, "GET", f"/api/yushufang/room/{room_id}")
        assert status == 200
        fetched = fetched_result["room"]
        assert fetched["roomId"] == room_id
        assert fetched["phase"] == "concluded"
        assert fetched["proposedActions"][0]["status"] == "approved"
    finally:
        httpd.shutdown()
        thread.join(timeout=3)
        httpd.server_close()


def test_restart_marks_running_room_interrupted_without_autorun(tmp_path):
    service = make_service(tmp_path)
    room = room_from(service.open_room("恢复测试", ["alpha"]))
    path = tmp_path / "data" / "yushufang" / "active" / f"{room['id']}.json"
    stored = json.loads(path.read_text(encoding="utf-8"))
    stored["status"] = "running"
    stored["run"] = {"id": "run-restart", "status": "running", "participantIds": ["alpha"], "nextIndex": 0}
    path.write_text(json.dumps(stored, ensure_ascii=False), encoding="utf-8")

    recovered = make_service(tmp_path)
    restored = recovered.get_room(room["id"])["room"]
    assert restored["status"] == "interrupted"
    assert restored["run"]["status"] == "interrupted"
    assert not FakeProcess.instances
    assert recovered.resume(room["id"])["ok"] is True
    assert recovered.wait_for_idle(room["id"], timeout=3)


def test_prince_private_room_cannot_merge_and_explicit_joint_invitation_is_separate(tmp_path):
    service = make_service(tmp_path)
    service.agent_catalog = lambda: {**CATALOG, "taizi": {"name": "太子", "role": "储君"}}
    assert not service.open_room("不能混入", ["taizi", "alpha"])["ok"]
    assert not service.open_room("不能混入", ["taizi", "alpha"], audience="prince")["ok"]
    private = room_from(service.open_room("密谈", ["taizi"], audience="prince"))
    assert private["audience"] == "prince"
    assert not service.invite(private["id"], ["alpha"])["ok"]
    service.speak(private["id"], "只在太子密谈中的保密内容")
    assert service.wait_for_idle(private["id"])
    assert service.disband(private["id"])["ok"]
    joint = room_from(service.open_room("另场议事", ["alpha"]))
    assert not service.invite(joint["id"], ["taizi"])["ok"]
    assert service.invite(joint["id"], ["taizi"], join_prince=True)["ok"]
    service.speak(joint["id"], "请共同给出建议")
    assert service.wait_for_idle(joint["id"])
    assert "保密内容" not in FakeProcess.instances[-1].command[-1]
    assert FakeProcess.instances[0].command[FakeProcess.instances[0].command.index("--session-key") + 1] != FakeProcess.instances[-1].command[FakeProcess.instances[-1].command.index("--session-key") + 1]


def test_followups_queue_without_interrupting_or_leaking_into_current_turn(tmp_path):
    service = make_service(tmp_path, process_factory=QuestionAwareProcess)
    FakeProcess.block = True
    room = room_from(service.open_room("排队", ["alpha", "beta"]))
    service.speak(room["id"], "第一轮问题")
    queued = service.speak(room["id"], "第二轮问题")
    assert queued["ok"] and queued["queued"]
    third = service.speak(room["id"], "撤回的第三轮")
    queued_id = third["room"]["pendingMessages"][-1]["id"]
    assert service.remove_queued_message(room["id"], queued_id)["ok"]
    assert not service.remove_queued_message(room["id"], queued_id)["ok"]
    assert "第二轮问题" not in service._build_prompt(service.get_room(room["id"])["room"], "beta")
    FakeProcess.release.set()
    assert service.wait_for_idle(room["id"])
    calls = FakeProcess.instances
    assert [p.command[p.command.index("--agent") + 1] for p in calls] == ["alpha", "beta", "alpha", "beta"]
    assert "第二轮问题" not in calls[1].command[-1]
    assert "第二轮问题" in calls[2].command[-1]
    assert all("撤回的第三轮" not in p.command[-1] for p in calls)
    final = service.get_room(room["id"])["room"]
    assert final["phase"] == "idle"
    assert final["queue"] == final["pendingMessages"] == []


def test_cancel_preserves_followups_and_disband_clears_them(tmp_path):
    service = make_service(tmp_path)
    FakeProcess.block = True
    room = room_from(service.open_room("暂停排队", ["alpha"]))
    service.speak(room["id"], "第一轮")
    service.speak(room["id"], "第二轮")
    assert service.cancel(room["id"])["ok"]
    FakeProcess.release.set()
    assert service.wait_for_idle(room["id"])
    assert service.get_room(room["id"])["room"]["pendingMessages"]
    assert not service.conclude(room["id"])["ok"]
    assert service.disband(room["id"])["ok"]
    assert not service.get_room(room["id"])["room"]["pendingMessages"]


def test_approved_dispatch_requires_confirmation_and_is_idempotent(tmp_path):
    service = make_service(tmp_path)
    calls = []
    def create_task(**payload):
        calls.append(payload)
        return {"ok": True, "taskId": "JJC-TEST-001"}
    service.task_creator = create_task
    room = room_from(service.open_room("批准派发", ["alpha"]))
    concluded = service.conclude(room["id"], [{"title": "审查当前版本发布风险", "detail": "检查启动与模型配置"}])
    action_id = concluded["proposedActions"][0]["id"]
    assert not service.execute_approved(room["id"], action_id, confirmed=True)["ok"]
    assert service.approve(room["id"], action_id, True)["ok"]
    assert calls == []
    assert not service.execute_approved(room["id"], action_id)["ok"]
    assert service.execute_approved(room["id"], action_id, confirmed=True)["ok"]
    assert service.execute_approved(room["id"], action_id, confirmed=True)["ok"]
    assert len(calls) == 1
    assert calls[0]["params"]["yushufangRoomId"] == room["id"]
    assert not service.approve(room["id"], action_id, False)["ok"]
    assert service.get_room(room["id"])["room"]["proposedActions"][0]["taskId"] == "JJC-TEST-001"


def test_dispatch_exception_does_not_repeat_potentially_created_task(tmp_path):
    service = make_service(tmp_path)
    def create_task(**_payload):
        raise RuntimeError("failed after task creation")
    service.task_creator = create_task
    room = room_from(service.open_room("不能重复派发", ["alpha"]))
    action = service.conclude(room["id"], ["确认并审查当前版本发布风险"])["proposedActions"][0]
    service.approve(room["id"], action["id"], True)
    assert not service.execute_approved(room["id"], action["id"], confirmed=True)["ok"]
    assert service.get_room(room["id"])["room"]["proposedActions"][0]["executionState"] == "uncertain"
    assert "勿重复" in service.execute_approved(room["id"], action["id"], confirmed=True)["error"]
