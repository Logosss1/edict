"""Shared child environment; desktop path repairs apply without server restart."""
import json
import os
import pathlib
import shutil


def runtime_environment(base=None):
    environment = dict(os.environ if base is None else base)
    snapshot = os.environ.get("EDICT_RUNTIME_DEPENDENCIES")
    if snapshot:
        # Atomic desktop snapshots contain paths only, never provider credentials.
        try:
            value = json.loads(pathlib.Path(snapshot).read_text(encoding="utf-8"))
            for field, key in (("openclawPath", "OPENCLAW_BIN"), ("nodePath", "EDICT_NODE_BIN"), ("path", "PATH")):
                if isinstance(value.get(field), str):
                    environment[key] = value[field]
        except (OSError, ValueError):
            environment["OPENCLAW_BIN"] = ""
            environment["EDICT_NODE_BIN"] = ""
    return environment


def resolve_openclaw_bin():
    environment = runtime_environment()
    configured = environment.get("OPENCLAW_BIN", "").strip()
    if os.environ.get("EDICT_RUNTIME_DEPENDENCIES") and not configured:
        return None
    return configured or shutil.which("openclaw", path=environment.get("PATH"))


def runtime_status(binary=None):
    environment = runtime_environment()
    binary = binary or resolve_openclaw_bin()
    node = environment.get("EDICT_NODE_BIN") or shutil.which("node", path=environment.get("PATH"))
    errors = []
    if not binary or not shutil.which(binary, path=environment.get("PATH")):
        errors.append("未找到可执行的 OpenClaw，请打开设置检查运行依赖。")
    if not node or not shutil.which(node, path=environment.get("PATH")):
        errors.append("未找到可执行的 Node.js，请打开设置检查运行依赖。")
    return {"ok": not errors, "errors": errors}
