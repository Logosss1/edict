"""Workspace-scoped inspection and test helpers for the desktop workbench.

The module deliberately accepts only a selected project directory and only
offers detected test commands.  It does not expose an arbitrary shell API to
the dashboard browser.  Full-access mode means the Agent/runtime may work
inside this boundary; OS credentials and paths outside it remain outside the
application's automatic scope.
"""

from __future__ import annotations

import json
import os
import pathlib
import shutil
import signal
import subprocess
import sys
import threading
import time
import uuid
from typing import Any

from file_lock import atomic_json_read, atomic_json_update


MAX_OUTPUT = 16_000
_RUN_LOCK = threading.RLock()
_RUN_PROCESSES: dict[str, subprocess.Popen[str]] = {}


def resolve_project(path: str | pathlib.Path) -> pathlib.Path:
    value = pathlib.Path(str(path or "")).expanduser().resolve()
    if not value.is_dir():
        raise ValueError("项目目录不存在或不是文件夹")
    if not all(os.access(value, mode) for mode in (os.R_OK, os.W_OK, os.X_OK)):
        raise PermissionError("项目目录缺少读、写或进入权限")
    return value


def _read_package_scripts(project: pathlib.Path) -> dict[str, Any]:
    try:
        data = json.loads((project / "package.json").read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def detect_test_commands(project: str | pathlib.Path) -> list[dict[str, Any]]:
    root = resolve_project(project)
    commands: list[dict[str, Any]] = []
    package = _read_package_scripts(root)
    scripts = package.get("scripts") if isinstance(package.get("scripts"), dict) else {}
    if scripts.get("test"):
        commands.append({"id": "npm-test", "label": "npm test", "argv": ["npm", "test"]})
    if (root / "pyproject.toml").exists() or (root / "pytest.ini").exists() or (root / "tests").is_dir():
        commands.append({"id": "pytest", "label": "pytest", "argv": [sys.executable, "-m", "pytest", "-q"]})
    if (root / "Makefile").exists():
        try:
            makefile = (root / "Makefile").read_text(encoding="utf-8", errors="ignore")
            if "test:" in makefile:
                commands.append({"id": "make-test", "label": "make test", "argv": ["make", "test"]})
        except OSError:
            pass
    if not commands:
        commands.append({"id": "no-detected-test", "label": "未检测到测试命令", "argv": []})
    return commands[:6]


def _safe_relative(path: pathlib.Path, root: pathlib.Path) -> str:
    try:
        return str(path.resolve().relative_to(root.resolve()))
    except ValueError:
        return path.name


def list_artifacts(project: str | pathlib.Path, task_id: str) -> list[dict[str, Any]]:
    root = resolve_project(project)
    clean_id = str(task_id or "").strip()
    if not clean_id or any(char in clean_id for char in ("/", "\\", "..")):
        return []
    output = root / "Edict_Output" / clean_id
    if not output.is_dir():
        return []
    items: list[dict[str, Any]] = []
    for path in sorted(output.rglob("*")):
        if not path.is_file() or path.is_symlink():
            continue
        try:
            stat = path.stat()
            items.append({
                "path": _safe_relative(path, root),
                "name": path.name,
                "size": stat.st_size,
                "modifiedAt": stat.st_mtime,
            })
        except OSError:
            continue
        if len(items) >= 100:
            break
    return items


def git_snapshot(project: str | pathlib.Path) -> dict[str, Any]:
    root = resolve_project(project)
    if not (root / ".git").exists():
        return {"available": False, "branch": "", "changedFiles": [], "summary": "不是 Git 仓库"}

    def run(args: list[str]) -> str:
        try:
            result = subprocess.run(["git", *args], cwd=str(root), capture_output=True, text=True, timeout=8)
            return (result.stdout or "").strip()
        except (OSError, subprocess.TimeoutExpired):
            return ""

    status = run(["status", "--short"])
    branch = run(["branch", "--show-current"])
    stat = run(["diff", "--stat"])
    changed = [line[:300] for line in status.splitlines() if line.strip()][:100]
    return {"available": True, "branch": branch, "changedFiles": changed, "summary": stat or "工作区干净"}


def _latest_run(data_dir: pathlib.Path, task_id: str) -> dict[str, Any] | None:
    runs = atomic_json_read(data_dir / "workspace_runs.json", [])
    if not isinstance(runs, list):
        return None
    matching = [item for item in runs if isinstance(item, dict) and item.get("taskId") == task_id]
    return matching[-1] if matching else None


def snapshot(project: str | pathlib.Path, task_id: str, data_dir: str | pathlib.Path) -> dict[str, Any]:
    root = resolve_project(project)
    commands = detect_test_commands(root)
    latest = _latest_run(pathlib.Path(data_dir), task_id)
    return {
        "ok": True,
        "projectPath": str(root),
        "outputDir": str(root / "Edict_Output" / str(task_id)),
        "artifacts": list_artifacts(root, task_id),
        "git": git_snapshot(root),
        "testCommands": [{key: value for key, value in command.items() if key != "argv"} for command in commands],
        "latestTest": latest,
    }


def _update_run(data_dir: pathlib.Path, run_id: str, updater) -> None:
    path = data_dir / "workspace_runs.json"

    def update(value: Any) -> list[dict[str, Any]]:
        rows = value if isinstance(value, list) else []
        for row in rows:
            if isinstance(row, dict) and row.get("id") == run_id:
                updater(row)
        return rows[-100:]

    atomic_json_update(path, update, default=[])


def start_test(project: str | pathlib.Path, task_id: str, data_dir: str | pathlib.Path, command_id: str) -> dict[str, Any]:
    root = resolve_project(project)
    commands = detect_test_commands(root)
    command = next((item for item in commands if item.get("id") == command_id), None)
    if not command or not command.get("argv"):
        raise ValueError("没有可执行的测试命令")
    data_root = pathlib.Path(data_dir)
    data_root.mkdir(parents=True, exist_ok=True)
    run_id = uuid.uuid4().hex
    started = time.time()
    record = {
        "id": run_id,
        "taskId": str(task_id),
        "commandId": command_id,
        "label": command.get("label", command_id),
        "status": "running",
        "startedAt": started,
        "finishedAt": None,
        "exitCode": None,
        "output": "",
    }
    atomic_json_update(data_root / "workspace_runs.json", lambda value: (value if isinstance(value, list) else [])[-99:] + [record], default=[])

    def worker() -> None:
        process: subprocess.Popen[str] | None = None
        try:
            options: dict[str, Any] = {
                "cwd": str(root),
                "stdout": subprocess.PIPE,
                "stderr": subprocess.STDOUT,
                "text": True,
                "env": os.environ.copy(),
            }
            if os.name != "nt":
                options["start_new_session"] = True
            process = subprocess.Popen(command["argv"], **options)
            with _RUN_LOCK:
                _RUN_PROCESSES[run_id] = process
            output, _ = process.communicate(timeout=900)
            _update_run(data_root, run_id, lambda row: row.update({
                "status": "passed" if process and process.returncode == 0 else "failed",
                "finishedAt": time.time(), "exitCode": process.returncode if process else None,
                "output": (output or "")[-MAX_OUTPUT:],
            }))
        except subprocess.TimeoutExpired:
            if process:
                cancel_run(run_id)
            _update_run(data_root, run_id, lambda row: row.update({"status": "timeout", "finishedAt": time.time(), "output": "测试超过 15 分钟，已停止。"}))
        except Exception as exc:
            _update_run(data_root, run_id, lambda row: row.update({"status": "failed", "finishedAt": time.time(), "output": str(exc)[:MAX_OUTPUT]}))
        finally:
            with _RUN_LOCK:
                _RUN_PROCESSES.pop(run_id, None)

    threading.Thread(target=worker, name=f"edict-test-{run_id[:8]}", daemon=True).start()
    return {"ok": True, "runId": run_id, "message": f"已开始执行：{command.get('label', command_id)}"}


def cancel_run(run_id: str) -> dict[str, Any]:
    with _RUN_LOCK:
        process = _RUN_PROCESSES.get(run_id)
    if not process:
        return {"ok": False, "error": "测试进程不存在或已结束"}
    try:
        if os.name != "nt" and process.pid:
            os.killpg(os.getpgid(process.pid), signal.SIGTERM)
        else:
            process.terminate()
    except OSError:
        pass
    return {"ok": True, "message": "已请求停止测试"}
