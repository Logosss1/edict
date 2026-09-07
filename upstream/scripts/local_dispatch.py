"""Task-scoped, authenticated loopback transport for native OpenClaw subagents.

The desktop's external notification switch does not control this internal RPC
transport. Nothing is installed as a service and no user Gateway is restarted.
The supervisor and all children share the task process group, so the dashboard's
existing pause/cancel kills the entire run, not just the initial CLI request.
"""
import json
import os
import pathlib
import secrets
import signal
import socket
import sqlite3
import subprocess
import sys
import time
from urllib.request import urlopen

from file_lock import atomic_json_write


def configure_transport(config_path, environment):
    path = pathlib.Path(config_path)
    config = json.loads(path.read_text(encoding="utf-8"))
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    env = dict(environment)
    # Do not accidentally connect to the user's separate Gateway.
    for key in ("OPENCLAW_GATEWAY_URL", "OPENCLAW_GATEWAY_PASSWORD", "OPENCLAW_GATEWAY_PORT"):
        env.pop(key, None)
    env.update(OPENCLAW_GATEWAY_TOKEN=secrets.token_urlsafe(32),
               OPENCLAW_GATEWAY_PORT=str(port), OPENCLAW_SKIP_CHANNELS="1")
    state = pathlib.Path(env["EDICT_DISPATCH_STATE_DIR"])
    state.mkdir(parents=True, exist_ok=True, mode=0o700)
    canonical_state = pathlib.Path(env.get("OPENCLAW_STATE_DIR") or path.parent)
    env.update(OPENCLAW_STATE_DIR=str(state), OPENCLAW_HOME=str(state))
    config["gateway"] = {
        "mode": "local", "bind": "loopback", "port": port,
        "auth": {"mode": "token"}, "controlUi": {"enabled": False},
        "reload": {"mode": "off"}, "tailscale": {"mode": "off"},
    }
    config["channels"] = {}
    config["bindings"] = []
    config["cron"] = {"enabled": False}
    config["update"] = {"checkOnStart": False}
    config["discovery"] = {"mdns": {"mode": "off"}}
    config.setdefault("agents", {}).setdefault("defaults", {})["heartbeat"] = {"every": "0m"}
    for agent in config["agents"].get("list", []):
        agent["heartbeat"] = {"every": "0m"}
        agent["agentDir"] = str(state / "agents" / agent["id"] / "agent")
    # Keep canonical memory AND transcripts visible to the existing monitor
    # and 御书房. Explicit per-attempt session keys prevent main-session takeover;
    # only model caches and subagent registries are isolated per transport.
    config.setdefault("session", {}).setdefault("store", str(canonical_state / "agents" / "{agentId}" / "sessions" / "sessions.json"))
    env["EDICT_DISPATCH_SESSION_STORE"] = config["session"]["store"]
    config["logging"] = {"file": str(state / "gateway.log"), "redactSensitive": "tools"}
    atomic_json_write(path, config)
    path.chmod(0o600)
    return env, port, state


def child_runs(state):
    # Bundled 2026.7.1-2 migrated this registry to SQLite; older runtimes used
    # runs.json. Reading only JSON falsely reports idle while children run.
    database = state / "state" / "openclaw.sqlite"
    if database.exists():
        with sqlite3.connect(database.resolve().as_uri() + "?mode=ro", uri=True, timeout=2) as db:
            return [{"childSessionKey": key, "cleanupCompletedAt": completed}
                    for key, completed in db.execute("SELECT child_session_key, cleanup_completed_at FROM subagent_runs")]
    path = state / "subagents" / "runs.json"
    if not path.exists():
        return []
    # A malformed snapshot is an error, never evidence of completion.
    return list(json.loads(path.read_text(encoding="utf-8")).get("runs", {}).values())


def pending_children(state):
    return any(not run.get("cleanupCompletedAt") for run in child_runs(state))


