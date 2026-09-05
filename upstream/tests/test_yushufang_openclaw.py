"""Opt-in black-box policy test against installed OpenClaw and a local mock model."""
import json
import os
import pathlib
import shutil
import subprocess
import sys
import threading
import base64
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "dashboard"))
sys.path.insert(0, str(ROOT / "scripts"))
from yushufang_runtime import prepare_runtime, read_tool_activity
from chat_attachments import AttachmentStore


@pytest.mark.skipif(os.environ.get("EDICT_TEST_OPENCLAW") != "1", reason="Set EDICT_TEST_OPENCLAW=1 for local OpenClaw integration")
def test_real_openclaw_blocks_commands_and_outside_workspace_reads(tmp_path):
    binary = shutil.which("openclaw")
    assert binary, "Install OpenClaw to run this opt-in test"
    requests = []
    forbidden = tmp_path / "forbidden-write"
    outside = tmp_path / "other-room.txt"
    outside.write_text("OTHER_ROOM_SENTINEL")
    store = AttachmentStore(tmp_path / "uploads")
    scope = "ysf-0123456789ab"
    image = store.upload(scope, "sample.png", base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII="))
    document = store.upload(scope, "sample.txt", b"AUTHORIZED_ATTACHMENT_SENTINEL")
    paths = store.stage(scope, [image, document], tmp_path / "room" / "alpha" / "workspace")

    class MockModel(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def do_POST(self):
            payload = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            requests.append(payload)
            index = len(requests)
            if index == 1:
                delta = {"role": "assistant", "tool_calls": [{"index": 0, "id": "attempt-exec", "type": "function",
                    "function": {"name": "exec", "arguments": json.dumps({"command": f"touch {forbidden}"})}}]}
                finish = "tool_calls"
            elif index == 2:
                delta = {"role": "assistant", "tool_calls": [{"index": 0, "id": "attempt-read", "type": "function",
                    "function": {"name": "read", "arguments": json.dumps({"path": str(outside)})}}]}
                finish = "tool_calls"
            elif index in (3, 4):
                delta = {"role": "assistant", "tool_calls": [{"index": 0, "id": f"read-attachment-{index}", "type": "function",
                    "function": {"name": "read", "arguments": json.dumps({"path": paths[index - 3]})}}]}
                finish = "tool_calls"
            else:
                delta = {"role": "assistant", "content": "方案：只做调研。\n待御批：无"}
                finish = "stop"
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.end_headers()
            for chunk in ({"choices": [{"index": 0, "delta": delta, "finish_reason": None}]},
                          {"choices": [{"index": 0, "delta": {}, "finish_reason": finish}]}):
                self.wfile.write(("data: " + json.dumps({"id": f"mock-{index}", "object": "chat.completion.chunk", "model": "model", **chunk}) + "\n\n").encode())
            self.wfile.write(b"data: [DONE]\n\n")

    httpd = ThreadingHTTPServer(("127.0.0.1", 0), MockModel)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    source = tmp_path / "source.json"
    source.write_text(json.dumps({
        "agents": {"defaults": {"model": "fixture/model"}, "list": [{"id": "alpha"}]},
        "models": {"providers": {"fixture": {
            "baseUrl": f"http://127.0.0.1:{httpd.server_port}/v1", "api": "openai-completions",
            "apiKey": "fixture-only", "models": [{"id": "model", "name": "Model", "reasoning": True, "input": ["text", "image"], "contextWindow": 64000, "maxTokens": 2000,
                "compat": {"supportedReasoningEfforts": ["low", "medium", "high", "max"]}}],
        }}},
        "tools": {"web": {"search": {"enabled": False}, "fetch": {"enabled": False}}},
    }))
    try:
        _, env, _ = prepare_runtime(tmp_path / "room" / "alpha", "alpha", source)
        validation = subprocess.run([binary, "config", "validate", "--json"], env=env, capture_output=True, text=True, timeout=60)
        assert validation.returncode == 0, validation.stderr + validation.stdout
        result = subprocess.run(
            [binary, "agent", "--local", "--agent", "alpha", "--session-key", "agent:alpha:yushufang:test",
             "--thinking", "low", "--json", "--timeout", "90", "--message", "评估方案，只调研，不执行任何变更。"],
            env=env, capture_output=True, text=True, timeout=120,
        )
        assert result.returncode == 0, result.stderr[-5000:] + result.stdout[-5000:]
        assert len(requests) >= 5, result.stdout
        exposed = {entry["function"]["name"] for entry in requests[0].get("tools", [])}
        assert "read" in exposed and "exec" not in exposed and "write" not in exposed
        assert not forbidden.exists()
        assert "OTHER_ROOM_SENTINEL" not in json.dumps(requests)
        assert "AUTHORIZED_ATTACHMENT_SENTINEL" in json.dumps(requests)
        assert "data:image/png;base64," in json.dumps(requests)
        assert "方案" in result.stdout
        activity = read_tool_activity(tmp_path / "room")
        assert {entry["tool"] for entry in activity} >= {"exec", "read"}
        assert any(entry["tool"] == "exec" and entry["state"] == "error" for entry in activity)
        assert any(entry["tool"] == "read" and entry["state"] == "error" for entry in activity)
        assert any(entry["tool"] == "read" and entry["state"] == "completed" for entry in activity)
        assert "OTHER_ROOM_SENTINEL" not in json.dumps(activity)
    finally:
        httpd.shutdown()
        httpd.server_close()
        thread.join(timeout=3)
