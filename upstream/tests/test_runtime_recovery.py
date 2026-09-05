"""Regressions for GUI runtime resolution and recoverable room failures."""
import json
import os
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
from openclaw_runtime import resolve_openclaw_bin, runtime_environment, runtime_status
from test_yushufang import FakeProcess, QuestionAwareProcess, make_service, room_from
from yushufang import _safe_error


def test_actual_cli_error_is_not_hidden_by_successful_local_secret_fallback():
    value = "[secrets] gateway unavailable; resolved command secrets locally.\n" + "warning " * 150
    value += '\nError: Thinking level "medium" is not supported for custom/model. Use one of: off.'
    assert _safe_error(value).startswith('Error: Thinking level "medium"')
    assert "gateway" not in _safe_error(value)
    assert "secret-value" not in _safe_error("Error: token=secret-value")


def test_cli_connection_error_prefers_terminal_failover_line():
    value = (
        "[provider-transport-fetch] error message=fetch failed\n"
        "[diagnostic] lane task error=FailoverError: LLM request failed: network connection error.\n"
        "FailoverError: LLM request failed: network connection error."
    )
    assert _safe_error(value) == "FailoverError: LLM request failed: network connection error."


def test_cli_json_error_message_is_extracted_without_dumping_payload():
    value = json.dumps({
        "status": "error",
        "result": {"errorMessage": "供应商拒绝请求", "rawError": "apiKey=secret-value"},
        "debug": {"request": "Bearer secret-value"},
    })
    result = _safe_error(value)
    assert result == "供应商拒绝请求"
    assert "secret-value" not in result


def test_desktop_snapshot_hot_reload_and_missing_node(tmp_path, monkeypatch):
    snapshot = tmp_path / "runtime.json"
    binary = tmp_path / "openclaw with spaces"
    node = tmp_path / "node"
    for executable in [binary, node]:
        executable.write_text("#!/bin/sh\nexit 0\n")
        executable.chmod(0o700)
    monkeypatch.setenv("EDICT_RUNTIME_DEPENDENCIES", str(snapshot))
    monkeypatch.setenv("PATH", "/usr/bin:/bin")
    snapshot.write_text(json.dumps({"openclawPath": str(binary), "nodePath": str(node), "path": str(tmp_path)}))
    assert resolve_openclaw_bin() == str(binary)
    assert runtime_status()["ok"]
    assert runtime_environment({"PRIVATE_PROVIDER_TOKEN": "fixture"})["PRIVATE_PROVIDER_TOKEN"] == "fixture"
    snapshot.write_text(json.dumps({"openclawPath": str(tmp_path / "missing"), "nodePath": str(node), "path": str(tmp_path)}))
    assert not runtime_status()["ok"]
    assert resolve_openclaw_bin() != str(binary)
    node.unlink()
    assert "Node.js" in " ".join(runtime_status()["errors"])


def test_missing_dependency_rejects_message_without_changing_history(tmp_path):
    service = make_service(tmp_path)
    room = room_from(service.open_room("缺失依赖", ["alpha"]))
    service.check_runtime = lambda: {"ok": False, "errors": ["OpenClaw 未找到"]}
    before = service.get_room(room["id"])["room"]["messages"]
    assert not service.speak(room["id"], "保留草稿")["ok"]
    assert service.get_room(room["id"])["room"]["messages"] == before
    assert FakeProcess.instances == []


def test_partial_failure_retry_preserves_success_and_queue(tmp_path):
    class OnceFailure(QuestionAwareProcess):
        failed = False

        def communicate(self, timeout=None):
            super().communicate(timeout)
            if self.command[self.command.index("--agent") + 1] == "beta" and not type(self).failed:
                type(self).failed = True
                self.returncode = 1
                return "", "供应商暂时不可用"
            return self.stdout, self.stderr

    service = make_service(tmp_path, process_factory=OnceFailure)
    room = room_from(service.open_room("部分失败", ["alpha", "beta"]))
    FakeProcess.block = True
    assert service.speak(room["id"], "第一轮")["ok"]
    assert service.speak(room["id"], "第二轮")["queued"]
    FakeProcess.release.set()
    assert service.wait_for_idle(room["id"])
    failed = service.get_room(room["id"])["room"]
    assert failed["phase"] == "partial_failed"
    assert len(failed["pendingMessages"]) == 1
    assert len([m for m in failed["messages"] if m["kind"] == "agent"]) == 1
    assert not service.speak(room["id"], "不要覆盖失败轮次")["ok"]
    assert service.resume(room["id"])["ok"]
    assert service.wait_for_idle(room["id"])
    recovered = service.get_room(room["id"])["room"]
    assert recovered["phase"] == "idle"
    assert recovered["pendingMessages"] == []
    calls = [p.command[p.command.index("--agent") + 1] for p in FakeProcess.instances]
    assert calls == ["alpha", "beta", "beta", "alpha", "beta"]


def test_shared_spawn_failure_stops_once_and_recovers_unattempted_agents(tmp_path):
    def missing(*_args, **_kwargs):
        raise FileNotFoundError("openclaw")
    service = make_service(tmp_path, process_factory=missing)
    room = room_from(service.open_room("运行程序丢失", ["alpha", "beta"]))
    assert service.speak(room["id"], "第一轮")["ok"]
    assert service.wait_for_idle(room["id"])
    failed = service.get_room(room["id"])["room"]
    assert failed["phase"] == "failed"
    assert len([m for m in failed["messages"] if m["kind"] == "error"]) == 1
    assert not any("本轮议事结束" in m["content"] for m in failed["messages"])
    service.process_factory = FakeProcess
    assert service.resume(room["id"])["ok"]
    assert service.wait_for_idle(room["id"])
    assert [p.command[p.command.index("--agent") + 1] for p in FakeProcess.instances] == ["alpha", "beta"]


def test_legacy_completed_failure_can_retry_after_reload(tmp_path):
    class Failure(FakeProcess):
        def communicate(self, timeout=None):
            self.returncode = 1
            return "", "temporary"
    service = make_service(tmp_path, process_factory=Failure)
    room = room_from(service.open_room("旧失败记录", ["alpha"]))
    service.speak(room["id"], "不要丢失")
    assert service.wait_for_idle(room["id"])
    path = service._active_path(room["id"])
    stored = json.loads(path.read_text())
    stored["status"] = "active"
    stored["run"]["status"] = "completed"
    stored["run"].pop("successfulAgentIds", None)
    path.write_text(json.dumps(stored))
    service = make_service(tmp_path)
    assert service.get_room(room["id"])["room"]["phase"] == "failed"
    assert service.resume(room["id"])["ok"]
    assert service.wait_for_idle(room["id"])
    assert service.get_room(room["id"])["room"]["phase"] == "idle"
