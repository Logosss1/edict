"""Isolated UI test server: real dashboard routes, deterministic fake Agent replies."""
import json
import os
import pathlib
import sys
import tempfile
import threading
from http.server import ThreadingHTTPServer

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "dashboard"))
sys.path.insert(0, str(ROOT / "scripts"))
storage = tempfile.TemporaryDirectory(prefix="innercourt-ui-")
os.environ["EDICT_DATA_DIR"] = storage.name
os.environ["EDICT_OPENCLAW_HOME"] = str(pathlib.Path(storage.name) / "openclaw")
os.environ["EDICT_AUTO_DISPATCH"] = "0"
os.environ["EDICT_SKIP_GATEWAY_RESTART"] = "1"
import server
import court_discuss
from yushufang import YushufangService

CATALOG = {
    "taizi": {"name": "太子", "role": "储君", "model": "fixture/model"},
    "zhongshu": {"name": "中书令", "role": "中书省", "model": "fixture/model"},
    "menxia": {"name": "侍中", "role": "门下省", "model": "fixture/model"},
    "gongbu": {"name": "工部尚书", "role": "工部", "model": "fixture/model"},
    "hubu": {"name": "户部尚书", "role": "户部", "model": "fixture/model"},
    "bingbu": {"name": "兵部尚书", "role": "兵部", "model": "fixture/model"},
}
server.OCLAW_HOME.mkdir(parents=True, exist_ok=True)
(server.OCLAW_HOME / "openclaw.json").write_text(json.dumps({
    "models": {"providers": {"fixture": {"api": "openai-completions", "baseUrl": "http://127.0.0.1:1/v1",
        "models": [{"id": "model", "reasoning": True,
                    "compat": {"supportedReasoningEfforts": ["low", "medium", "high", "max"]}}]}}},
    "agents": {"defaults": {"model": "fixture/model"}, "list": [{"id": key} for key in CATALOG]},
}), encoding="utf-8")


def court_reply(_system, prompt, **_options):
    if "UI_ATTACHMENT_FAIL" in prompt:
        return None
    return json.dumps({"messages": [{"official_id": "zhongshu", "name": "中书令",
        "content": "已收到本场附件，按资料中的预算和验收要求提出方案。"}]})


court_discuss._llm_complete = court_reply


class MockProcess:
    failures = set()

    def __init__(self, command, **_options):
        self.returncode = None
        self.event = threading.Event()
        self.agent = command[command.index("--agent") + 1]
        self.message = command[command.index("--message") + 1]
        self.session = command[command.index("--session-key") + 1]
        self.question = next(
            (line.split("：", 1)[1] for line in self.message.splitlines()
             if line.startswith("本轮皇上最新圣谕：")),
            "当前圣谕",
        )

    def communicate(self, timeout=None):
        self.event.wait(min(timeout or 1.5, 1.5))
        if "UI_FAIL_ONCE" in self.message and self.agent == "menxia" and self.session not in type(self).failures:
            type(self).failures.add(self.session)
            self.returncode = 1
            return "", "供应商暂时不可用，请稍后重试"
        self.returncode = 0
        return json.dumps({"result": {"meta": {"agentMeta": {"provider": "fixture", "model": "model"},
            "finalAssistantVisibleText": f"方案：由{self.agent}审查本轮圣谕「{self.question}」的发布风险。\n风险/验收：检查模型配置与启动。\n待御批：\n- 审查模型配置并验证发布风险"}}}), ""

    def poll(self):
        return self.returncode

    def terminate(self):
        self.event.set()


server._YUSHUFANG_SERVICE = YushufangService(
    storage.name, agent_catalog=lambda: CATALOG, process_factory=MockProcess,
    runtime_preparer=lambda *_args: ({}, {}, {"model": "fixture/model", "levels": ["default", "low", "medium", "high", "max"], "skills": [], "mcpServers": [], "webSearch": False, "webFetch": False}),
    task_creator=server.handle_create_task,
)


class Handler(server.Handler):
    def do_GET(self):
        if self.path.startswith("/settings/"):
            name = pathlib.Path(self.path).name
            if name in {"index.html", "settings.js", "settings.css"}:
                return self.send_file(ROOT.parent / "desktop" / "settings" / name, server._MIME_TYPES[pathlib.Path(name).suffix])
        super().do_GET()


httpd = ThreadingHTTPServer(("127.0.0.1", int(os.environ.get("EDICT_UI_TEST_PORT", "43819"))), Handler)
try:
    httpd.serve_forever()
finally:
    httpd.server_close()
    storage.cleanup()
