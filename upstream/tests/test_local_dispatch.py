"""Regression for the real bundled runtime's subagent completion transport."""
import json
import os
import pathlib
import subprocess
import sys
import threading
import signal
import sqlite3
from urllib.request import urlopen
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT / "scripts"), str(ROOT / "dashboard")]
from local_dispatch import configure_transport, pending_children
from yushufang_runtime import prepare_local_dispatch_runtime


def test_transport_is_private_and_does_not_enable_external_channels(tmp_path):
    path = tmp_path / "openclaw.json"
    path.write_text(json.dumps({"gateway": {"mode": "remote", "remote": {"url": "wss://unused.invalid"}},
                               "channels": {"discord": {"token": "private"}},
                               "agents": {"list": [{"id": "taizi", "workspace": "/project"}]}}))
    env, port, state = configure_transport(path, {"EDICT_DISPATCH_STATE_DIR": str(tmp_path / "state"),
                                                "OPENCLAW_GATEWAY_PASSWORD": "old"})
    cfg = json.loads(path.read_text())
    assert cfg["gateway"]["bind"] == "loopback"
    assert cfg["gateway"]["auth"]["mode"] == "token"
    assert cfg["gateway"]["port"] == port
    assert "remote" not in cfg["gateway"]
    assert cfg["channels"] == {}
    assert cfg["cron"]["enabled"] is False
    assert cfg["agents"]["list"][0]["workspace"] == "/project"
    assert env["OPENCLAW_SKIP_CHANNELS"] == "1"
    assert "OPENCLAW_GATEWAY_PASSWORD" not in env
    assert env["OPENCLAW_GATEWAY_TOKEN"] not in path.read_text()
    assert env["OPENCLAW_STATE_DIR"] == str(state)


def test_completion_waits_for_announce_not_only_child_exit(tmp_path):
    (tmp_path / "subagents").mkdir()
    path = tmp_path / "subagents" / "runs.json"
    path.write_text(json.dumps({"runs": {"one": {"endedAt": 123}}}))
    assert pending_children(tmp_path)
    path.write_text(json.dumps({"runs": {"one": {"endedAt": 123, "cleanupCompletedAt": 124}}}))
    assert not pending_children(tmp_path)


def test_completion_reads_current_sqlite_registry(tmp_path):
    (tmp_path / "state").mkdir()
    with sqlite3.connect(tmp_path / "state" / "openclaw.sqlite") as db:
        db.execute("CREATE TABLE subagent_runs(child_session_key TEXT, cleanup_completed_at INTEGER)")
        db.execute("INSERT INTO subagent_runs VALUES ('agent:libu:subagent:fixture', NULL)")
    assert pending_children(tmp_path)
    with sqlite3.connect(tmp_path / "state" / "openclaw.sqlite") as db:
        db.execute("UPDATE subagent_runs SET cleanup_completed_at=123")
    assert not pending_children(tmp_path)


def test_monitor_reads_task_scoped_transcripts_without_trajectory_duplicates(tmp_path, monkeypatch):
    import server
    home = tmp_path / "canonical"
    data = tmp_path / "data"
    sessions = home / "agents" / "taizi" / "sessions"
    sessions.mkdir(parents=True)
    transcript = data / "dispatch-sessions" / "attempt" / "state" / "agents" / "taizi" / "sessions" / "fixture.jsonl"
    transcript.parent.mkdir(parents=True)
    transcript.write_text('{}\n')
    (sessions / "ignored.trajectory.jsonl").write_text('{}\n')
    (sessions / "sessions.json").write_text(json.dumps({"agent:taizi:edict:fixture": {"sessionFile": str(transcript)}}))
    monkeypatch.setattr(server, "OCLAW_HOME", home)
    monkeypatch.setattr(server, "DATA", data)
    assert server._agent_session_files("taizi") == [transcript]