def active_session_locks(state, env, root_key):
    keys = {root_key, *(run.get("childSessionKey", "") for run in child_runs(state))}
    for key in keys:
        if not key.startswith("agent:"):
            continue
        store = pathlib.Path(env["EDICT_DISPATCH_SESSION_STORE"].replace("{agentId}", key.split(":")[1]))
        if store.exists():
            entry = json.loads(store.read_text()).get(key, {})
            session_file = entry.get("sessionFile") or str(store.parent / (str(entry.get("sessionId", "")) + ".jsonl"))
            if pathlib.Path(session_file + ".lock").exists():
                return True
    return False


def stop(process):
    if process is None or process.poll() is not None:
        return
    process.terminate()
    try:
        process.wait(timeout=3)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=3)


def run(binary, agent_args):
    env, port, state = configure_transport(os.environ["OPENCLAW_CONFIG_PATH"], os.environ)
    gateway = client = None
    deadline = time.monotonic() + 295
    parent = os.getppid()
    cancelled = False
    root_key = agent_args[agent_args.index("--session-key") + 1]

    def cancel(_signum, _frame):
        nonlocal cancelled
        cancelled = True

    signal.signal(signal.SIGTERM, cancel)
    signal.signal(signal.SIGINT, cancel)

    def check():
        if cancelled or os.getppid() != parent:
            raise RuntimeError("本次本地派发已停止")
        if time.monotonic() >= deadline:
            raise RuntimeError("本地多 Agent 派发超时；子 Agent 尚未完成回报")
        if gateway is not None and gateway.poll() is not None:
            raise RuntimeError("本地 Agent 通信服务意外退出，请在执行保障检查运行依赖")

    # Files avoid PIPE deadlocks when a long-running Gateway emits diagnostics.
    with (state / "transport.log").open("w+", encoding="utf-8") as transport_log:
        os.chmod(state / "transport.log", 0o600)
        try:
            gateway = subprocess.Popen([binary, "gateway", "run", "--bind", "loopback", "--port", str(port)],
                                       env=env, stdout=transport_log, stderr=transport_log)
            startup_deadline = time.monotonic() + 40
            while True:
                check()
                try:
                    with urlopen(f"http://127.0.0.1:{port}/healthz", timeout=1) as response:
                        if response.status == 200:
                            break
                except OSError:
                    pass
                if time.monotonic() > startup_deadline:
                    raise RuntimeError("本地 Agent 通信服务启动超时，请在执行保障检查运行依赖")
                time.sleep(.2)
            # This is an actual authenticated RPC probe, not only a listening port.
            probe = subprocess.run([binary, "gateway", "call", "health", "--json", "--timeout", "5000"],
                                   env=env, capture_output=True, text=True, timeout=15)
            if probe.returncode:
                raise RuntimeError("本地 Agent 通信认证失败：" + probe.stderr[-1200:])
            client = subprocess.Popen([binary, "agent", *agent_args], env=env,
                                      stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            while True:
                check()
                try:
                    stdout, stderr = client.communicate(timeout=.5)
                    break
                except subprocess.TimeoutExpired:
                    pass
            if client.returncode:
                raise RuntimeError(stderr.strip() or stdout.strip() or "Agent 调用失败")
            # sessions_spawn/yield returns before the completion announce. Keep
            # the authenticated transport alive through all parent continuations.
            idle_since = None
            while True:
                check()
                busy = pending_children(state) or active_session_locks(state, env, root_key)
                if busy:
                    idle_since = None
                elif idle_since is None:
                    idle_since = time.monotonic()
                elif time.monotonic() - idle_since >= 2:
                    break
                time.sleep(.2)
            print(stdout, end="")
            return 0
        except Exception as exc:
            transport_log.flush()
            transport_log.seek(0)
            detail = transport_log.read()[-2000:]
            message = str(exc) + "\n" + detail
            for key, value in env.items():
                if value and ("TOKEN" in key or "PASSWORD" in key or "API_KEY" in key or key.startswith("EDICT_DISPATCH_PROVIDER_")):
                    message = message.replace(value, "[redacted]")
            print(message[-3500:], file=sys.stderr)
            return 1
        finally:
            stop(client)
            stop(gateway)


if __name__ == "__main__":
    sys.exit(run(sys.argv[1], sys.argv[2:]))
