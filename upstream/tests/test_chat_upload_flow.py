"""Temporary-data HTTP coverage for attachments in both conversation engines."""
from __future__ import annotations

import base64
import copy
import json
import pathlib
import sys
import threading
from http.client import HTTPConnection
from http.server import HTTPServer
from types import SimpleNamespace
from urllib.parse import urlencode

import pytest

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "dashboard"))
sys.path.insert(0, str(ROOT / "scripts"))

from chat_attachments import AttachmentStore, MAX_FILE_SIZE
from test_yushufang import FakeProcess, make_service


PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jQp0AAAAASUVORK5CYII="
)


@pytest.fixture
def app(tmp_path, monkeypatch):
    import court_discuss as court

    monkeypatch.setenv("EDICT_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setenv("EDICT_AUTO_DISPATCH", "0")
    monkeypatch.setattr(court, "_sessions", {})
    monkeypatch.setattr(court, "_storage", None)
    monkeypatch.setattr(court, "_attachments", None)
    monkeypatch.setattr(FakeProcess, "instances", [])
    monkeypatch.setattr(FakeProcess, "release", threading.Event())
    monkeypatch.setattr(FakeProcess, "block", False)
    import server

    service = make_service(tmp_path)
    monkeypatch.setattr(server, "DATA", service.data_dir)
    monkeypatch.setattr(server, "CHAT_ATTACHMENTS", AttachmentStore(service.data_dir))
    monkeypatch.setattr(server, "_YUSHUFANG_SERVICE", service)
    monkeypatch.setattr(server, "requires_auth", lambda _path: False)
    monkeypatch.setattr(server, "ALLOWED_ORIGIN", None)
    court.configure_storage(service.data_dir)
    httpd = HTTPServer(("127.0.0.1", 0), server.Handler)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    yield SimpleNamespace(
        service=service, server=server, court=court, httpd=httpd,
        tmp_path=tmp_path, monkeypatch=monkeypatch,
    )
    FakeProcess.release.set()
    for room_id in list(service._runtimes):
        assert service.wait_for_idle(room_id, timeout=5)
    httpd.shutdown()
    httpd.server_close()
    thread.join(timeout=5)
    assert not thread.is_alive()


def request(app, method, path, *, payload=None, body=None, headers=None):
    headers = dict(headers or {})
    if payload is not None:
        body = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json"
    connection = HTTPConnection("127.0.0.1", app.httpd.server_port, timeout=5)
    try:
        connection.request(method, path, body=body, headers=headers)
        response = connection.getresponse()
        raw = response.read()
        content = json.loads(raw) if response.getheader("Content-Type", "").startswith("application/json") else raw
        return response.status, dict(response.getheaders()), content
    finally:
        connection.close()


def open_room(app):
    status, _, result = request(
        app, "POST", "/api/yushufang/open",
        payload={"topic": "Attachment test", "officials": ["alpha", "beta"]},
    )
    assert status == 200 and result["ok"], result
    return result["room"]["id"]


def open_court(app):
    status, _, result = request(
        app, "POST", "/api/court-discuss/start",
        payload={"topic": "Court attachment test", "officials": ["zhongshu", "menxia"]},
    )
    assert status == 200 and result["ok"], result
    return result["session_id"]


def upload(app, scope, name="notes.txt", data=b"HTTP_ATTACHMENT_MARKER"):
    status, _, result = request(
        app, "POST", "/api/chat-attachments?" + urlencode({"scope": scope, "name": name}),
        body=data, headers={"Content-Type": "application/octet-stream"},
    )
    assert status == 200 and result["ok"], result
    assert not ({"text", "filename", "path", "sha256"} & result["attachment"].keys())
    return result["attachment"]


def download(app, scope, attachment_id):
    return request(app, "GET", "/api/chat-attachments?" + urlencode({"scope": scope, "id": attachment_id}))


def speak(app, room_id, attachment_ids, message=""):
    return request(
        app, "POST", "/api/yushufang/speak",
        payload={"roomId": room_id, "message": message, "attachmentIds": attachment_ids},
    )


def remove(app, scope, attachment_id, **kwargs):
    return request(
        app, "POST", "/api/chat-attachments/remove",
        payload={"scope": scope, "id": attachment_id}, **kwargs,
    )


def prompt(process):
    return process.command[process.command.index("--message") + 1]


def court_reply(*_args, **_kwargs):
    return json.dumps({
        "messages": [
            {"official_id": "zhongshu", "name": "Planner", "content": "Read the attached evidence."},
            {"official_id": "menxia", "name": "Reviewer", "content": "Reviewed the evidence."},
        ],
        "scene_note": None,
    })


def test_http_attachment_only_speak_stages_files_and_survives_archive_restart(app):
    room_id = open_room(app)
    item = upload(app, room_id)
    status, _, result = speak(app, room_id, [item["id"]])
    assert status == 200 and result["accepted"], result
    assert app.service.wait_for_idle(room_id)
    assert len(FakeProcess.instances) == 2
    for process in FakeProcess.instances:
        assert "HTTP_ATTACHMENT_MARKER" in prompt(process)
        assert "BEGIN UNTRUSTED ATTACHMENT REFERENCES" in prompt(process)
        agent = process.command[process.command.index("--agent") + 1]
        relative = pathlib.Path("attachments") / room_id / item["id"] / "source.txt"
        workspace = app.service.root_dir / "runtime" / room_id / agent / "workspace"
        assert (workspace / relative).read_bytes() == b"HTTP_ATTACHMENT_MARKER"
        assert str(relative) in prompt(process)
    status, _, room = request(app, "GET", f"/api/yushufang/room/{room_id}")
    assert status == 200
    emperor = [message for message in room["room"]["messages"] if message["kind"] == "emperor"]
    assert len(emperor) == 1 and emperor[0]["attachments"] == [item]
    assert remove(app, room_id, item["id"])[0] == 400
    assert request(app, "POST", "/api/yushufang/conclude", payload={"roomId": room_id})[2]["ok"]
    assert app.service.archive(room_id)["ok"]
    recovered = make_service(app.tmp_path)
    app.monkeypatch.setattr(app.server, "_YUSHUFANG_SERVICE", recovered)
    app.monkeypatch.setattr(app.server, "CHAT_ATTACHMENTS", AttachmentStore(recovered.data_dir))
    status, headers, raw = download(app, room_id, item["id"])
    assert status == 200 and raw == b"HTTP_ATTACHMENT_MARKER"
    assert headers["X-Content-Type-Options"] == "nosniff"
    assert headers["Cache-Control"] == "private, no-store"
    assert headers["Content-Disposition"].startswith("attachment;")
    assert recovered.get_room(room_id)["room"]["phase"] == "archived"
    assert request(
        app, "POST", "/api/chat-attachments?" + urlencode({"scope": room_id, "name": "new.txt"}),
        body=b"cannot add to archive",
    )[0] == 400


def test_cross_room_ids_and_draft_deletion(app):
    first = open_room(app)
    item = upload(app, first)
    assert app.service.conclude(first)["ok"]
    assert app.service.archive(first)["ok"]
    second = open_room(app)
    status, _, result = speak(app, second, [item["id"]])
    assert status == 400 and not result["ok"]
    assert not FakeProcess.instances
    assert download(app, second, item["id"])[0] == 404
    assert remove(app, second, item["id"])[0] == 400
    assert download(app, first, item["id"])[0] == 200
    second_item = upload(app, second, name="draft.txt")
    assert remove(app, second, second_item["id"])[2] == {"ok": True}
    assert download(app, second, second_item["id"])[0] == 404


def test_queued_attachment_is_not_visible_to_first_turn(app):
    room_id = open_room(app)
    item = upload(app, room_id, data=b"ONLY_SECOND_TURN_MARKER")
    FakeProcess.block = True
    status, _, accepted = speak(app, room_id, [], message="First question")
    assert status == 200 and accepted["ok"]
    status, _, queued = speak(app, room_id, [item["id"]], message="Second question")
    assert status == 200 and queued["queued"]
    assert queued["room"]["pendingMessages"][0]["attachments"] == [item]
    assert remove(app, room_id, item["id"])[0] == 400
    first_prompt = app.service._build_prompt(app.service.get_room(room_id)["room"], "beta")
    assert "ONLY_SECOND_TURN_MARKER" not in first_prompt
    FakeProcess.release.set()
    assert app.service.wait_for_idle(room_id)
    assert len(FakeProcess.instances) == 4
    assert all("ONLY_SECOND_TURN_MARKER" not in prompt(process) for process in FakeProcess.instances[:2])
    assert all("ONLY_SECOND_TURN_MARKER" in prompt(process) for process in FakeProcess.instances[2:])
    room = app.service.get_room(room_id)["room"]
    assert not room["pendingMessages"]
    assert len([message for message in room["messages"] if message["kind"] == "emperor"]) == 2


@pytest.mark.parametrize("length,expected", [("-1", 400), ("invalid", 400), ("0", 413), (str(MAX_FILE_SIZE + 1), 413)])
def test_upload_rejects_invalid_or_oversized_content_lengths_without_reading_body(app, length, expected):
    room_id = open_room(app)
    status, _, result = request(
        app, "POST", "/api/chat-attachments?" + urlencode({"scope": room_id, "name": "notes.txt"}),
        body=b"", headers={"Content-Length": length, "Content-Type": "application/octet-stream"},
    )
    assert status == expected and not result["ok"]
    assert not list((app.service.data_dir / "chat-attachments").glob("*/*/metadata.json"))


def test_upload_and_remove_reject_unsafe_origin(app):
    room_id = open_room(app)
    status, _, result = request(
        app, "POST", "/api/chat-attachments?" + urlencode({"scope": room_id, "name": "notes.txt"}),
        body=b"untrusted", headers={"Origin": "https://attacker.invalid"},
    )
    assert status == 403 and not result["ok"]
    item = upload(app, room_id)
    assert remove(app, room_id, item["id"], headers={"Origin": "https://attacker.invalid"})[0] == 403
    assert download(app, room_id, item["id"])[0] == 200


def test_court_text_and_image_payloads_persist_and_cannot_delete_sent_files(app):
    session_id = open_court(app)
    scope = f"court-{session_id}"
    document = upload(app, scope, "court.md", b"COURT_DOCUMENT_MARKER")
    image = upload(app, scope, "photo.png", PNG)
    calls = []

    def complete(system_prompt, user_prompt, max_tokens=1024, images=None):
        calls.append((system_prompt, user_prompt, images))
        return court_reply()

    app.monkeypatch.setattr(app.court, "_llm_complete", complete)
    status, _, result = request(
        app, "POST", "/api/court-discuss/advance",
        payload={"sessionId": session_id, "attachmentIds": [document["id"], image["id"]]},
    )
    assert status == 200 and result["ok"] and not result["simulated"], result
    assert len(calls) == 1
    assert "COURT_DOCUMENT_MARKER" in calls[0][1]
    assert "BEGIN UNTRUSTED ATTACHMENT REFERENCES" in calls[0][1]
    assert calls[0][2] == [("image/png", base64.b64encode(PNG).decode("ascii"))]
    emperor = [message for message in result["messages"] if message["type"] == "emperor"]
    assert len(emperor) == 1 and emperor[0]["attachments"] == [document, image]
    assert remove(app, scope, document["id"])[0] == 400
    draft = upload(app, scope, "draft.txt", b"draft")
    assert remove(app, scope, draft["id"])[2]["ok"]
    expected = copy.deepcopy(app.court.get_session(session_id))
    app.court.configure_storage(app.service.data_dir)
    assert app.court.get_session(session_id) == expected
    assert download(app, scope, image["id"])[2] == PNG
    other = open_court(app)
    status, _, denied = request(
        app, "POST", "/api/court-discuss/advance",
        payload={"sessionId": other, "attachmentIds": [document["id"]]},
    )
    assert status == 400 and not denied["ok"]
    assert len(calls) == 1


@pytest.mark.parametrize("failed_response", [None, "not valid JSON", '{"error": "provider rejected input"}'])
def test_court_failure_preserves_draft_without_simulation_or_duplicate_messages(app, failed_response):
    session_id = open_court(app)
    scope = f"court-{session_id}"
    item = upload(app, scope)
    before = copy.deepcopy(app.court.get_session(session_id))
    app.monkeypatch.setattr(app.court, "_llm_complete", lambda *_args, **_kwargs: failed_response)

    def no_simulation(*_args, **_kwargs):
        pytest.fail("Attachment failures must not call simulated discussion")

    app.monkeypatch.setattr(app.court, "_simulated_discuss", no_simulation)
    payload = {"sessionId": session_id, "userMessage": "Analyze my file", "attachmentIds": [item["id"]]}
    for _ in range(2):
        status, _, failed = request(app, "POST", "/api/court-discuss/advance", payload=payload)
        assert status == 400 and failed["ok"] is False, failed
        assert app.court.get_session(session_id) == before
        assert download(app, scope, item["id"])[0] == 200
    app.court.configure_storage(app.service.data_dir)
    assert app.court.get_session(session_id) == before
    app.monkeypatch.setattr(app.court, "_llm_complete", court_reply)
    status, _, succeeded = request(app, "POST", "/api/court-discuss/advance", payload=payload)
    assert status == 200 and succeeded["ok"] and not succeeded["simulated"]
    assert succeeded["round"] == 1
    assert len([message for message in succeeded["messages"] if message["type"] == "emperor"]) == 1