@pytest.mark.skipif(not os.environ.get("EDICT_TEST_OPENCLAW_BIN"), reason="opt-in bundled-runtime integration")
@pytest.mark.parametrize("cancel_run", [False, True])
def test_native_subagent_spawn_yield_and_announce(tmp_path, cancel_run):
    requests = []
    parent_received = threading.Event()
    child_started = threading.Event()
    release_child = threading.Event()
    reviewed = set()
    chain = {"taizi": "zhongshu", "zhongshu": "shangshu", "shangshu": "libu"}

    class Provider(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def do_POST(self):
            payload = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            requests.append(payload)
            messages = payload["messages"]
            system = json.dumps([m for m in messages if m["role"] == "system"])
            text = json.dumps([m for m in messages if m["role"] == "user"])
            role = next(a for a in [*chain, "libu"] if f"ROLE_FIXTURE_{a.upper()}" in system)
            tools = {t["function"]["name"] for t in payload.get("tools", [])}
            assert self.headers.get("Authorization") == ("Bearer child-fixture" if role == "libu" else "Bearer fixture-only")
            if role == "libu":
                child_started.set()
                if cancel_run:
                    release_child.wait(20)
                delta, finish = {"role": "assistant", "content": "CHILD_RESULT_CONFIRMED"}, "stop"
            elif "CHILD_RESULT_CONFIRMED" in text:
                reviewed.add(role)
                if role == "taizi":
                    parent_received.set()
                delta, finish = {"role": "assistant", "content": "CHILD_RESULT_CONFIRMED reviewed by " + role}, "stop"
            else:
                spawned = any(m.get("role") == "tool" for m in messages)
                name = "sessions_yield" if spawned else "sessions_spawn"
                assert name in tools, (name, tools)
                args = {} if spawned else {"agentId": chain[role], "task": "Perform your assigned step and report the result.", "mode": "run"}
                delta = {"role": "assistant", "tool_calls": [{"index": 0, "id": "fixture-yield" if spawned else "fixture-spawn",
                           "type": "function", "function": {"name": name, "arguments": json.dumps(args)}}]}
                finish = "tool_calls"
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.end_headers()
            for change, end in [(delta, None), ({}, finish)]:
                self.wfile.write(("data: " + json.dumps({"id": "fixture", "object": "chat.completion.chunk", "model": "fixture",
                    "choices": [{"index": 0, "delta": change, "finish_reason": end}]}) + "\n\n").encode())
            self.wfile.write(b"data: [DONE]\n\n")

    provider = ThreadingHTTPServer(("127.0.0.1", 0), Provider)
    threading.Thread(target=provider.serve_forever, daemon=True).start()
    agents = []
    for agent_id in [*chain, "libu"]:
        workspace = tmp_path / agent_id
        workspace.mkdir()
        (workspace / "AGENTS.md").write_text("ROLE_FIXTURE_" + agent_id.upper())
        agents.append({"id": agent_id, "workspace": str(workspace), "model": "child/fixture" if agent_id == "libu" else "fixture/fixture",
                       "subagents": {"allowAgents": [chain[agent_id]] if agent_id in chain else []}})
    source = tmp_path / "source.json"
    provider_config = {"api": "openai-completions", "apiKey": "fixture-only",
        "baseUrl": f"http://127.0.0.1:{provider.server_port}/v1",
        "models": [{"id": "fixture", "name": "Fixture", "contextWindow": 128000, "maxTokens": 2048}]}
    source.write_text(json.dumps({"agents": {"defaults": {"model": "fixture/fixture", "skipBootstrap": True}, "list": agents},
        "tools": {"profile": "full"},
        "models": {"providers": {"fixture": provider_config, "child": {**provider_config, "apiKey": "child-fixture"}}}}))
    binary = os.environ["EDICT_TEST_OPENCLAW_BIN"]
    _, env, _ = prepare_local_dispatch_runtime(tmp_path / "runtime", "taizi", source, managed_gateway=True)
    env["EDICT_DISPATCH_STATE_DIR"] = str(tmp_path / "state")
    process = subprocess.Popen([os.environ.get("EDICT_TEST_PYTHON_BIN", sys.executable),
        os.environ.get("EDICT_TEST_DISPATCH_SCRIPT", str(ROOT / "scripts" / "local_dispatch.py")), binary,
        "--agent", "taizi", "--session-key", "agent:taizi:edict:fixture", "-m", "Delegate the work then review the result.",
        "--timeout", "75", "--json"], env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, start_new_session=True)
    try:
        if cancel_run:
            assert child_started.wait(60), "native child did not start"
            os.killpg(process.pid, signal.SIGTERM)
            stdout, stderr = process.communicate(timeout=12)
            assert process.returncode != 0
            assert not parent_received.is_set()
        else:
            stdout, stderr = process.communicate(timeout=110)
            assert process.returncode == 0, stderr
            assert parent_received.is_set(), (len(requests), stdout, stderr)
            assert reviewed == set(chain)
            assert not pending_children(tmp_path / "state")
        config = json.loads((tmp_path / "runtime" / "openclaw.json").read_text())
        with pytest.raises(OSError):
            urlopen(f'http://127.0.0.1:{config["gateway"]["port"]}/healthz', timeout=1)
    finally:
        release_child.set()
        if process.poll() is None:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait(timeout=5)
        provider.shutdown()
