#!/usr/bin/env python3
"""
三省六部 · 看板本地 API 服务器
Port: 7891 (可通过 --port 修改)

Endpoints:
  GET  /                       → dashboard/dist/index.html
  GET  /api/live-status        → data/live_status.json
  GET  /api/agent-config       → data/agent_config.json
  POST /api/set-model          → {agentId, model}
  GET  /api/model-change-log   → data/model_change_log.json
  GET  /api/last-result        → data/last_model_change_result.json
"""
import json, pathlib, subprocess, sys, threading, argparse, datetime, logging, re, os, socket, shutil, signal, uuid
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import urlparse, parse_qs, quote
from urllib.request import Request, urlopen

# JWT 认证模块
from auth import init as auth_init, requires_auth, extract_token, verify_token, \
    is_enabled as auth_enabled, is_configured as auth_configured, \
    setup_password, verify_password, create_token

# 引入文件锁工具，确保与其他脚本并发安全
scripts_dir = str(pathlib.Path(__file__).parent.parent / 'scripts')
sys.path.insert(0, scripts_dir)
from file_lock import atomic_json_read, atomic_json_write, atomic_json_update
from utils import validate_url, read_json, now_iso, python_bin
from openclaw_runtime import resolve_openclaw_bin, runtime_environment
import model_capabilities as model_caps
from court_discuss import (
    create_session as cd_create, advance_discussion as cd_advance,
    get_session as cd_get, conclude_session as cd_conclude,
    list_sessions as cd_list, destroy_session as cd_destroy,
    delete_session as cd_delete,
    get_fate_event as cd_fate, OFFICIAL_PROFILES as CD_PROFILES,
    configure_storage as cd_configure_storage,
    delete_attachment as cd_delete_attachment,
)
from yushufang import YushufangService
from yushufang_runtime import prepare_local_dispatch_runtime
from chat_attachments import AttachmentStore, MAX_FILE_SIZE
from command_center import (
    CommandCenterStore,
    build_plan as build_command_plan,
    classify_instruction,
    infer_ministry,
    make_message as make_command_message,
    SIX_MINISTRY_AGENTS,
)
from execution_workspace import (
    cancel_run as cancel_workspace_run,
    snapshot as workspace_snapshot,
    start_test as start_workspace_test,
)

log = logging.getLogger('server')
logging.basicConfig(level=logging.INFO, format='%(asctime)s [%(name)s] %(message)s', datefmt='%H:%M:%S')

CHANNELS_DIR = pathlib.Path(__file__).parent.parent / 'edict' / 'backend' / 'app' / 'channels'
if str(CHANNELS_DIR.parent) not in sys.path:
    sys.path.insert(0, str(CHANNELS_DIR.parent))
from channels import get_channel, get_channel_info, CHANNELS as NOTIFICATION_CHANNELS

OCLAW_HOME = pathlib.Path(os.environ.get('EDICT_OPENCLAW_HOME', str(pathlib.Path.home() / '.openclaw'))).expanduser()
MAX_REQUEST_BODY = 1 * 1024 * 1024  # 1 MB
ALLOWED_ORIGIN = None  # Set via --cors; None means restrict to localhost
_DASHBOARD_PORT = 7891  # Updated at startup from --port arg
_DEFAULT_ORIGINS = {
    'http://127.0.0.1:7891', 'http://localhost:7891',
    'http://127.0.0.1:5173', 'http://localhost:5173',  # Vite dev server
}
_SAFE_NAME_RE = re.compile(r'^[a-zA-Z0-9_\-\u4e00-\u9fff]+$')


def _openclaw_provider_id(value):
    """Normalize a desktop provider id exactly as the OpenClaw adapter does."""
    raw = str(value or '').strip().lower()
    if not raw:
        return ''
    normalized = re.sub(r'[^a-z0-9_-]+', '-', raw).strip('-_') or 'provider'
    if not re.match(r'^[a-z]', normalized):
        normalized = 'edict-' + normalized
    return normalized[:63].rstrip('-_')


def _auto_dispatch_enabled():
    """Allow desktop demo mode to observe the board without waking Agents."""
    return os.environ.get('EDICT_AUTO_DISPATCH', '1').strip().lower() not in {'0', 'false', 'no', 'off'}

BASE = pathlib.Path(__file__).parent
DIST = BASE / 'dist'          # React 构建产物 (npm run build)
_DATA_OVERRIDE = os.environ.get('EDICT_DATA_DIR')
DATA = pathlib.Path(_DATA_OVERRIDE).expanduser().resolve() if _DATA_OVERRIDE else BASE.parent / "data"
SCRIPTS = BASE.parent / 'scripts'
_ACTIVE_TASK_DATA_DIR = None
_YUSHUFANG_SERVICE = None
cd_configure_storage(DATA)
CHAT_ATTACHMENTS = AttachmentStore(DATA)


def get_yushufang_service():
    """Return the process-local 御书房 service backed by the EDICT data dir."""
    global _YUSHUFANG_SERVICE
    if _YUSHUFANG_SERVICE is None:
        _YUSHUFANG_SERVICE = YushufangService(
            DATA,
            openclaw_bin=resolve_openclaw_bin,
            task_creator=handle_create_task,
        )
    return _YUSHUFANG_SERVICE

# 静态资源 MIME 类型
_MIME_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js':   'application/javascript; charset=utf-8',
    '.css':  'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png':  'image/png',
    '.jpg':  'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif':  'image/gif',
    '.svg':  'image/svg+xml',
    '.ico':  'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf':  'font/ttf',
    '.map':  'application/json',
}


def cors_headers(h):
    req_origin = h.headers.get('Origin', '')
    if ALLOWED_ORIGIN:
        origin = ALLOWED_ORIGIN
    elif req_origin in _DEFAULT_ORIGINS:
        origin = req_origin
    else:
        origin = f'http://127.0.0.1:{_DASHBOARD_PORT}'
    h.send_header('Access-Control-Allow-Origin', origin)
    h.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    h.send_header('Access-Control-Allow-Headers', 'Content-Type')


def _iter_task_data_dirs():
    """返回可用的任务数据目录候选（优先 workspace，其次本地 data）。"""
    dirs = [DATA]
    if os.environ.get('EDICT_USE_WORKSPACE_DATA', '1').lower() not in {'0', 'false', 'no'}:
        for p in sorted(OCLAW_HOME.glob('workspace-*/data')):
            if p.is_dir():
                dirs.append(p)
    return dirs


def _task_source_score(task_file: pathlib.Path):
    """给任务源打分：优先非 demo 任务，其次任务数，再按文件更新时间。"""
    try:
        tasks = atomic_json_read(task_file, [])
    except Exception:
        tasks = []
    if not isinstance(tasks, list):
        tasks = []
    non_demo = sum(1 for t in tasks if str((t or {}).get('id', '')) and not str((t or {}).get('id', '')).startswith('JJC-DEMO'))
    try:
        mtime = task_file.stat().st_mtime
    except Exception:
        mtime = 0
    return (1 if non_demo > 0 else 0, non_demo, len(tasks), mtime)


def get_task_data_dir():
    """自动选择当前任务数据目录，并缓存结果以保持一次服务期内稳定。"""
    global _ACTIVE_TASK_DATA_DIR
    if _ACTIVE_TASK_DATA_DIR and _ACTIVE_TASK_DATA_DIR.is_dir():
        return _ACTIVE_TASK_DATA_DIR
    best_dir = DATA
    best_score = (-1, -1, -1, -1)
    for d in _iter_task_data_dirs():
        tf = d / 'tasks_source.json'
        if not tf.exists():
            continue
        score = _task_source_score(tf)
        if score > best_score:
            best_score = score
            best_dir = d
    _ACTIVE_TASK_DATA_DIR = best_dir
    log.info(f'任务数据源: {_ACTIVE_TASK_DATA_DIR}')
    return _ACTIVE_TASK_DATA_DIR


def load_tasks():
    task_data_dir = get_task_data_dir()
    return atomic_json_read(task_data_dir / 'tasks_source.json', [])


def save_tasks(tasks):
    task_data_dir = get_task_data_dir()
    atomic_json_write(task_data_dir / 'tasks_source.json', tasks)
    _trigger_refresh()


def _trigger_refresh():
    """Trigger live data refresh in background."""
    task_data_dir = get_task_data_dir()
    script = task_data_dir.parent / 'scripts' / 'refresh_live_data.py'
    if not script.exists():
        script = SCRIPTS / 'refresh_live_data.py'

    def _refresh():
        try:
            subprocess.run([python_bin(), str(script)], timeout=30)
        except Exception as e:
            log.warning(f'refresh_live_data.py 触发失败: {e}')
    threading.Thread(target=_refresh, daemon=True).start()


def modify_tasks(modifier):
    """Atomically read-modify-write the tasks file.

    ``modifier(tasks)`` receives the current task list, mutates it in place
    (or returns a new list), and the result is persisted while the file lock
    is held.  This avoids the TOCTOU race inherent in separate
    ``load_tasks()`` / ``save_tasks()`` calls when background threads
    (dispatch callbacks, periodic scanner) and the HTTP handler mutate tasks
    concurrently.
    """
    task_data_dir = get_task_data_dir()
    path = task_data_dir / 'tasks_source.json'
    atomic_json_update(path, modifier, default=[])
    _trigger_refresh()


def modify_task(task_id, updater):
    """Atomically update a single task identified by *task_id*.

    ``updater(task)`` receives the task dict and should mutate it in place.
    Returns ``True`` if the task was found and updated, ``False`` otherwise.
    """
    found = [False]

    def _modifier(tasks):
        task = next((t for t in tasks if t.get('id') == task_id), None)
        if task is None:
            return tasks
        updater(task)
        task['updatedAt'] = now_iso()
        found[0] = True
        return tasks

    modify_tasks(_modifier)
    return found[0]


_ACTIVE_DISPATCHES = {}
_ACTIVE_DISPATCH_LOCK = threading.RLock()


def _terminate_dispatch_process(process):
    """Stop a real OpenClaw child process, including its local process group."""
    if process is None:
        return
    try:
        if process.poll() is not None:
            return
    except Exception:
        pass
    try:
        if os.name != 'nt' and getattr(process, 'pid', None):
            try:
                os.killpg(os.getpgid(process.pid), signal.SIGTERM)
            except (OSError, ProcessLookupError):
                process.terminate()
        else:
            process.terminate()
    except Exception:
        try:
            process.kill()
        except Exception:
            return
    try:
        process.wait(timeout=2)
    except Exception:
        try:
            process.kill()
        except Exception:
            pass


def _register_dispatch(task_id, attempt_id=''):
    """Register one dispatch and stop an older dispatch for the same task."""
    record = {
        'attemptId': attempt_id,
        'cancel_event': threading.Event(),
        'process': None,
    }
    previous_process = None
    with _ACTIVE_DISPATCH_LOCK:
        previous = _ACTIVE_DISPATCHES.get(task_id)
        if previous:
            previous['cancel_event'].set()
            previous_process = previous.get('process')
        _ACTIVE_DISPATCHES[task_id] = record
    if previous_process:
        _terminate_dispatch_process(previous_process)
    return record


def _unregister_dispatch(task_id, record):
    with _ACTIVE_DISPATCH_LOCK:
        if _ACTIVE_DISPATCHES.get(task_id) is record:
            _ACTIVE_DISPATCHES.pop(task_id, None)


def _dispatch_is_current(task_id, record):
    with _ACTIVE_DISPATCH_LOCK:
        return _ACTIVE_DISPATCHES.get(task_id) is record and not record['cancel_event'].is_set()


def _attach_dispatch_process(task_id, record, process):
    should_stop = False
    with _ACTIVE_DISPATCH_LOCK:
        if _ACTIVE_DISPATCHES.get(task_id) is not record or record['cancel_event'].is_set():
            should_stop = True
        else:
            record['process'] = process
    if should_stop:
        _terminate_dispatch_process(process)
        return False
    return True


def _dispatch_target_is_active(task_id, expected_state, record):
    if not _dispatch_is_current(task_id, record):
        return False
    task = next((item for item in load_tasks() if item.get('id') == task_id), None)
    if not task or task.get('state') != expected_state:
        return False
    attempt_id = record.get('attemptId')
    if attempt_id and (task.get('_scheduler') or {}).get('dispatchAttemptId') != attempt_id:
        return False
    return True


def _dispatch_scheduler_update(task_id, record, updater, expected_state=None):
    """Apply a dispatch result only while this dispatch is still authoritative."""
    def _guarded(task, sched):
        if not _dispatch_is_current(task_id, record):
            return
        if expected_state and task.get('state') != expected_state:
            return
        updater(task, sched)
    return _update_task_scheduler(task_id, _guarded)


def _record_dispatch_failure(task_id, record, expected_state, agent_id, trigger, status, error, label):
    """Record an actionable failure and block only the stage that failed."""
    message = str(error or label).strip()[:500]

    def _apply(task, sched):
        if not _dispatch_is_current(task_id, record):
            return
        sched.update({
            'lastDispatchAt': now_iso(),
            'lastDispatchStatus': status,
            'lastDispatchAgent': agent_id,
            'lastDispatchTrigger': trigger,
            'lastDispatchError': message,
        })
        if task.get('state') == expected_state or (record.get('local_tree') and task.get('state') not in _TERMINAL_STATES | {'Blocked'}):
            task['_prev_state'] = task.get('state')
            task['state'] = 'Blocked'
            task['block'] = message
            task['now'] = f'⛔ 自动派发失败：{message}'
            _scheduler_add_flow(task, f'{label}：{message}', to=task.get('org', ''))

    _dispatch_scheduler_update(task_id, record, _apply, expected_state=None if record.get('local_tree') else expected_state)


def handle_task_action(task_id, action, reason):
    """Stop/cancel/resume a task from the dashboard."""
    result = {'error': '', 'task': None, 'state': ''}
    reason = reason or ('皇上叫停' if action == 'stop' else '皇上取消' if action == 'cancel' else '恢复执行')

    def _apply(task):
        old_state = task.get('state', '')
        if action == 'stop' and old_state in _TERMINAL_STATES | {'Blocked'}:
            result['error'] = f'任务 {task_id} 当前状态为 {old_state}，无法叫停'
            return
        if action == 'cancel' and old_state in _TERMINAL_STATES:
            result['error'] = f'任务 {task_id} 已结束，无法取消'
            return
        if action == 'resume' and old_state not in {'Blocked', 'Cancelled'}:
            result['error'] = f'任务 {task_id} 当前状态为 {old_state}，无需恢复'
            return

        _ensure_scheduler(task)
        _scheduler_snapshot(task, f'task-action-before-{action}')
        if action == 'stop':
            task['_prev_state'] = task.get('_prev_state') or old_state
            task['state'] = 'Blocked'
            task['block'] = reason
            task['now'] = f'⏸️ 已暂停：{reason}'
            task['_scheduler']['lastDispatchStatus'] = 'cancelled'
        elif action == 'cancel':
            if old_state not in {'Blocked', 'Cancelled'}:
                task['_prev_state'] = old_state
            task['state'] = 'Cancelled'
            task['block'] = reason
            task['now'] = f'🚫 已取消：{reason}'
            task['_scheduler']['lastDispatchStatus'] = 'cancelled'
        else:
            task['state'] = task.get('_prev_state', 'Doing')
            task['block'] = '无'
            task['now'] = '▶️ 已恢复执行'
            task['_scheduler']['lastDispatchError'] = ''

        task.setdefault('flow_log', []).append({
            'at': now_iso(),
            'from': '皇上',
            'to': task.get('org', ''),
            'remark': f'{"⏸️ 叫停" if action == "stop" else "🚫 取消" if action == "cancel" else "▶️ 恢复"}：{reason}',
        })
        if action == 'resume':
            _scheduler_mark_progress(task, f'恢复到 {task.get("state", "Doing")}')
        else:
            _scheduler_add_flow(task, f'皇上{action}：{reason}')
        result['task'] = dict(task)
        result['state'] = task.get('state', '')

    found = modify_task(task_id, _apply)
    if not found:
        return {'ok': False, 'error': f'任务 {task_id} 不存在'}
    if result['error']:
        return {'ok': False, 'error': result['error']}

    if action in ('stop', 'cancel'):
        with _ACTIVE_DISPATCH_LOCK:
            active = _ACTIVE_DISPATCHES.get(task_id)
            if active:
                active['cancel_event'].set()
                process = active.get('process')
            else:
                process = None
        if process:
            _terminate_dispatch_process(process)
    elif result['state'] not in _TERMINAL_STATES:
        dispatch_for_state(task_id, result['task'], result['state'], trigger='resume')
    label = {'stop': '已叫停', 'cancel': '已取消', 'resume': '已恢复'}[action]
    return {
        'ok': True,
        'message': f'{task_id} {label}',
        'state': result['state'],
        'task': result['task'],
    }


def handle_archive_task(task_id, archived, archive_all_done=False):
    """Archive or unarchive a task, or batch-archive all Done/Cancelled tasks."""
    tasks = load_tasks()
    if archive_all_done:
        count = 0
        for t in tasks:
            if t.get('state') in ('Done', 'Cancelled') and not t.get('archived'):
                t['archived'] = True
                t['archivedAt'] = now_iso()
                count += 1
        save_tasks(tasks)
        return {'ok': True, 'message': f'{count} 道旨意已归档', 'count': count}
    task = next((t for t in tasks if t.get('id') == task_id), None)
    if not task:
        return {'ok': False, 'error': f'任务 {task_id} 不存在'}
    task['archived'] = archived
    if archived:
        task['archivedAt'] = now_iso()
    else:
        task.pop('archivedAt', None)
    task['updatedAt'] = now_iso()
    save_tasks(tasks)
    label = '已归档' if archived else '已取消归档'
    return {'ok': True, 'message': f'{task_id} {label}'}


def handle_delete_task(task_id):
    """Permanently remove a completed/cancelled task record."""
    clean_id = str(task_id or '').strip()
    if not clean_id or not _SAFE_NAME_RE.fullmatch(clean_id):
        return {'ok': False, 'error': 'taskId 无效'}
    result = {'found': False, 'error': ''}

    def _remove(tasks):
        task = next((item for item in tasks if item.get('id') == clean_id), None)
        if task is None:
            return tasks
        result['found'] = True
        state = task.get('state', '')
        if state not in _TERMINAL_STATES:
            result['error'] = f'任务 {clean_id} 当前状态为 {state}，请先完成或取消后再删除'
            return tasks
        return [item for item in tasks if item.get('id') != clean_id]

    modify_tasks(_remove)
    if result['error']:
        return {'ok': False, 'error': result['error']}
    if not result['found']:
        return {'ok': False, 'error': f'任务 {clean_id} 不存在'}
    return {'ok': True, 'taskId': clean_id, 'message': f'{clean_id} 已删除'}


def update_task_todos(task_id, todos):
    """Update the todos list for a task."""
    tasks = load_tasks()
    task = next((t for t in tasks if t.get('id') == task_id), None)
    if not task:
        return {'ok': False, 'error': f'任务 {task_id} 不存在'}

    task['todos'] = todos
    task['updatedAt'] = now_iso()
    save_tasks(tasks)
    return {'ok': True, 'message': f'{task_id} todos 已更新'}


def read_skill_content(agent_id, skill_name):
    """Read SKILL.md content for a specific skill."""
    # 输入校验：防止路径遍历
    if not _SAFE_NAME_RE.match(agent_id) or not _SAFE_NAME_RE.match(skill_name):
        return {'ok': False, 'error': '参数含非法字符'}
    cfg = read_json(DATA / 'agent_config.json', {})
    agents = cfg.get('agents', [])
    ag = next((a for a in agents if a.get('id') == agent_id), None)
    if not ag:
        return {'ok': False, 'error': f'Agent {agent_id} 不存在'}
    sk = next((s for s in ag.get('skills', []) if s.get('name') == skill_name), None)
    if not sk:
        return {'ok': False, 'error': f'技能 {skill_name} 不存在'}
    skill_path = pathlib.Path(sk.get('path', '')).resolve()
    # 路径遍历保护：确保路径在 OCLAW_HOME 或项目目录下
    allowed_roots = (OCLAW_HOME.resolve(), BASE.parent.resolve())
    if not any(str(skill_path).startswith(str(root)) for root in allowed_roots):
        return {'ok': False, 'error': '路径不在允许的目录范围内'}
    if not skill_path.exists():
        return {'ok': True, 'name': skill_name, 'agent': agent_id, 'content': '(SKILL.md 文件不存在)', 'path': str(skill_path)}
    try:
        content = skill_path.read_text()
        return {'ok': True, 'name': skill_name, 'agent': agent_id, 'content': content, 'path': str(skill_path)}
    except Exception as e:
        return {'ok': False, 'error': str(e)}


def add_skill_to_agent(agent_id, skill_name, description, trigger=''):
    """Create a new skill for an agent with a standardised SKILL.md template."""
    if not _SAFE_NAME_RE.match(skill_name):
        return {'ok': False, 'error': f'skill_name 含非法字符: {skill_name}'}
    if not _SAFE_NAME_RE.match(agent_id):
        return {'ok': False, 'error': f'agentId 含非法字符: {agent_id}'}
    workspace = OCLAW_HOME / f'workspace-{agent_id}' / 'skills' / skill_name
    workspace.mkdir(parents=True, exist_ok=True)
    skill_md = workspace / 'SKILL.md'
    desc_line = description or skill_name
    trigger_section = f'\n## 触发条件\n{trigger}\n' if trigger else ''
    template = (f'---\n'
                f'name: {skill_name}\n'
                f'description: {desc_line}\n'
                f'---\n\n'
                f'# {skill_name}\n\n'
                f'{desc_line}\n'
                f'{trigger_section}\n'
                f'## 输入\n\n'
                f'<!-- 说明此技能接收什么输入 -->\n\n'
                f'## 处理流程\n\n'
                f'1. 步骤一\n'
                f'2. 步骤二\n\n'
                f'## 输出规范\n\n'
                f'<!-- 说明产出物格式与交付要求 -->\n\n'
                f'## 注意事项\n\n'
                f'- (在此补充约束、限制或特殊规则)\n')
    skill_md.write_text(template)
    # Re-sync agent config
    try:
        subprocess.run([python_bin(), str(SCRIPTS / 'sync_agent_config.py')], timeout=10)
    except Exception:
        pass
    return {'ok': True, 'message': f'技能 {skill_name} 已添加到 {agent_id}', 'path': str(skill_md)}


def add_remote_skill(agent_id, skill_name, source_url, description=''):
    """从远程 URL 或本地路径为 Agent 添加 skill SKILL.md 文件。
    
    支持的源：
    - HTTPS URLs: https://raw.githubusercontent.com/...
    - 本地路径: /path/to/SKILL.md 或 file:///path/to/SKILL.md
    """
    # 输入校验
    if not _SAFE_NAME_RE.match(agent_id):
        return {'ok': False, 'error': f'agentId 含非法字符: {agent_id}'}
    if not _SAFE_NAME_RE.match(skill_name):
        return {'ok': False, 'error': f'skillName 含非法字符: {skill_name}'}
    if not source_url or not isinstance(source_url, str):
        return {'ok': False, 'error': 'sourceUrl 必须是有效的字符串'}
    
    source_url = source_url.strip()
    
    # 检查 Agent 是否存在
    cfg = read_json(DATA / 'agent_config.json', {})
    agents = cfg.get('agents', [])
    if not any(a.get('id') == agent_id for a in agents):
        return {'ok': False, 'error': f'Agent {agent_id} 不存在'}
    
    # 下载或读取文件内容
    try:
        if source_url.startswith('http://') or source_url.startswith('https://'):
            # HTTPS URL 校验
            if not validate_url(source_url, allowed_schemes=('https',)):
                return {'ok': False, 'error': 'URL 无效或不安全（仅支持 HTTPS）'}
            
            # 从 URL 下载，带超时保护
            req = Request(source_url, headers={'User-Agent': 'OpenClaw-SkillManager/1.0'})
            try:
                resp = urlopen(req, timeout=10)
                content = resp.read(10 * 1024 * 1024).decode('utf-8')  # 最多 10MB
                if len(content) > 10 * 1024 * 1024:
                    return {'ok': False, 'error': '文件过大（最大 10MB）'}
            except Exception as e:
                return {'ok': False, 'error': f'URL 无法访问: {str(e)[:100]}'}
        
        elif source_url.startswith('file://'):
            # file:// URL 格式
            local_path = pathlib.Path(source_url[7:]).resolve()
            if not local_path.exists():
                return {'ok': False, 'error': f'本地文件不存在: {local_path}'}
            # 路径遍历防护：与本地路径分支一致，确保在允许范围内
            allowed_roots = (OCLAW_HOME.resolve(), BASE.parent.resolve())
            if not any(str(local_path).startswith(str(root)) for root in allowed_roots):
                return {'ok': False, 'error': '路径不在允许的目录范围内'}
            content = local_path.read_text()
        
        elif source_url.startswith('/') or source_url.startswith('.'):
            # 本地绝对或相对路径
            local_path = pathlib.Path(source_url).resolve()
            if not local_path.exists():
                return {'ok': False, 'error': f'本地文件不存在: {local_path}'}
            # 路径遍历防护
            allowed_roots = (OCLAW_HOME.resolve(), BASE.parent.resolve())
            if not any(str(local_path).startswith(str(root)) for root in allowed_roots):
                return {'ok': False, 'error': '路径不在允许的目录范围内'}
            content = local_path.read_text()
        
        else:
            return {'ok': False, 'error': '不支持的 URL 格式（仅支持 https://, file://, 或本地路径）'}
    except Exception as e:
        return {'ok': False, 'error': f'文件读取失败: {str(e)[:100]}'}
    
    # 基础验证：检查是否为 Markdown 且包含 YAML frontmatter
    if not content.startswith('---'):
        return {'ok': False, 'error': '文件格式无效（缺少 YAML frontmatter）'}
    
    # 验证 frontmatter 结构（先做字符串检查，再尝试 YAML 解析）
    parts = content.split('---', 2)
    if len(parts) < 3:
        return {'ok': False, 'error': '文件格式无效（YAML frontmatter 结构错误）'}
    if 'name:' not in content[:500]:
        return {'ok': False, 'error': '文件格式无效：frontmatter 缺少 name 字段'}
    try:
        import yaml
        yaml.safe_load(parts[1])  # 严格校验 YAML 语法
    except ImportError:
        pass  # PyYAML 未安装，跳过严格验证，字符串检查已通过
    except Exception as e:
        return {'ok': False, 'error': f'YAML 格式无效: {str(e)[:100]}'}
    
    # 创建本地目录
    workspace = OCLAW_HOME / f'workspace-{agent_id}' / 'skills' / skill_name
    workspace.mkdir(parents=True, exist_ok=True)
    skill_md = workspace / 'SKILL.md'
    
    # 写入 SKILL.md
    skill_md.write_text(content)
    
    # 保存源信息到 .source.json
    source_info = {
        'skillName': skill_name,
        'sourceUrl': source_url,
        'description': description,
        'addedAt': now_iso(),
        'lastUpdated': now_iso(),
        'checksum': _compute_checksum(content),
        'status': 'valid',
    }
    source_json = workspace / '.source.json'
    source_json.write_text(json.dumps(source_info, ensure_ascii=False, indent=2))
    
    # Re-sync agent config
    try:
        subprocess.run([python_bin(), str(SCRIPTS / 'sync_agent_config.py')], timeout=10)
    except Exception:
        pass
    
    return {
        'ok': True,
        'message': f'技能 {skill_name} 已从远程源添加到 {agent_id}',
        'skillName': skill_name,
        'agentId': agent_id,
        'source': source_url,
        'localPath': str(skill_md),
        'size': len(content),
        'addedAt': now_iso(),
    }


def get_remote_skills_list():
    """列表所有已添加的远程 skills 及其源信息"""
    remote_skills = []
    
    # 遍历所有 workspace
    for ws_dir in OCLAW_HOME.glob('workspace-*'):
        agent_id = ws_dir.name.replace('workspace-', '')
        skills_dir = ws_dir / 'skills'
        if not skills_dir.exists():
            continue
        
        for skill_dir in skills_dir.iterdir():
            if not skill_dir.is_dir():
                continue
            skill_name = skill_dir.name
            source_json = skill_dir / '.source.json'
            skill_md = skill_dir / 'SKILL.md'
            
            if not source_json.exists():
                # 本地创建的 skill，跳过
                continue
            
            try:
                source_info = json.loads(source_json.read_text())
                # 检查 SKILL.md 是否存在
                status = 'valid' if skill_md.exists() else 'not-found'
                remote_skills.append({
                    'skillName': skill_name,
                    'agentId': agent_id,
                    'sourceUrl': source_info.get('sourceUrl', ''),
                    'description': source_info.get('description', ''),
                    'localPath': str(skill_md),
                    'addedAt': source_info.get('addedAt', ''),
                    'lastUpdated': source_info.get('lastUpdated', ''),
                    'status': status,
                })
            except Exception:
                pass
    
    return {
        'ok': True,
        'remoteSkills': remote_skills,
        'count': len(remote_skills),
        'listedAt': now_iso(),
    }


def update_remote_skill(agent_id, skill_name):
    """更新已添加的远程 skill 为最新版本（重新从源 URL 下载）"""
    if not _SAFE_NAME_RE.match(agent_id):
        return {'ok': False, 'error': f'agentId 含非法字符: {agent_id}'}
    if not _SAFE_NAME_RE.match(skill_name):
        return {'ok': False, 'error': f'skillName 含非法字符: {skill_name}'}
    
    workspace = OCLAW_HOME / f'workspace-{agent_id}' / 'skills' / skill_name
    source_json = workspace / '.source.json'
    skill_md = workspace / 'SKILL.md'
    
    if not source_json.exists():
        return {'ok': False, 'error': f'技能 {skill_name} 不是远程 skill（无 .source.json）'}
    
    try:
        source_info = json.loads(source_json.read_text())
        source_url = source_info.get('sourceUrl', '')
        if not source_url:
            return {'ok': False, 'error': '源 URL 不存在'}
        
        # 重新下载
        result = add_remote_skill(agent_id, skill_name, source_url, 
                                  source_info.get('description', ''))
        if result['ok']:
            result['message'] = f'技能已更新'
            source_info_updated = json.loads(source_json.read_text())
            result['newVersion'] = source_info_updated.get('checksum', 'unknown')
        return result
    except Exception as e:
        return {'ok': False, 'error': f'更新失败: {str(e)[:100]}'}


def remove_remote_skill(agent_id, skill_name):
    """移除已添加的远程 skill"""
    if not _SAFE_NAME_RE.match(agent_id):
        return {'ok': False, 'error': f'agentId 含非法字符: {agent_id}'}
    if not _SAFE_NAME_RE.match(skill_name):
        return {'ok': False, 'error': f'skillName 含非法字符: {skill_name}'}
    
    workspace = OCLAW_HOME / f'workspace-{agent_id}' / 'skills' / skill_name
    if not workspace.exists():
        return {'ok': False, 'error': f'技能不存在: {skill_name}'}
    
    # 检查是否为远程 skill
    source_json = workspace / '.source.json'
    if not source_json.exists():
        return {'ok': False, 'error': f'技能 {skill_name} 不是远程 skill，无法通过此 API 移除'}
    
    try:
        # 删除整个 skill 目录
        import shutil
        shutil.rmtree(workspace)
        
        # Re-sync agent config
        try:
            subprocess.run([python_bin(), str(SCRIPTS / 'sync_agent_config.py')], timeout=10)
        except Exception:
            pass
        
        return {'ok': True, 'message': f'技能 {skill_name} 已从 {agent_id} 移除'}
    except Exception as e:
        return {'ok': False, 'error': f'移除失败: {str(e)[:100]}'}


def _compute_checksum(content: str) -> str:
    import hashlib
    return hashlib.sha256(content.encode()).hexdigest()[:16]


def migrate_notification_config():
    """自动迁移旧配置 (feishu_webhook) 到新结构 (notification)"""
    cfg_path = DATA / 'morning_brief_config.json'
    cfg = read_json(cfg_path, {})
    if not cfg:
        return
    if 'notification' in cfg:
        return
    if 'feishu_webhook' not in cfg:
        return
    webhook = cfg.get('feishu_webhook', '').strip()
    cfg['notification'] = {
        'enabled': bool(webhook),
        'channel': 'feishu',
        'webhook': webhook
    }
    try:
        atomic_json_write(cfg_path, cfg)
        log.info('已自动迁移 feishu_webhook 到 notification 配置')
    except Exception as e:
        log.warning(f'迁移配置失败: {e}')


def push_notification():
    """通用消息推送 (支持多渠道)"""
    cfg = read_json(DATA / 'morning_brief_config.json', {})
    notification = cfg.get('notification', {})
    if not notification and cfg.get('feishu_webhook'):
        notification = {'enabled': True, 'channel': 'feishu', 'webhook': cfg['feishu_webhook']}
    if not notification.get('enabled', True):
        return
    channel_type = notification.get('channel', 'feishu')
    webhook = notification.get('webhook', '').strip()
    if not webhook:
        return
    channel_cls = get_channel(channel_type)
    if not channel_cls:
        log.warning(f'未知的通知渠道: {channel_type}')
        return
    if not channel_cls.validate_webhook(webhook):
        log.warning(f'{channel_cls.label} Webhook URL 不合法: {webhook}')
        return
    brief = read_json(DATA / 'morning_brief.json', {})
    date_str = brief.get('date', '')
    total = sum(len(v) for v in (brief.get('categories') or {}).values())
    if not total:
        return
    cat_lines = []
    for cat, items in (brief.get('categories') or {}).items():
        if items:
            cat_lines.append(f'  {cat}: {len(items)} 条')
    summary = '\n'.join(cat_lines)
    date_fmt = date_str[:4] + '年' + date_str[4:6] + '月' + date_str[6:] + '日' if len(date_str) == 8 else date_str
    title = f'📰 天下要闻 · {date_fmt}'
    content = f'共 **{total}** 条要闻已更新\n{summary}'
    url = f'http://127.0.0.1:{_DASHBOARD_PORT}'
    success = channel_cls.send(webhook, title, content, url)
    print(f'[{channel_cls.label}] 推送{"成功" if success else "失败"}')


def push_to_feishu():
    """Push morning brief link to Feishu via webhook. (已弃用，使用 push_notification)"""
    push_notification()


# 旨意标题最低要求
_MIN_TITLE_LEN = 6
_JUNK_TITLES = {
    '?', '？', '好', '好的', '是', '否', '不', '不是', '对', '了解', '收到',
    '嗯', '哦', '知道了', '开启了么', '可以', '不行', '行', 'ok', 'yes', 'no',
    '你去开启', '测试', '试试', '看看',
}


def _active_formal_tasks(tasks, exclude_id=''):
    """Return the one-at-a-time formal task lock candidates."""
    return [
        task for task in tasks
        if str(task.get('id') or '').startswith('JJC-')
        and task.get('id') != exclude_id
        and not task.get('archived')
        and task.get('state') not in _TERMINAL_STATES
    ]


def _task_output_dir(project_dir, task_id):
    if not project_dir:
        return ''
    path = pathlib.Path(project_dir).expanduser().resolve() / 'Edict_Output' / task_id
    path.mkdir(parents=True, exist_ok=True)
    return str(path)


def _small_task_id(tasks):
    today = datetime.datetime.now().strftime('%Y%m%d')
    prefix = f'SM-{today}-'
    ids = [str(task.get('id') or '') for task in tasks if str(task.get('id') or '').startswith(prefix)]
    nums = [int(item.rsplit('-', 1)[-1]) for item in ids if item.rsplit('-', 1)[-1].isdigit()]
    return f'{prefix}{(max(nums) + 1) if nums else 1:03d}'


def _pick_small_assignment(title):
    """Choose a fixed six-ministry Agent for a one-step task.

    The semantic department is preferred.  When it is busy, choose an idle
    configured ministry rather than sending the small task back to Zhongshu.
    """
    preferred = build_command_plan(title, 'small').get('targetDept') or '兵部'
    preferred_agent = SIX_MINISTRY_AGENTS.get(preferred, 'bingbu')
    ordered = [preferred_agent] + [agent for agent in SIX_MINISTRY_AGENTS.values() if agent != preferred_agent]
    idle = []
    for agent_id in ordered:
        try:
            _last, _count, busy = _get_agent_session_status(agent_id)
            if not busy:
                idle.append(agent_id)
        except Exception:
            idle.append(agent_id)
    agent_id = idle[0] if idle else preferred_agent
    return next((dept for dept, candidate in SIX_MINISTRY_AGENTS.items() if candidate == agent_id), preferred), agent_id


def handle_create_small_task(title, plan=None, command_message_id=''):
    """Create a non-formal one-step task for an idle fixed ministry Agent."""
    clean_title = str(title or '').strip()
    if len(clean_title) < 2:
        return {'ok': False, 'error': '小任务内容不能太短'}
    project_dir = os.environ.get('EDICT_PROJECT_DIR', '').strip()
    if os.environ.get('EDICT_DESKTOP') == '1' and not project_dir:
        return {'ok': False, 'error': '请先选择工作区项目目录，再执行小任务。', 'code': 'workspace_required'}
    if project_dir and not pathlib.Path(project_dir).expanduser().is_dir():
        return {'ok': False, 'error': '当前工作区项目目录不存在，请重新选择。', 'code': 'workspace_invalid'}
    tasks = load_tasks()
    task_id = _small_task_id(tasks)
    department, agent_id = _pick_small_assignment(clean_title)
    output_dir = ''
    try:
        output_dir = _task_output_dir(project_dir, task_id)
    except OSError as exc:
        return {'ok': False, 'error': f'无法准备工作区输出目录：{exc}', 'code': 'workspace_write_failed'}
    created_at = now_iso()
    new_task = {
        'id': task_id,
        'title': clean_title[:200],
        'official': department,
        'org': department,
        'state': 'Doing',
        'now': f'太子分拣完成，已交给{department}（{agent_id}）执行',
        'eta': '-',
        'block': '无',
        'output': output_dir,
        'ac': '',
        'priority': 'normal',
        'workflowMode': 'small',
        'dispatchKind': 'small',
        'commandMessageId': command_message_id,
        'targetDept': department,
        'targetAgent': agent_id,
        'dispatchMessage': clean_title[:12_000],
        'flow_log': [
            {'at': created_at, 'from': '皇上', 'to': '太子', 'remark': f'总控台下达小任务：{clean_title[:200]}'},
            {'at': created_at, 'from': '太子', 'to': department, 'remark': f'分拣完成，交给固定 Agent {agent_id}'},
        ],
        'updatedAt': created_at,
    }
    if output_dir:
        new_task['outputDir'] = output_dir
        new_task['projectPath'] = str(pathlib.Path(project_dir).expanduser().resolve())
    if isinstance(plan, dict):
        new_task['plan'] = {key: plan.get(key) for key in ('mode', 'modeLabel', 'reason', 'suggestedAgents', 'targetDept', 'nextStep') if key in plan}
    _ensure_scheduler(new_task)
    _scheduler_snapshot(new_task, 'create-small-task')
    _scheduler_mark_progress(new_task, '小任务创建并完成分拣')
    tasks.insert(0, new_task)
    save_tasks(tasks)
    dispatch_for_state(task_id, new_task, 'Doing', trigger='command-center-small')
    return {'ok': True, 'taskId': task_id, 'message': f'小任务已交给{department}（{agent_id}）执行', 'task': new_task}


def handle_create_task(title, org='中书省', official='中书令', priority='normal', template_id='', params=None, target_dept='', workflow_mode='standard', approval_mode='full', plan=None, command_message_id=''):
    """从看板创建新任务（圣旨模板下旨）。"""
    if not title or not title.strip():
        return {'ok': False, 'error': '任务标题不能为空'}
    title = title.strip()
    # 剥离 Conversation info 元数据
    title = re.split(r'\n*Conversation info\s*\(', title, maxsplit=1)[0].strip()
    title = re.split(r'\n*```', title, maxsplit=1)[0].strip()
    # 清理常见前缀: "传旨:" "下旨:" 等
    title = re.sub(r'^(传旨|下旨)[：:\uff1a]\s*', '', title)
    if len(title) > 100:
        title = title[:100] + '…'
    # 标题质量校验：防止闲聊被误建为旨意
    if len(title) < _MIN_TITLE_LEN:
        return {'ok': False, 'error': f'标题过短（{len(title)}<{_MIN_TITLE_LEN}字），不像是旨意'}
    if title.lower() in _JUNK_TITLES:
        return {'ok': False, 'error': f'「{title}」不是有效旨意，请输入具体工作指令'}
    # 生成 task id: JJC-YYYYMMDD-NNN
    today = datetime.datetime.now().strftime('%Y%m%d')
    tasks = load_tasks()
    workflow_mode = str(workflow_mode or 'standard').strip().lower()
    if workflow_mode not in {'standard', 'complex'}:
        workflow_mode = 'standard'
    # Every formal task gets a deterministic six-ministry destination before
    # it enters the chain.  Zhongshu and Shangshu can still refine the plan,
    # but an empty execution assignment is never allowed to reach Doing.
    target_dept = _normalize_six_ministry(target_dept) or infer_ministry(title)
    active_formal = _active_formal_tasks(tasks)
    if active_formal:
        current = active_formal[0]
        return {
            'ok': False,
            'code': 'formal_task_active',
            'activeTaskId': current.get('id', ''),
            'error': f'当前已有正式任务 {current.get("id", "")} 正在执行（{current.get("state", "") or "未知阶段"}）。完成、取消或归档后才能开始下一场正式任务；小任务仍可使用空闲六部 Agent。',
        }
    today_ids = [t['id'] for t in tasks if t.get('id', '').startswith(f'JJC-{today}-')]
    seq = 1
    if today_ids:
        nums = [int(tid.split('-')[-1]) for tid in today_ids if tid.split('-')[-1].isdigit()]
        seq = max(nums) + 1 if nums else 1
    task_id = f'JJC-{today}-{seq:03d}'
    # 正确流程起点：皇上 -> 太子分拣
    # target_dept 记录模板建议的最终执行部门（仅供尚书省派发参考）
    initial_org = '太子'
    new_task = {
        'id': task_id,
        'title': title,
        'official': official,
        'org': initial_org,
        'state': 'Taizi',
        'now': '等待太子接旨分拣',
        'eta': '-',
        'block': '无',
        'output': '',
        'ac': '',
        'priority': priority,
        'templateId': template_id,
        'templateParams': params or {},
        'workflowMode': workflow_mode,
        'approvalMode': str(approval_mode or 'full'),
        'commandMessageId': command_message_id,
        'targetDept': target_dept,
        'targetAgent': 'taizi',
        'flow_log': [{
            'at': now_iso(),
            'from': '皇上',
            'to': initial_org,
            'remark': f'下旨：{title}'
        }],
        'updatedAt': now_iso(),
    }
    project_dir = os.environ.get('EDICT_PROJECT_DIR', '').strip()
    if os.environ.get('EDICT_DESKTOP') == '1' and not project_dir:
        return {'ok': False, 'code': 'workspace_required', 'error': '请先选择工作区项目目录，再下达正式任务。'}
    if project_dir and not pathlib.Path(project_dir).expanduser().is_dir():
        return {'ok': False, 'code': 'workspace_invalid', 'error': '当前工作区项目目录不存在，请重新选择。'}
    if project_dir:
        new_task['projectPath'] = str(pathlib.Path(project_dir).expanduser().resolve())
        try:
            new_task['outputDir'] = _task_output_dir(project_dir, task_id)
        except OSError as exc:
            return {'ok': False, 'code': 'workspace_write_failed', 'error': f'无法准备工作区输出目录：{exc}'}
    if target_dept:
        new_task['targetDept'] = target_dept
    if isinstance(plan, dict):
        new_task['plan'] = {key: plan.get(key) for key in ('mode', 'modeLabel', 'reason', 'suggestedAgents', 'targetDept', 'nextStep') if key in plan}

    _ensure_scheduler(new_task)
    _scheduler_snapshot(new_task, 'create-task-initial')
    _scheduler_mark_progress(new_task, '任务创建')

    tasks.insert(0, new_task)
    save_tasks(tasks)
    log.info(f'创建任务: {task_id} | {title[:40]}')

    dispatch_for_state(task_id, new_task, 'Taizi', trigger='imperial-edict')

    return {'ok': True, 'taskId': task_id, 'message': f'旨意 {task_id} 已下达，正在派发给太子'}


def _command_center_store():
    return CommandCenterStore(DATA)


def get_command_center():
    return {'ok': True, **_command_center_store().snapshot()}


def _command_center_reply(store, text, plan, **extra):
    message = make_command_message('taizi', text, plan, **extra)
    store.append(message)
    return message


def _execute_command_center_plan(store, text, plan, permission_mode='full', command_message_id=''):
    mode = plan.get('mode')
    if mode == 'chat':
        return _command_center_reply(
            store,
            '太子分拣：这是实时问询，不建立正式任务。若要询问某个 Agent 的实时进度，请进入御书房；御书房会读取该 Agent 当前工作会话，不会把问询误建成旨意。',
            plan,
            action='open-yushufang',
        )
    if mode == 'small':
        result = handle_create_small_task(text, plan, command_message_id)
    else:
        result = handle_create_task(
            text,
            org='中书省',
            official='中书令',
            priority='normal',
            target_dept=plan.get('targetDept', ''),
            workflow_mode=mode,
            approval_mode=permission_mode,
            plan=plan,
            command_message_id=command_message_id,
        )
    if result.get('ok'):
        task_id = result.get('taskId', '')
        _command_center_reply(
            store,
            f'太子分拣完成：{plan.get("modeLabel", mode)}已建立，任务编号 {task_id}。{plan.get("nextStep", "")}',
            plan,
            taskId=task_id,
            action='task-created',
        )
    else:
        _command_center_reply(
            store,
            f'太子分拣未能继续：{result.get("error", "任务建立失败")}',
            plan,
            action='blocked',
            errorCode=result.get('code', ''),
        )
    return result


def handle_command_center_message(body):
    """Classify a desktop instruction, then route it to the existing workflow."""
    text = str((body or {}).get('text') or '').strip()
    if not text:
        return {'ok': False, 'error': '请输入要交给太子的内容'}
    if len(text) > 12_000:
        return {'ok': False, 'error': '单条指令不能超过 12000 个字符'}
    store = _command_center_store()
    requested_mode = str((body or {}).get('mode') or '').strip().lower()
    permission_mode = str((body or {}).get('permissionMode') or 'full').strip().lower()
    if permission_mode not in {'ask', 'auto', 'full'}:
        permission_mode = 'full'
    plan = build_command_plan(text, requested_mode)
    command_message_id = uuid.uuid4().hex
    store.append(make_command_message('emperor', text, plan, id=command_message_id, permissionMode=permission_mode))

    if plan.get('mode') == 'complex' and permission_mode == 'ask' and not (body or {}).get('approved'):
        pending = {
            'id': command_message_id,
            'text': text,
            'plan': plan,
            'permissionMode': permission_mode,
            'createdAt': now_iso(),
        }
        store.set_pending(pending)
        _command_center_reply(
            store,
            '太子分拣完成：这是复杂任务。请先确认计划、工作区范围和权限，再进入三省六部正式流程。',
            plan,
            action='approval-required',
        )
        return {'ok': True, 'requiresApproval': True, 'plan': plan, 'commandMessageId': command_message_id, **store.snapshot()}

    store.set_pending(None)
    result = _execute_command_center_plan(store, text, plan, permission_mode, command_message_id)
    return {**result, 'plan': plan, 'commandMessageId': command_message_id, **store.snapshot()}


def handle_command_center_approve():
    store = _command_center_store()
    pending = store.snapshot().get('pendingPlan')
    if not isinstance(pending, dict) or not pending.get('text') or not isinstance(pending.get('plan'), dict):
        return {'ok': False, 'error': '当前没有待确认的复杂任务'}
    store.set_pending(None)
    result = _execute_command_center_plan(
        store,
        pending['text'],
        pending['plan'],
        str(pending.get('permissionMode') or 'full'),
        str(pending.get('id') or ''),
    )
    return {**result, 'plan': pending['plan'], 'commandMessageId': pending.get('id', ''), **store.snapshot()}


def get_task_workspace(task_id):
    clean_id = str(task_id or '').strip()
    if not clean_id or not _SAFE_NAME_RE.fullmatch(clean_id):
        return {'ok': False, 'error': 'taskId 无效'}
    task = next((item for item in load_tasks() if item.get('id') == clean_id), None)
    if not task:
        return {'ok': False, 'error': f'任务 {clean_id} 不存在'}
    execution_department, execution_agent = _resolve_execution_assignment(task)
    current_agent = _STATE_AGENT_MAP.get(task.get('state'))
    if (
        task.get('state') in {'Doing', 'Next'}
        or task.get('targetDept')
        or task.get('org') in {'六部', '执行中'}
        or _normalize_six_ministry(task.get('targetDept') or task.get('org'))
    ):
        current_agent = execution_agent or task.get('targetAgent', '')
    current_department = task.get('targetDept') or execution_department
    project = str(task.get('projectPath') or os.environ.get('EDICT_PROJECT_DIR') or '').strip()
    if not project:
        return {
            'ok': True,
            'taskId': clean_id,
            'task': {
                'id': clean_id, 'title': task.get('title', ''), 'state': task.get('state', ''),
                'org': task.get('org', ''), 'targetDept': current_department,
                'targetAgent': current_agent or task.get('targetAgent', ''),
            },
            'projectPath': '', 'outputDir': '', 'artifacts': [], 'testCommands': [], 'latestTest': None,
            'git': {'available': False, 'branch': '', 'changedFiles': [], 'summary': '尚未选择项目目录'},
            'permission': {'mode': 'full', 'scope': '等待选择工作区项目目录'},
            'activity': get_task_activity(clean_id).get('activity', []),
        }
    try:
        data = workspace_snapshot(project, clean_id, DATA)
    except (ValueError, PermissionError, OSError) as exc:
        return {'ok': False, 'taskId': clean_id, 'error': str(exc)}
    data.update({
        'taskId': clean_id,
        'task': {
            'id': clean_id, 'title': task.get('title', ''), 'state': task.get('state', ''),
            'org': task.get('org', ''), 'now': task.get('now', ''), 'targetDept': current_department,
            'targetAgent': current_agent or task.get('targetAgent', ''), 'block': task.get('block', ''),
        },
        'agentId': current_agent or task.get('targetAgent', ''),
        'permission': {
            'mode': task.get('permissionMode', 'full'),
            'scope': '当前任务可在选定项目目录内读写、运行项目命令和测试；工作区外及系统级敏感操作不自动放行',
        },
        'activity': get_task_activity(clean_id).get('activity', []),
    })
    return data


def start_task_workspace_test(task_id, command_id=''):
    clean_id = str(task_id or '').strip()
    task = next((item for item in load_tasks() if item.get('id') == clean_id), None)
    if not task:
        return {'ok': False, 'error': f'任务 {clean_id} 不存在'}
    project = str(task.get('projectPath') or os.environ.get('EDICT_PROJECT_DIR') or '').strip()
    if not project:
        return {'ok': False, 'error': '任务尚未绑定工作区项目目录'}
    try:
        commands = workspace_snapshot(project, clean_id, DATA).get('testCommands') or []
        if not command_id:
            command_id = commands[0].get('id', '') if commands else ''
        return start_workspace_test(project, clean_id, DATA, command_id)
    except (ValueError, PermissionError, OSError) as exc:
        return {'ok': False, 'error': str(exc)}


def _todo_progress(task):
    todos = task.get('todos') or []
    total = len(todos)
    completed = sum(1 for td in todos if td.get('status') == 'completed')
    return completed, total


def handle_review_action(task_id, action, comment=''):
    """门下省御批：准奏/封驳。"""
    tasks = load_tasks()
    task = next((t for t in tasks if t.get('id') == task_id), None)
    if not task:
        return {'ok': False, 'error': f'任务 {task_id} 不存在'}
    if task.get('state') not in ('Review', 'Menxia'):
        return {'ok': False, 'error': f'任务 {task_id} 当前状态为 {task.get("state")}，无法御批'}

    _ensure_scheduler(task)
    _scheduler_snapshot(task, f'review-before-{action}')

    if action == 'approve':
        if task['state'] == 'Menxia':
            task['state'] = 'Assigned'
            task['now'] = '门下省准奏，移交尚书省派发'
            remark = f'✅ 准奏：{comment or "门下省审议通过"}'
            to_dept = '尚书省'
        else:  # Review
            completed, total = _todo_progress(task)
            if total > 0 and completed < total:
                return {'ok': False, 'error': f'子任务尚未全部完成（{completed}/{total}），不能直接准奏完结'}
            task['state'] = 'Done'
            task['now'] = '御批通过，任务完成'
            remark = f'✅ 御批准奏：{comment or "审查通过"}'
            to_dept = '皇上'
    elif action == 'reject':
        round_num = (task.get('review_round') or 0) + 1
        task['review_round'] = round_num
        task['state'] = 'Zhongshu'
        task['now'] = f'封驳退回中书省修订（第{round_num}轮）'
        remark = f'🚫 封驳：{comment or "需要修改"}'
        to_dept = '中书省'
    else:
        return {'ok': False, 'error': f'未知操作: {action}'}

    task.setdefault('flow_log', []).append({
        'at': now_iso(),
        'from': '门下省' if task.get('state') != 'Done' else '皇上',
        'to': to_dept,
        'remark': remark
    })
    _scheduler_mark_progress(task, f'审议动作 {action} -> {task.get("state")}')
    task['updatedAt'] = now_iso()
    save_tasks(tasks)

    # 🚀 审批后自动派发对应 Agent
    new_state = task['state']
    if new_state not in ('Done',):
        dispatch_for_state(task_id, task, new_state)

    label = '已准奏' if action == 'approve' else '已封驳'
    dispatched = ' (已自动派发 Agent)' if new_state != 'Done' else ''
    return {'ok': True, 'message': f'{task_id} {label}{dispatched}'}


# ══ Agent 在线状态检测 ══

_AGENT_DEPTS = [
    {'id':'taizi',   'label':'太子',  'emoji':'🤴', 'role':'太子',     'rank':'储君'},
    {'id':'zhongshu','label':'中书省','emoji':'📜', 'role':'中书令',   'rank':'正一品'},
    {'id':'menxia',  'label':'门下省','emoji':'🔍', 'role':'侍中',     'rank':'正一品'},
    {'id':'shangshu','label':'尚书省','emoji':'📮', 'role':'尚书令',   'rank':'正一品'},
    {'id':'hubu',    'label':'户部',  'emoji':'💰', 'role':'户部尚书', 'rank':'正二品'},
    {'id':'libu',    'label':'礼部',  'emoji':'📝', 'role':'礼部尚书', 'rank':'正二品'},
    {'id':'bingbu',  'label':'兵部',  'emoji':'⚔️', 'role':'兵部尚书', 'rank':'正二品'},
    {'id':'xingbu',  'label':'刑部',  'emoji':'⚖️', 'role':'刑部尚书', 'rank':'正二品'},
    {'id':'gongbu',  'label':'工部',  'emoji':'🔧', 'role':'工部尚书', 'rank':'正二品'},
    {'id':'libu_hr', 'label':'吏部',  'emoji':'👔', 'role':'吏部尚书', 'rank':'正二品'},
    {'id':'zaochao', 'label':'钦天监','emoji':'📰', 'role':'朝报官',   'rank':'正三品'},
]


def _check_gateway_alive():
    """检测 Gateway 是否在运行。

    Windows 上不要依赖 pgrep；优先通过本地端口探测判断。
    """
    if _check_gateway_probe():
        return True
    try:
        if os.name == 'nt':
            with socket.create_connection(('127.0.0.1', 18789), timeout=2):
                return True
            return False
        result = subprocess.run(['pgrep', '-f', 'openclaw-gateway'],
                                capture_output=True, text=True, timeout=5)
        return result.returncode == 0
    except Exception:
        return False


def _check_gateway_probe():
    """通过 HTTP probe 检测 Gateway 是否响应。"""
    for url in ('http://127.0.0.1:18789/', 'http://127.0.0.1:18789/healthz'):
        try:
            from urllib.request import urlopen
            resp = urlopen(url, timeout=3)
            if 200 <= resp.status < 500:
                return True
        except Exception:
            continue
    return False


def _dispatch_channel_config():
    """Return the verified external dispatch channel, or an empty string.

    ``dispatchChannel`` is retained as the user's selected channel, while
    ``dispatchChannelEnabled`` is the explicit opt-in gate. Legacy configs
    without the gate therefore remain local-only instead of silently entering
    the user's Gateway route.
    """
    config = read_json(DATA / 'agent_config.json', {})
    if not isinstance(config, dict):
        return ''
    channel = str(config.get('dispatchChannel') or '').strip().lower()
    return channel if channel and config.get('dispatchChannelEnabled') is True else ''


def _workspace_access_preflight():
    """Check the selected project without touching any user files."""
    project = str(os.environ.get('EDICT_PROJECT_DIR') or '').strip()
    if not project:
        return False, '尚未选择项目目录，请先完成工作区设置。'
    path = pathlib.Path(project).expanduser()
    if not path.is_dir():
        return False, '当前项目目录不存在或不是文件夹。'
    if not all(os.access(path, mode) for mode in (os.R_OK, os.W_OK, os.X_OK)):
        return False, '当前项目目录缺少读、写或进入权限；请在 macOS 系统设置中授权。'
    probe = path / f'.edict-access-probe-{uuid.uuid4().hex}.tmp'
    try:
        probe.write_text('edict workspace access probe\n', encoding='utf-8')
        probe.unlink(missing_ok=True)
        return True, '项目目录可读、可写，临时文件测试通过。'
    except PermissionError:
        try:
            probe.unlink(missing_ok=True)
        except OSError:
            pass
        return False, '应用无法在项目目录创建临时文件；请检查 macOS 文件访问权限。'
    except OSError as exc:
        try:
            probe.unlink(missing_ok=True)
        except OSError:
            pass
        return False, f'项目目录权限检查失败：{exc.strerror or exc}。'


def _secret_configured(value):
    if isinstance(value, dict):
        if value.get('source') == 'env':
            return bool(os.environ.get(str(value.get('id') or '').strip()))
        return bool(value)
    return bool(str(value or '').strip())


def _external_dispatch_preflight(channel):
    """Validate the effective desktop Gateway route before dispatching."""
    config = read_json(OCLAW_HOME / 'openclaw.json', {})
    if not isinstance(config, dict):
        return False, '桌面版 OpenClaw 配置不可读取。'
    channels = config.get('channels') if isinstance(config.get('channels'), dict) else {}
    channel_config = channels.get(channel)
    if not isinstance(channel_config, dict) or channel_config.get('enabled') is False:
        return False, f'{channel} 尚未在桌面运行环境中配置；请在设置中填写渠道信息并完成验证。'

    gateway = config.get('gateway') if isinstance(config.get('gateway'), dict) else {}
    auth = gateway.get('auth') if isinstance(gateway.get('auth'), dict) else {}
    auth_mode = str(auth.get('mode') or '').strip().lower()
    has_auth = auth_mode == 'none' or _secret_configured(auth.get('token')) or _secret_configured(auth.get('password'))
    has_auth = has_auth or bool(os.environ.get('OPENCLAW_GATEWAY_TOKEN') or os.environ.get('OPENCLAW_GATEWAY_PASSWORD'))
    if not has_auth:
        return False, '桌面版 Gateway 尚未完成认证配置；请先配置 token/password 并验证连接。'
    return True, '外部派发渠道和 Gateway 配置已就绪。'


def _get_agent_session_status(agent_id):
    """读取 Agent 的 sessions.json 获取活跃状态。
    返回: (last_active_ts_ms, session_count, is_busy)
    """
    sessions_file = OCLAW_HOME / 'agents' / agent_id / 'sessions' / 'sessions.json'
    if not sessions_file.exists():
        return 0, 0, False
    try:
        data = json.loads(sessions_file.read_text())
        if not isinstance(data, dict):
            return 0, 0, False
        session_count = len(data)
        last_ts = 0
        for v in data.values():
            ts = v.get('updatedAt', 0)
            if isinstance(ts, (int, float)) and ts > last_ts:
                last_ts = ts
        now_ms = int(datetime.datetime.now().timestamp() * 1000)
        age_ms = now_ms - last_ts if last_ts else 9999999999
        is_busy = age_ms <= 2 * 60 * 1000  # 2分钟内视为正在工作
        return last_ts, session_count, is_busy
    except Exception:
        return 0, 0, False


def _check_agent_process(agent_id):
    """检测是否有该 Agent 的 openclaw-agent 进程正在运行。"""
    try:
        result = subprocess.run(
            ['pgrep', '-f', f'openclaw.*--agent.*{agent_id}'],
            capture_output=True, text=True, timeout=5
        )
        return result.returncode == 0
    except Exception:
        return False


def _check_agent_workspace(agent_id):
    """检查 Agent 工作空间是否存在。"""
    ws = OCLAW_HOME / f'workspace-{agent_id}'
    return ws.is_dir()


def get_agents_status():
    """获取所有 Agent 的在线状态。
    返回各 Agent 的:
    - status: 'running' | 'idle' | 'offline' | 'unconfigured'
    - lastActive: 最后活跃时间
    - sessions: 会话数
    - hasWorkspace: 工作空间是否存在
    - processAlive: 是否有进程在运行
    """
    gateway_alive = _check_gateway_alive()
    gateway_probe = _check_gateway_probe() if gateway_alive else False

    agents = []
    seen_ids = set()
    for dept in _AGENT_DEPTS:
        aid = dept['id']
        if aid in seen_ids:
            continue
        seen_ids.add(aid)

        has_workspace = _check_agent_workspace(aid)
        last_ts, sess_count, is_busy = _get_agent_session_status(aid)
        process_alive = _check_agent_process(aid)

        # 状态判定
        if not has_workspace:
            status = 'unconfigured'
            status_label = '❌ 未配置'
        elif not gateway_alive:
            status = 'offline'
            status_label = '🔴 Gateway 离线'
        elif process_alive or is_busy:
            status = 'running'
            status_label = '🟢 运行中'
        elif last_ts > 0:
            now_ms = int(datetime.datetime.now().timestamp() * 1000)
            age_ms = now_ms - last_ts
            if age_ms <= 10 * 60 * 1000:  # 10分钟内
                status = 'idle'
                status_label = '🟡 待命'
            elif age_ms <= 3600 * 1000:  # 1小时内
                status = 'idle'
                status_label = '⚪ 空闲'
            else:
                status = 'idle'
                status_label = '⚪ 休眠'
        else:
            status = 'idle'
            status_label = '⚪ 无记录'

        # 格式化最后活跃时间
        last_active_str = None
        if last_ts > 0:
            try:
                last_active_str = datetime.datetime.fromtimestamp(
                    last_ts / 1000
                ).strftime('%m-%d %H:%M')
            except Exception:
                pass

        agents.append({
            'id': aid,
            'label': dept['label'],
            'emoji': dept['emoji'],
            'role': dept['role'],
            'status': status,
            'statusLabel': status_label,
            'lastActive': last_active_str,
            'lastActiveTs': last_ts,
            'sessions': sess_count,
            'hasWorkspace': has_workspace,
            'processAlive': process_alive,
        })

    return {
        'ok': True,
        'gateway': {
            'alive': gateway_alive,
            'probe': gateway_probe,
            'status': '🟢 运行中' if gateway_probe else ('🟡 进程在但无响应' if gateway_alive else '🔴 未启动'),
        },
        'agents': agents,
        'checkedAt': now_iso(),
    }


def get_readiness():
    """Return a redacted, actionable execution-preflight contract.

    The dashboard, 御书房 and 朝堂议政 all share the same local runtime and
    provider configuration.  Keep their readiness decision in one place so a
    green status on one page cannot disagree with a blocked action on another.
    A failed warning check is reported to the user but does not prevent the
    core workflow; a failed blocker does.
    """

    def check(item_id, label, ready, detail, scope, action_type='settings', action_label='打开设置', target=None, blocking=True):
        action = {'type': action_type, 'label': action_label}
        if target:
            action['target'] = target
        return {
            'id': item_id,
            'label': label,
            'ready': bool(ready),
            'detail': str(detail or ''),
            'scope': scope,
            'blocking': bool(blocking),
            'severity': 'ready' if ready else ('blocker' if blocking else 'warning'),
            'action': action,
        }

    config = read_json(OCLAW_HOME / 'openclaw.json', {})
    if not isinstance(config, dict):
        config = {}
    providers = ((config.get('models') or {}).get('providers') or {})
    agents = ((config.get('agents') or {}).get('list') or [])
    defaults = ((config.get('agents') or {}).get('defaults') or {})
    default_model = defaults.get('model', '')
    if isinstance(default_model, dict):
        default_model = default_model.get('primary', '')

    configured_agents = [item for item in agents if isinstance(item, dict) and str(item.get('id') or '').strip()]
    bound = []
    provider_secret_status = {}
    for provider_id, provider in (providers.items() if isinstance(providers, dict) else []):
        if not isinstance(provider, dict):
            continue
        api_key = provider.get('apiKey')
        if isinstance(api_key, dict):
            env_id = str(api_key.get('id') or '').strip()
            provider_secret_status[provider_id] = bool(env_id and os.environ.get(env_id))
        elif isinstance(api_key, str) and api_key.strip():
            # Legacy plaintext is not considered ready; the settings layer
            # must migrate it into secure storage before use.
            provider_secret_status[provider_id] = False
        else:
            provider_secret_status[provider_id] = False
        for model in provider.get('models', []) if isinstance(provider.get('models'), list) else []:
            if isinstance(model, dict) and str(model.get('id') or '').strip():
                bound.append(f'{provider_id}/{model["id"]}')

    models_ready = bool(bound)
    agent_models = []
    for agent in configured_agents:
        model = agent.get('model') or default_model
        if isinstance(model, dict):
            model = model.get('primary', '')
        if isinstance(model, str) and model.strip():
            agent_models.append(model.strip())
    agent_binding_ready = bool(agent_models) and all(model in bound for model in agent_models)
    required_provider_ids = {
        model.split('/', 1)[0]
        for model in agent_models
        if '/' in model
    }
    secret_ready = (
        all(provider_secret_status.get(provider_id, False) for provider_id in required_provider_ids)
        if required_provider_ids
        else any(provider_secret_status.values())
    )
    runtime = get_yushufang_service().check_runtime()
    checks = []
    # The desktop launcher always selects a project before opening the main
    # workbench. Keep the legacy HTTP test harness independent of this check.
    if os.environ.get('EDICT_DESKTOP') == '1':
        workspace_ready, workspace_detail = _workspace_access_preflight()
        checks.append(check(
            'workspace', '工作区权限', workspace_ready, workspace_detail, 'workspace',
            action_type='workspace-permission', action_label='打开工作区权限设置',
        ))

    dispatch_channel = _dispatch_channel_config()
    if dispatch_channel:
        dispatch_ready, dispatch_detail = _external_dispatch_preflight(dispatch_channel)
        checks.append(check(
            'dispatch', '外部派发', dispatch_ready, dispatch_detail, 'dispatch',
            action_label='打开派发渠道配置', target='models',
        ))
    else:
        checks.append(check(
            'dispatch', '派发渠道', True, '外部派发已关闭，将使用桌面内置本地派发。', 'dispatch',
            action_type='none', action_label='无需配置', blocking=False,
        ))

    checks.extend([
        check(
            'runtime', '运行依赖', bool(runtime.get('ok')),
            'OpenClaw 与 Node.js 已就绪' if runtime.get('ok') else '；'.join(runtime.get('errors') or []),
            'runtime', target='dependencies', action_label='打开运行依赖设置',
        ),
        check(
            'provider', '供应商', bool(providers),
            f'{len(providers)} 个供应商已进入运行配置' if providers else '还没有供应商配置',
            'provider', target='providers', action_label='打开供应商设置',
        ),
        check(
            'secret', '密钥', secret_ready,
            '密钥已注入当前运行环境' if secret_ready else '请在设置中保存供应商密钥',
            'provider', target='providers', action_label='打开供应商设置',
        ),
        check(
            'model', '模型目录', models_ready,
            f'{len(bound)} 个模型可用' if models_ready else '供应商尚未配置模型',
            'provider', target='models', action_label='打开模型设置',
        ),
        check(
            'agent', 'Agent 绑定', bool(configured_agents) and agent_binding_ready,
            f'{len(configured_agents)} 个 Agent 已绑定有效模型' if configured_agents and agent_binding_ready else '请为至少一个 Agent 应用有效模型',
            'agent', target='agents', action_label='打开 Agent 设置',
        ),
    ])

    # 六部不是一个可以兜底的虚拟 Agent，而是六个固定执行 Agent。
    # 只要其中一个没有注册或没有绑定可用模型，执行保障就必须提前拦截，
    # 避免任务进入 Doing 后才浪费一次错误的模型调用。
    configured_by_id = {
        str(item.get('id') or '').strip(): item
        for item in configured_agents
    }
    missing_ministries = []
    invalid_ministry_models = []
    for ministry, ministry_agent in _SIX_MINISTRY_AGENT_MAP.items():
        configured = configured_by_id.get(ministry_agent)
        if not configured:
            missing_ministries.append(f'{ministry}（{ministry_agent}）')
            continue
        model = configured.get('model') or default_model
        if isinstance(model, dict):
            model = model.get('primary', '')
        if not isinstance(model, str) or not model.strip() or model.strip() not in bound:
            invalid_ministry_models.append(f'{ministry}（{ministry_agent}）')
    six_ready = not missing_ministries and not invalid_ministry_models
    six_detail = '礼部、户部、兵部、刑部、工部、吏部 Agent 均已绑定有效模型' if six_ready else (
        '缺少 Agent：' + '、'.join(missing_ministries[:6])
        if missing_ministries else
        '模型未就绪：' + '、'.join(invalid_ministry_models[:6])
    )
    checks.append(check(
        'six_ministries', '六部 Agent', six_ready, six_detail, 'agent',
        target='agents', action_label='打开六部 Agent 设置',
    ))

    # Skills and MCP are useful capabilities, but neither should make a basic
    # local task impossible. Detect malformed references and surface them as
    # warnings so the user can fix the exact area without losing the core
    # 皇上 → 太子 → 三省六部 workflow.
    skill_issues = []
    for agent in configured_agents:
        configured_skills = agent.get('skills')
        if not isinstance(configured_skills, list):
            continue
        workspace = pathlib.Path(agent.get('workspace') or defaults.get('workspace') or OCLAW_HOME / f'workspace-{agent.get("id")}').expanduser()
        for skill_name in configured_skills:
            if not isinstance(skill_name, str) or not skill_name.strip():
                continue
            skill_path = workspace / 'skills' / skill_name.strip() / 'SKILL.md'
            if not skill_path.is_file():
                skill_issues.append(f'{agent.get("id")}/{skill_name.strip()}')
    mcp_config = config.get('mcp') if isinstance(config.get('mcp'), dict) else {}
    mcp_servers = mcp_config.get('servers') if isinstance(mcp_config.get('servers'), dict) else {}
    mcp_issues = [
        str(name) for name, item in mcp_servers.items()
        if isinstance(item, dict)
        and item.get('enabled', True) is not False
        and not item.get('command') and not item.get('url')
    ]
    checks.append(check(
        'skills', 'Skills', not skill_issues,
        '所有已声明 Skills 均可读取' if not skill_issues else f'以下 Skills 文件不存在：{", ".join(skill_issues[:5])}',
        'tools', target='skills', action_label='打开 Skills 设置', blocking=False,
    ))
    checks.append(check(
        'mcp', 'MCP', not mcp_issues,
        'MCP 配置结构可读取' if not mcp_issues else f'以下 MCP 缺少 command 或 url：{", ".join(mcp_issues[:5])}',
        'tools', target='mcp', action_label='打开 MCP 设置', blocking=False,
    ))

    blockers = sum(1 for item in checks if not item['ready'] and item.get('blocking', True))
    warnings = sum(1 for item in checks if not item['ready'] and not item.get('blocking', True))
    ready_count = sum(1 for item in checks if item['ready'])
    ready = blockers == 0
    check_by_id = {item['id']: item for item in checks}
    core_ids = ['runtime', 'provider', 'secret', 'model', 'agent', 'six_ministries']
    if 'workspace' in check_by_id:
        core_ids.insert(0, 'workspace')
    core_ready = all(check_by_id[item_id]['ready'] for item_id in core_ids if item_id in check_by_id)
    dispatch_ready = check_by_id['dispatch']['ready']
    routes = {
        'board': {
            'ready': core_ready and dispatch_ready,
            'enabled': True,
            'mode': 'external' if dispatch_channel else 'local',
            'detail': '旨意看板可以进入太子分拣和后续三省六部流程。' if core_ready and dispatch_ready else '旨意看板会在执行前被运行保障拦截。',
        },
        'yushufang': {
            'ready': core_ready,
            'enabled': True,
            'mode': 'local',
            'detail': '御书房可以读取 Agent 当前工作会话并实时问询。' if core_ready else '御书房需要先修复本地运行保障。',
        },
        'court': {
            'ready': core_ready,
            'enabled': True,
            'mode': 'local',
            'detail': '朝堂议政可以启动并使用当前 Agent 配置。' if core_ready else '朝堂议政需要先修复本地运行保障。',
        },
        'externalDispatch': {
            'ready': dispatch_ready,
            'enabled': bool(dispatch_channel),
            'mode': 'external' if dispatch_channel else 'disabled',
            'detail': '外部派发已验证。' if dispatch_channel and dispatch_ready else ('外部派发已关闭，使用桌面内置本地派发。' if not dispatch_channel else '外部派发尚未通过渠道与 Gateway 验证。'),
        },
    }
    next_step = '可以开始召见 Agent 或创建任务。' if ready else next((item['detail'] for item in checks if not item['ready'] and item.get('blocking', True)), '请打开执行保障查看提示。')
    return {
        'ok': True,
        'ready': ready,
        'checks': checks,
        'routes': routes,
        'summary': {'total': len(checks), 'ready': ready_count, 'blockers': blockers, 'warnings': warnings},
        'next': next_step,
        'checkedAt': now_iso(),
    }


def repair_readiness(action):
    """Run only app-owned, allowlisted preflight repairs.

    macOS privacy permissions and provider/channel credentials cannot be
    granted silently by an app.  This endpoint therefore repairs the safe
    synchronization step only; the UI sends the user to the exact settings
    surface for anything that needs explicit approval.
    """
    if action != 'sync_runtime':
        return {'ok': False, 'error': '不支持的体检修复操作'}
    script = SCRIPTS / 'sync_agent_config.py'
    if not script.is_file():
        return {'ok': False, 'error': '找不到 Agent 配置同步脚本，请重新检查运行依赖。'}
    try:
        result = subprocess.run(
            [python_bin(), str(script)],
            cwd=str(BASE.parent),
            env=runtime_environment(),
            capture_output=True,
            text=True,
            timeout=15,
        )
    except subprocess.TimeoutExpired:
        return {'ok': False, 'error': 'Agent 配置同步超时，请稍后重试。'}
    except OSError:
        return {'ok': False, 'error': '无法启动 Agent 配置同步，请打开运行依赖设置。'}
    if result.returncode != 0:
        log.warning('执行保障同步失败，退出码=%s', result.returncode)
        return {'ok': False, 'error': 'Agent 配置同步失败，请打开设置查看运行依赖。'}
    return {'ok': True, 'message': '应用内运行配置已同步，请重新检测。', 'readiness': get_readiness()}


def wake_agent(agent_id, message=''):
    """唤醒指定 Agent，发送一条心跳/唤醒消息。"""
    if not _SAFE_NAME_RE.match(agent_id):
        return {'ok': False, 'error': f'agent_id 非法: {agent_id}'}
    if not _check_agent_workspace(agent_id):
        return {'ok': False, 'error': f'{agent_id} 工作空间不存在，请先配置'}
    if not _check_gateway_alive():
        return {'ok': False, 'error': 'Gateway 未启动，请先运行 openclaw gateway start'}

    # agent_id 直接作为 runtime_id（openclaw agents list 中的注册名）
    runtime_id = agent_id
    msg = message or f'🔔 系统心跳检测 — 请回复 OK 确认在线。当前时间: {now_iso()}'

    def do_wake():
        try:
            binary = _resolve_openclaw_bin()
            if not binary:
                raise RuntimeError('OpenClaw 未找到，请在设置中检查运行依赖')
            cmd = [binary, 'agent', '--agent', runtime_id, '-m', msg, '--timeout', '120']
            log.info(f'🔔 唤醒 {agent_id}...')
            # 带重试（最多2次）
            for attempt in range(1, 3):
                result = subprocess.run(cmd, capture_output=True, text=True, timeout=130, env=runtime_environment())
                if result.returncode == 0:
                    log.info(f'✅ {agent_id} 已唤醒')
                    return
                err_msg = result.stderr[:200] if result.stderr else result.stdout[:200]
                log.warning(f'⚠️ {agent_id} 唤醒失败(第{attempt}次): {err_msg}')
                if attempt < 2:
                    import time
                    time.sleep(5)
            log.error(f'❌ {agent_id} 唤醒最终失败')
        except subprocess.TimeoutExpired:
            log.error(f'❌ {agent_id} 唤醒超时(130s)')
        except Exception as e:
            log.warning(f'⚠️ {agent_id} 唤醒异常: {e}')
    threading.Thread(target=do_wake, daemon=True).start()

    return {'ok': True, 'message': f'{agent_id} 唤醒指令已发出，约10-30秒后生效'}


# ══ Agent 实时活动读取 ══

# 状态 → agent_id 映射
_STATE_AGENT_MAP = {
    'Taizi': 'taizi',
    'Zhongshu': 'zhongshu',
    'Menxia': 'menxia',
    'Assigned': 'shangshu',
    'Doing': None,         # 六部，需从 org 推断
    'Review': 'shangshu',
    'Next': None,          # 待执行，从 org 推断
    'Pending': 'zhongshu', # 待处理，默认中书省
}
_SIX_MINISTRY_AGENT_MAP = {
    '礼部': 'libu',
    '户部': 'hubu',
    '兵部': 'bingbu',
    '刑部': 'xingbu',
    '工部': 'gongbu',
    '吏部': 'libu_hr',
}
_SIX_MINISTRY_AGENT_TO_DEPT = {
    agent_id: department for department, agent_id in _SIX_MINISTRY_AGENT_MAP.items()
}
_SIX_MINISTRY_ALIASES = {
    '礼部尚书': '礼部', '户部尚书': '户部', '兵部尚书': '兵部',
    '刑部尚书': '刑部', '工部尚书': '工部', '吏部尚书': '吏部',
    'libu': '礼部', 'hubu': '户部', 'bingbu': '兵部',
    'xingbu': '刑部', 'gongbu': '工部', 'libu_hr': '吏部',
}


def _normalize_six_ministry(value):
    """Normalize a six-ministry label or fixed Agent id to its department."""
    raw = str(value or '').strip()
    if raw in _SIX_MINISTRY_AGENT_MAP:
        return raw
    if raw in _SIX_MINISTRY_ALIASES:
        return _SIX_MINISTRY_ALIASES[raw]
    return _SIX_MINISTRY_ALIASES.get(raw.lower(), '')


def _resolve_execution_assignment(task):
    """Return (department, fixed_agent_id) for a task's execution stage.

    Prefer an explicit targetDept or six-ministry org.  If an older task did
    not persist either field, derive one deterministic primary department
    from its title.  Taizi, Zhongshu, Shangshu and the generic ``六部`` label
    are never treated as execution Agents.
    """
    if not isinstance(task, dict):
        return '', ''
    for candidate in (task.get('targetDept'), task.get('org')):
        department = _normalize_six_ministry(candidate)
        if department:
            return department, _SIX_MINISTRY_AGENT_MAP[department]
    inferred = infer_ministry(task.get('title', ''))
    if inferred in _SIX_MINISTRY_AGENT_MAP:
        return inferred, _SIX_MINISTRY_AGENT_MAP[inferred]
    return '', ''


_ORG_AGENT_MAP = {
    **_SIX_MINISTRY_AGENT_MAP,
    '中书省': 'zhongshu', '门下省': 'menxia', '尚书省': 'shangshu',
}

_TERMINAL_STATES = {'Done', 'Cancelled'}

_DISPATCH_STATUS_LABELS = {
    'idle': '未开始派发',
    'queued': '已排队',
    'dispatching': '派发中',
    'waiting_gateway': '等待 Gateway',
    'running': 'Agent 处理中',
    'success': '已派发',
    'retrying': '重试中',
    'disabled': '自动派发已关闭',
    'cancelled': '已停止',
    'awaiting_assignment': '等待指定六部',
    'not_needed': '无需派发',
    'gateway-offline': 'Gateway 不可用',
    'openclaw-missing': '运行时缺失',
    'timeout': '派发超时',
    'failed': '派发失败',
    'error': '派发异常',
    'completed_no_transition': 'Agent 已返回，等待阶段更新',
}

_DISPATCH_RECOVERY_STATUSES = {
    'idle', 'queued', 'dispatching', 'waiting_gateway', 'running', 'retrying', 'disabled',
}


def _parse_iso(ts):
    if not ts or not isinstance(ts, str):
        return None
    try:
        return datetime.datetime.fromisoformat(ts.replace('Z', '+00:00'))
    except Exception:
        return None


def _ensure_scheduler(task):
    sched = task.setdefault('_scheduler', {})
    if not isinstance(sched, dict):
        sched = {}
        task['_scheduler'] = sched
    sched.setdefault('enabled', True)
    sched.setdefault('stallThresholdSec', 600)
    sched.setdefault('maxRetry', 2)
    sched.setdefault('retryCount', 0)
    sched.setdefault('escalationLevel', 0)
    sched.setdefault('autoRollback', True)
    if not sched.get('lastProgressAt'):
        sched['lastProgressAt'] = task.get('updatedAt') or now_iso()
    if 'stallSince' not in sched:
        sched['stallSince'] = None
    if 'lastDispatchStatus' not in sched:
        sched['lastDispatchStatus'] = 'idle'
    if 'lastDispatchMode' not in sched:
        sched['lastDispatchMode'] = ''
    if 'lastDispatchAgent' not in sched:
        sched['lastDispatchAgent'] = ''
    if 'lastDispatchTrigger' not in sched:
        sched['lastDispatchTrigger'] = ''
    if 'lastDispatchError' not in sched:
        sched['lastDispatchError'] = ''
    if 'dispatchAttemptId' not in sched:
        sched['dispatchAttemptId'] = ''
    if 'dispatchQueuedAt' not in sched:
        sched['dispatchQueuedAt'] = ''
    if 'dispatchStartedAt' not in sched:
        sched['dispatchStartedAt'] = ''
    if 'lastEvent' not in sched:
        sched['lastEvent'] = task.get('now') or '任务已创建'
    if 'lastEventAt' not in sched:
        sched['lastEventAt'] = task.get('updatedAt') or now_iso()
    if 'snapshot' not in sched:
        sched['snapshot'] = {
            'state': task.get('state', ''),
            'org': task.get('org', ''),
            'now': task.get('now', ''),
            'savedAt': now_iso(),
            'note': 'init',
        }
    return sched


def _scheduler_set_event(task, message, status=None, event_at=None):
    sched = task.setdefault('_scheduler', {})
    if status:
        sched['lastDispatchStatus'] = status
    sched['lastEvent'] = str(message or '').strip()[:500]
    sched['lastEventAt'] = event_at or now_iso()


def _scheduler_add_flow(task, remark, to=''):
    event_at = now_iso()
    task.setdefault('flow_log', []).append({
        'at': event_at,
        'kind': 'scheduler',
        'from': '太子调度',
        'to': to or task.get('org', ''),
        'remark': f'🧭 {remark}'
    })
    _scheduler_set_event(task, remark, event_at=event_at)


def _scheduler_snapshot(task, note=''):
    sched = _ensure_scheduler(task)
    sched['snapshot'] = {
        'state': task.get('state', ''),
        'org': task.get('org', ''),
        'now': task.get('now', ''),
        'savedAt': now_iso(),
        'note': note or 'snapshot',
    }


def _scheduler_mark_progress(task, note=''):
    sched = _ensure_scheduler(task)
    sched['lastProgressAt'] = now_iso()
    sched['stallSince'] = None
    sched['retryCount'] = 0
    sched['escalationLevel'] = 0
    sched['rollbackCount'] = 0
    sched['lastEscalatedAt'] = None
    if note:
        _scheduler_add_flow(task, f'进展确认：{note}')


def _resolve_openclaw_bin():
    """Return the OpenClaw CLI path used by dashboard dispatch.

    On Windows, npm-installed CLIs are commonly exposed as .cmd shims.  Using
    shutil.which lets Python resolve that shim before subprocess runs.
    """
    return resolve_openclaw_bin()


def _update_task_scheduler(task_id, updater):
    """Atomically update a task's scheduler state.

    Uses ``modify_task`` to hold the file lock for the entire
    read-modify-write cycle, preventing concurrent dispatch threads and
    the periodic scanner from clobbering each other's writes.
    """
    def _apply(task):
        sched = _ensure_scheduler(task)
        updater(task, sched)

    return modify_task(task_id, _apply)


def _scheduler_public_status(task, sched):
    """Return user-facing dispatch status without exposing provider secrets."""
    status = str(sched.get('lastDispatchStatus') or 'idle')
    label = _DISPATCH_STATUS_LABELS.get(status, status)
    error = str(sched.get('lastDispatchError') or '').strip()
    event = str(sched.get('lastEvent') or task.get('now') or '').strip()

    if status == 'idle' and task.get('state') not in _TERMINAL_STATES:
        detail = '任务已建立，但还没有派发尝试。'
        next_action = 'retry'
    elif status == 'queued':
        detail = '已进入派发队列，等待调度线程启动。'
        next_action = 'wait'
    elif status == 'dispatching':
        detail = '正在准备调用目标 Agent。'
        next_action = 'wait'
    elif status == 'waiting_gateway':
        detail = '正在等待外部 Gateway 响应。'
        next_action = 'check-gateway'
    elif status == 'running':
        detail = '派发进程已启动，等待 Agent 回报任务进展。'
        next_action = 'wait'
    elif status == 'success':
        if sched.get('stateTransitionObserved') is False:
            detail = 'Agent 进程已返回，但尚未写入下一阶段；请查看执行监控中的最后活动，避免重复派发。'
        else:
            detail = '派发命令已返回，等待 Agent 更新任务阶段。'
        next_action = 'wait'
    elif status == 'completed_no_transition':
        detail = 'Agent 进程已返回，但任务仍停留在当前阶段；请查看最后活动或人工推进，避免重复调用。'
        next_action = 'inspect'
    elif status == 'disabled':
        detail = '自动派发当前处于关闭状态，任务不会自动调用 Agent。'
        next_action = 'enable-auto-dispatch'
    elif status == 'cancelled':
        detail = '本次派发已被皇上叫停或取消。'
        next_action = 'resume'
    elif status == 'awaiting_assignment':
        detail = '尚书省尚未指定六部执行部门，尚未调用任何 Agent。'
        next_action = 'assign-department'
    elif status == 'not_needed':
        detail = '当前阶段没有可自动派发的 Agent。'
        next_action = 'manual'
    elif error:
        detail = error
        next_action = 'resume'
    else:
        detail = event or '等待调度结果。'
        next_action = 'retry'

    if task.get('state') == 'Blocked' and error:
        label = '派发失败'
    return {
        'dispatchStatus': status,
        'dispatchStatusLabel': label,
        'dispatchStatusDetail': detail,
        'dispatchNextAction': next_action,
        'dispatchMode': sched.get('lastDispatchMode') or '',
        'lastEvent': event,
        'lastEventAt': sched.get('lastEventAt') or '',
    }


def get_scheduler_state(task_id):
    tasks = load_tasks()
    task = next((t for t in tasks if t.get('id') == task_id), None)
    if not task:
        return {'ok': False, 'error': f'任务 {task_id} 不存在'}
    sched = _ensure_scheduler(task)
    last_progress = _parse_iso(sched.get('lastProgressAt') or task.get('updatedAt'))
    now_dt = datetime.datetime.now(datetime.timezone.utc)
    stalled_sec = 0
    if last_progress:
        stalled_sec = max(0, int((now_dt - last_progress).total_seconds()))
    return {
        'ok': True,
        'taskId': task_id,
        'state': task.get('state', ''),
        'org': task.get('org', ''),
        'scheduler': sched,
        **_scheduler_public_status(task, sched),
        'stalledSec': stalled_sec,
        'checkedAt': now_iso(),
    }


def handle_scheduler_retry(task_id, reason=''):
    # Pre-check before acquiring lock (avoids holding lock for error paths)
    tasks = load_tasks()
    task = next((t for t in tasks if t.get('id') == task_id), None)
    if not task:
        return {'ok': False, 'error': f'任务 {task_id} 不存在'}
    state = task.get('state', '')
    if state in _TERMINAL_STATES or state == 'Blocked':
        return {'ok': False, 'error': f'任务 {task_id} 当前状态 {state} 不支持重试'}

    result = {'retryCount': 0, 'state': state}

    def _apply(task):
        cur = task.get('state', '')
        if cur in _TERMINAL_STATES or cur == 'Blocked':
            return  # state changed between pre-check and lock; skip
        sched = _ensure_scheduler(task)
        sched['retryCount'] = int(sched.get('retryCount') or 0) + 1
        sched['lastRetryAt'] = now_iso()
        sched['lastDispatchTrigger'] = 'taizi-retry'
        _scheduler_add_flow(task, f'触发重试第{sched["retryCount"]}次：{reason or "超时未推进"}')
        result['retryCount'] = sched['retryCount']
        result['state'] = cur

    modify_task(task_id, _apply)

    dispatch_for_state(task_id, task, result['state'], trigger='taizi-retry')
    return {'ok': True, 'message': f'{task_id} 已触发重试派发', 'retryCount': result['retryCount']}


def handle_scheduler_escalate(task_id, reason=''):
    tasks = load_tasks()
    task = next((t for t in tasks if t.get('id') == task_id), None)
    if not task:
        return {'ok': False, 'error': f'任务 {task_id} 不存在'}
    state = task.get('state', '')
    if state in _TERMINAL_STATES:
        return {'ok': False, 'error': f'任务 {task_id} 已结束，无需升级'}

    sched = _ensure_scheduler(task)
    current_level = int(sched.get('escalationLevel') or 0)
    next_level = min(current_level + 1, 2)
    target = 'menxia' if next_level == 1 else 'shangshu'
    target_label = '门下省' if next_level == 1 else '尚书省'

    sched['escalationLevel'] = next_level
    sched['lastEscalatedAt'] = now_iso()
    _scheduler_add_flow(task, f'升级到{target_label}协调：{reason or "任务停滞"}', to=target_label)
    task['updatedAt'] = now_iso()
    save_tasks(tasks)

    msg = (
        f'🧭 太子调度升级通知\n'
        f'任务ID: {task_id}\n'
        f'当前状态: {state}\n'
        f'停滞处理: 请你介入协调推进\n'
        f'原因: {reason or "任务超过阈值未推进"}\n'
        f'⚠️ 看板已有任务，请勿重复创建。'
    )
    wake_agent(target, msg)

    return {'ok': True, 'message': f'{task_id} 已升级至{target_label}', 'escalationLevel': next_level}


def handle_scheduler_rollback(task_id, reason=''):
    # Pre-check before acquiring lock
    tasks = load_tasks()
    task = next((t for t in tasks if t.get('id') == task_id), None)
    if not task:
        return {'ok': False, 'error': f'任务 {task_id} 不存在'}
    sched = _ensure_scheduler(task)
    snapshot = sched.get('snapshot') or {}
    snap_state = snapshot.get('state')
    if not snap_state:
        return {'ok': False, 'error': f'任务 {task_id} 无可用回滚快照'}

    result = {'snap_state': snap_state}

    def _apply(task):
        sched = _ensure_scheduler(task)
        snapshot = sched.get('snapshot') or {}
        s_state = snapshot.get('state')
        if not s_state:
            return  # snapshot cleared between pre-check and lock
        old_state = task.get('state', '')
        task['state'] = s_state
        task['org'] = snapshot.get('org', task.get('org', ''))
        task['now'] = f'↩️ 太子调度自动回滚：{reason or "恢复到上个稳定节点"}'
        task['block'] = '无'
        sched['retryCount'] = 0
        sched['escalationLevel'] = 0
        sched['stallSince'] = None
        sched['lastProgressAt'] = now_iso()
        _scheduler_add_flow(task, f'执行回滚：{old_state} → {s_state}，原因：{reason or "停滞恢复"}')
        result['snap_state'] = s_state

    modify_task(task_id, _apply)

    if result['snap_state'] not in _TERMINAL_STATES:
        dispatch_for_state(task_id, task, result['snap_state'], trigger='taizi-rollback')

    return {'ok': True, 'message': f'{task_id} 已回滚到 {result["snap_state"]}'}


def handle_scheduler_scan(threshold_sec=600):
    """Periodic stall scanner — runs in a background thread.

    Uses ``modify_tasks`` to hold the file lock during the mutation phase,
    preventing concurrent dispatch callbacks and HTTP handlers from
    clobbering each other's writes (fixes TOCTOU race between the old
    ``load_tasks()`` / ``save_tasks()`` pair).

    Side-effects (dispatch, escalation wake) are executed *after* the lock
    is released so they don't block other writers.
    """
    threshold_sec = max(60, int(threshold_sec or 600))
    if not _auto_dispatch_enabled():
        return {
            'ok': True,
            'disabled': True,
            'thresholdSec': threshold_sec,
            'actions': [],
            'count': 0,
            'checkedAt': now_iso(),
        }
    now_dt = datetime.datetime.now(datetime.timezone.utc)
    # Collect dispatch/escalation work to execute after the lock is released
    pending_retries = []
    pending_escalates = []
    pending_rollbacks = []
    actions = []

    def _scan(tasks):
        changed = False
        for task in tasks:
            task_id = task.get('id', '')
            state = task.get('state', '')
            if not task_id or state in _TERMINAL_STATES or task.get('archived'):
                continue
            if state == 'Blocked':
                continue

            sched = _ensure_scheduler(task)
            task_threshold = int(sched.get('stallThresholdSec') or threshold_sec)
            last_progress = _parse_iso(sched.get('lastProgressAt') or task.get('updatedAt'))
            if not last_progress:
                continue
            stalled_sec = max(0, int((now_dt - last_progress).total_seconds()))
            if stalled_sec < task_threshold:
                continue

            if not sched.get('stallSince'):
                sched['stallSince'] = now_iso()
                changed = True

            retry_count = int(sched.get('retryCount') or 0)
            max_retry = max(0, int(sched.get('maxRetry') or 1))
            level = int(sched.get('escalationLevel') or 0)

            if retry_count < max_retry:
                sched['retryCount'] = retry_count + 1
                sched['lastRetryAt'] = now_iso()
                sched['lastDispatchTrigger'] = 'taizi-scan-retry'
                _scheduler_add_flow(task, f'停滞{stalled_sec}秒，触发自动重试第{sched["retryCount"]}次')
                pending_retries.append((task_id, state))
                actions.append({'taskId': task_id, 'action': 'retry', 'stalledSec': stalled_sec})
                changed = True
                continue

            if level < 2:
                next_level = level + 1
                target = 'menxia' if next_level == 1 else 'shangshu'
                target_label = '门下省' if next_level == 1 else '尚书省'
                sched['escalationLevel'] = next_level
                sched['lastEscalatedAt'] = now_iso()
                _scheduler_add_flow(task, f'停滞{stalled_sec}秒，升级至{target_label}协调', to=target_label)
                pending_escalates.append((task_id, state, target, target_label, stalled_sec))
                actions.append({'taskId': task_id, 'action': 'escalate', 'to': target_label, 'stalledSec': stalled_sec})
                changed = True
                continue

            if sched.get('autoRollback', True):
                rollback_count = int(sched.get('rollbackCount') or 0)
                max_rollback = int(sched.get('maxRollback') or 3)
                snapshot = sched.get('snapshot') or {}
                snap_state = snapshot.get('state')
                if rollback_count >= max_rollback:
                    if state != 'Blocked':
                        task['state'] = 'Blocked'
                        task['now'] = f'🚫 连续回滚{rollback_count}次仍无法推进，已自动挂起'
                        task['block'] = f'连续停滞且回滚{rollback_count}次均失败，需人工介入'
                        sched['stallSince'] = None
                        _scheduler_add_flow(task, f'连续回滚{rollback_count}次，自动挂起等待人工介入')
                        actions.append({'taskId': task_id, 'action': 'blocked', 'reason': f'max rollback {rollback_count}'})
                        changed = True
                elif snap_state and snap_state != state:
                    old_state = state
                    task['state'] = snap_state
                    task['org'] = snapshot.get('org', task.get('org', ''))
                    task['now'] = '↩️ 太子调度自动回滚到稳定节点'
                    task['block'] = '无'
                    sched['retryCount'] = 0
                    sched['escalationLevel'] = 0
                    sched['rollbackCount'] = rollback_count + 1
                    sched['stallSince'] = None
                    sched['lastProgressAt'] = now_iso()
                    _scheduler_add_flow(task, f'连续停滞，自动回滚：{old_state} → {snap_state}（第{rollback_count + 1}次）')
                    pending_rollbacks.append((task_id, snap_state))
                    actions.append({'taskId': task_id, 'action': 'rollback', 'toState': snap_state})
                    changed = True

        return tasks  # always return — atomic_json_update requires it

    modify_tasks(_scan)

    # --- Side-effects: dispatch & escalation (outside the file lock) ---

    # Re-read tasks for dispatch context (the task objects from _scan are
    # no longer held under the lock, but dispatch only needs id + state +
    # title which are immutable at this point).
    tasks = load_tasks()

    for task_id, state in pending_retries:
        retry_task = next((t for t in tasks if t.get('id') == task_id), None)
        if retry_task:
            dispatch_for_state(task_id, retry_task, state, trigger='taizi-scan-retry')

    for task_id, state, target, target_label, stalled_sec in pending_escalates:
        msg = (
            f'🧭 太子调度升级通知\n'
            f'任务ID: {task_id}\n'
            f'当前状态: {state}\n'
            f'已停滞: {stalled_sec} 秒\n'
            f'请立即介入协调推进\n'
            f'⚠️ 看板已有任务，请勿重复创建。'
        )
        wake_agent(target, msg)

    for task_id, state in pending_rollbacks:
        rollback_task = next((t for t in tasks if t.get('id') == task_id), None)
        if rollback_task and state not in _TERMINAL_STATES:
            dispatch_for_state(task_id, rollback_task, state, trigger='taizi-auto-rollback')

    return {
        'ok': True,
        'thresholdSec': threshold_sec,
        'actions': actions,
        'count': len(actions),
        'checkedAt': now_iso(),
    }


def _startup_recover_queued_dispatches():
    """服务启动后恢复没有完成派发的活动任务。

    除了进程中断留下的 ``queued``，还要处理旧版本或手动模式留下
    的 ``idle``。这些任务不能继续显示成“等待太子接旨”，否则用户看不
    出 Agent 根本没有被调用。
    """
    if not _auto_dispatch_enabled():
        log.info('⏸️ 手动模式：跳过启动恢复和 Agent 自动派发')
        return
    tasks = load_tasks()
    recovered = 0
    for task in tasks:
        task_id = task.get('id', '')
        state = task.get('state', '')
        if not task_id or state in _TERMINAL_STATES | {'Blocked'} or task.get('archived'):
            continue
        sched = task.get('_scheduler') or {}
        status = sched.get('lastDispatchStatus', 'idle')
        if status not in _DISPATCH_RECOVERY_STATUSES:
            continue
        with _ACTIVE_DISPATCH_LOCK:
            if task_id in _ACTIVE_DISPATCHES:
                continue
        log.info(f'🔄 启动恢复: {task_id} 状态={state} 调度状态={status}，重新派发')
        dispatch_for_state(task_id, task, state, trigger='startup-recovery')
        recovered += 1
    if recovered:
        log.info(f'✅ 启动恢复完成: 重新派发 {recovered} 个任务')
    else:
        log.info(f'✅ 启动恢复: 无需恢复')


def handle_repair_flow_order():
    """修复历史任务中首条流转为“皇上->中书省”的错序问题。"""
    tasks = load_tasks()
    fixed = 0
    fixed_ids = []

    for task in tasks:
        task_id = task.get('id', '')
        if not task_id.startswith('JJC-'):
            continue
        flow_log = task.get('flow_log') or []
        if not flow_log:
            continue

        first = flow_log[0]
        if first.get('from') != '皇上' or first.get('to') != '中书省':
            continue

        first['to'] = '太子'
        remark = first.get('remark', '')
        if isinstance(remark, str) and remark.startswith('下旨：'):
            first['remark'] = remark

        if task.get('state') == 'Zhongshu' and task.get('org') == '中书省' and len(flow_log) == 1:
            task['state'] = 'Taizi'
            task['org'] = '太子'
            task['now'] = '等待太子接旨分拣'

        task['updatedAt'] = now_iso()
        fixed += 1
        fixed_ids.append(task_id)

    if fixed:
        save_tasks(tasks)

    return {
        'ok': True,
        'count': fixed,
        'taskIds': fixed_ids[:80],
        'more': max(0, fixed - 80),
        'checkedAt': now_iso(),
    }


def _collect_message_text(msg):
    """收集消息中的可检索文本，用于 task_id/关键词过滤。"""
    if not isinstance(msg, dict):
        return ''
    parts = []
    for c in msg.get('content', []) or []:
        if not isinstance(c, dict):
            continue
        ctype = c.get('type')
        if ctype == 'text' and c.get('text'):
            parts.append(str(c.get('text', '')))
        elif ctype == 'thinking' and c.get('thinking'):
            parts.append(str(c.get('thinking', '')))
        elif ctype == 'tool_use':
            parts.append(json.dumps(c.get('input', {}), ensure_ascii=False))
    details = msg.get('details') or {}
    for key in ('output', 'stdout', 'stderr', 'message'):
        val = details.get(key)
        if isinstance(val, str) and val:
            parts.append(val)
    return ''.join(parts)


def _parse_activity_entry(item):
    """将 session jsonl 的 message 统一解析成看板活动条目。"""
    if not isinstance(item, dict):
        return None
    msg = item.get('message') or {}
    if not isinstance(msg, dict):
        return None
    role = str(msg.get('role', '')).strip().lower()
    ts = item.get('timestamp', '')

    if role == 'assistant':
        text = ''
        thinking = ''
        tool_calls = []
        for c in msg.get('content', []) or []:
            if not isinstance(c, dict):
                continue
            if c.get('type') == 'text' and c.get('text') and not text:
                text = str(c.get('text', '')).strip()
            elif c.get('type') == 'thinking' and c.get('thinking') and not thinking:
                thinking = str(c.get('thinking', '')).strip()[:200]
            elif c.get('type') == 'tool_use':
                tool_calls.append({
                    'name': c.get('name', ''),
                    'input_preview': json.dumps(c.get('input', {}), ensure_ascii=False)[:100]
                })
        if not (text or thinking or tool_calls):
            return None
        entry = {'at': ts, 'kind': 'assistant'}
        if text:
            entry['text'] = text[:300]
        if thinking:
            entry['thinking'] = thinking
        if tool_calls:
            entry['tools'] = tool_calls
        return entry

    if role in ('toolresult', 'tool_result'):
        details = msg.get('details') or {}
        code = details.get('exitCode')
        if code is None:
            code = details.get('code', details.get('status'))
        output = ''
        for c in msg.get('content', []) or []:
            if not isinstance(c, dict):
                continue
            if c.get('type') == 'text' and c.get('text'):
                output = str(c.get('text', '')).strip()[:200]
                break
        if not output:
            for key in ('output', 'stdout', 'stderr', 'message'):
                val = details.get(key)
                if isinstance(val, str) and val.strip():
                    output = val.strip()[:200]
                    break

        entry = {
            'at': ts,
            'kind': 'tool_result',
            'tool': msg.get('toolName', msg.get('name', '')),
            'exitCode': code,
            'output': output,
        }
        duration_ms = details.get('durationMs')
        if isinstance(duration_ms, (int, float)):
            entry['durationMs'] = int(duration_ms)
        return entry

    if role == 'user':
        text = ''
        for c in msg.get('content', []) or []:
            if not isinstance(c, dict):
                continue
            if c.get('type') == 'text' and c.get('text'):
                text = str(c.get('text', '')).strip()
                break
        if not text:
            return None
        return {'at': ts, 'kind': 'user', 'text': text[:200]}

    return None


def _agent_session_files(agent_id):
    """Canonical session indexes also reference task-scoped local transcripts."""
    sessions_dir = OCLAW_HOME / 'agents' / agent_id / 'sessions'
    files = set(sessions_dir.glob('*.jsonl'))
    store = read_json(sessions_dir / 'sessions.json', {})
    allowed_roots = [OCLAW_HOME.resolve(), (DATA / 'dispatch-sessions').resolve()]
    for entry in store.values() if isinstance(store, dict) else []:
        if not isinstance(entry, dict) or not isinstance(entry.get('sessionFile'), str):
            continue
        file = pathlib.Path(entry['sessionFile'])
        if file.is_file() and not file.is_symlink() and any(file.resolve().is_relative_to(root) for root in allowed_roots):
            files.add(file)
    return sorted((file for file in files if not file.name.endswith('.trajectory.jsonl')),
                  key=lambda file: file.stat().st_mtime, reverse=True)


def get_agent_activity(agent_id, limit=30, task_id=None):
    """从 Agent 的 session jsonl 读取最近活动。
    如果 task_id 不为空，只返回提及该 task_id 的相关条目。
    """
    sessions_dir = OCLAW_HOME / 'agents' / agent_id / 'sessions'
    if not sessions_dir.exists():
        return []

    # 扫描所有 jsonl（按修改时间倒序），优先最新
    jsonl_files = _agent_session_files(agent_id)
    if not jsonl_files:
        return []

    entries = []
    # 如果需要按 task_id 过滤，可能需要扫描多个文件
    files_to_scan = jsonl_files[:3] if task_id else jsonl_files[:1]

    for session_file in files_to_scan:
        try:
            lines = session_file.read_text(errors='ignore').splitlines()
        except Exception:
            continue

        # 正向扫描以保持时间顺序；如果有 task_id，收集提及 task_id 的条目
        for ln in lines:
            try:
                item = json.loads(ln)
            except Exception:
                continue
            if not isinstance(item, dict):
                continue
            msg = item.get('message') or {}
            if not isinstance(msg, dict):
                continue
            all_text = _collect_message_text(msg)

            # task_id 过滤：只保留提及 task_id 的条目
            if task_id and task_id not in all_text:
                continue
            entry = _parse_activity_entry(item)
            if entry:
                entries.append(entry)

            if len(entries) >= limit:
                break
        if len(entries) >= limit:
            break

    # 只保留最后 limit 条
    return entries[-limit:]


def _extract_keywords(title):
    """从任务标题中提取有意义的关键词（用于 session 内容匹配）。"""
    stop = {'的', '了', '在', '是', '有', '和', '与', '或', '一个', '一篇', '关于', '进行',
            '写', '做', '请', '把', '给', '用', '要', '需要', '面向', '风格', '包含',
            '出', '个', '不', '可以', '应该', '如何', '怎么', '什么', '这个', '那个'}
    # 提取英文词
    en_words = re.findall(r'[a-zA-Z][\w.-]{1,}', title)
    # 提取 2-4 字中文词组（更短的颗粒度）
    cn_words = re.findall(r'[\u4e00-\u9fff]{2,4}', title)
    all_words = en_words + cn_words
    kws = [w for w in all_words if w not in stop and len(w) >= 2]
    # 去重保序
    seen = set()
    unique = []
    for w in kws:
        if w.lower() not in seen:
            seen.add(w.lower())
            unique.append(w)
    return unique[:8]  # 最多 8 个关键词


def get_agent_activity_by_keywords(agent_id, keywords, limit=20):
    """从 agent session 中按关键词匹配获取活动条目。
    找到包含关键词的 session 文件，只读该文件的活动。
    """
    sessions_dir = OCLAW_HOME / 'agents' / agent_id / 'sessions'
    if not sessions_dir.exists():
        return []

    jsonl_files = _agent_session_files(agent_id)
    if not jsonl_files:
        return []

    # 找到包含关键词的 session 文件
    target_file = None
    for sf in jsonl_files[:5]:
        try:
            content = sf.read_text(errors='ignore')
        except Exception:
            continue
        hits = sum(1 for kw in keywords if kw.lower() in content.lower())
        if hits >= min(2, len(keywords)):
            target_file = sf
            break

    if not target_file:
        return []

    # 解析 session 文件，按 user 消息分割为对话段
    # 找到包含关键词的对话段，只返回该段的活动
    try:
        lines = target_file.read_text(errors='ignore').splitlines()
    except Exception:
        return []

    # 第一遍：找到关键词匹配的 user 消息位置
    user_msg_indices = []  # (line_index, user_text)
    for i, ln in enumerate(lines):
        try:
            item = json.loads(ln)
        except Exception:
            continue
        if not isinstance(item, dict):
            continue
        msg = item.get('message') or {}
        if not isinstance(msg, dict):
            continue
        if msg.get('role') == 'user':
            text = ''
            for c in msg.get('content', []):
                if not isinstance(c, dict):
                    continue
                if c.get('type') == 'text' and c.get('text'):
                    text += c['text']
            user_msg_indices.append((i, text))

    # 找到与关键词匹配度最高的 user 消息
    best_idx = -1
    best_hits = 0
    for line_idx, utext in user_msg_indices:
        hits = sum(1 for kw in keywords if kw.lower() in utext.lower())
        if hits > best_hits:
            best_hits = hits
            best_idx = line_idx

    # 确定对话段的行范围：从匹配的 user 消息到下一个 user 消息之前
    if best_idx >= 0 and best_hits >= min(2, len(keywords)):
        # 找下一个 user 消息的位置
        next_user_idx = len(lines)
        for line_idx, _ in user_msg_indices:
            if line_idx > best_idx:
                next_user_idx = line_idx
                break
        start_line = best_idx
        end_line = next_user_idx
    else:
        # 没找到匹配的对话段，返回空
        return []

    # 第二遍：只解析对话段内的行
    entries = []
    for ln in lines[start_line:end_line]:
        try:
            item = json.loads(ln)
        except Exception:
            continue
        if not isinstance(item, dict):
            continue
        entry = _parse_activity_entry(item)
        if entry:
            entries.append(entry)

    return entries[-limit:]


def get_agent_latest_segment(agent_id, limit=20):
    """获取 Agent 最新一轮对话段（最后一条 user 消息起的所有内容）。
    用于活跃任务没有精确匹配时，展示 Agent 的实时工作状态。
    """
    sessions_dir = OCLAW_HOME / 'agents' / agent_id / 'sessions'
    if not sessions_dir.exists():
        return []

    jsonl_files = sorted(sessions_dir.glob('*.jsonl'),
                         key=lambda f: f.stat().st_mtime, reverse=True)
    if not jsonl_files:
        return []

    # 读取最新的 session 文件
    target_file = jsonl_files[0]
    try:
        lines = target_file.read_text(errors='ignore').splitlines()
    except Exception:
        return []

    # 找到最后一条 user 消息的行号
    last_user_idx = -1
    for i, ln in enumerate(lines):
        try:
            item = json.loads(ln)
        except Exception:
            continue
        if not isinstance(item, dict):
            continue
        msg = item.get('message') or {}
        if not isinstance(msg, dict):
            continue
        if msg.get('role') == 'user':
            last_user_idx = i

    if last_user_idx < 0:
        return []

    # 从最后一条 user 消息开始，解析到文件末尾
    entries = []
    for ln in lines[last_user_idx:]:
        try:
            item = json.loads(ln)
        except Exception:
            continue
        if not isinstance(item, dict):
            continue
        entry = _parse_activity_entry(item)
        if entry:
            entries.append(entry)

    return entries[-limit:]


def _compute_phase_durations(flow_log):
    """从 flow_log 计算每个阶段的停留时长。"""
    if not flow_log or len(flow_log) < 1:
        return []
    phases = []
    for i, fl in enumerate(flow_log):
        start_at = fl.get('at', '')
        to_dept = fl.get('to', '')
        remark = fl.get('remark', '')
        # 下一阶段的起始时间就是本阶段的结束时间
        if i + 1 < len(flow_log):
            end_at = flow_log[i + 1].get('at', '')
            ongoing = False
        else:
            end_at = now_iso()
            ongoing = True
        # 计算时长
        dur_sec = 0
        try:
            from_dt = datetime.datetime.fromisoformat(start_at.replace('Z', '+00:00'))
            to_dt = datetime.datetime.fromisoformat(end_at.replace('Z', '+00:00'))
            dur_sec = max(0, int((to_dt - from_dt).total_seconds()))
        except Exception:
            pass
        # 人类可读时长
        if dur_sec < 60:
            dur_text = f'{dur_sec}秒'
        elif dur_sec < 3600:
            dur_text = f'{dur_sec // 60}分{dur_sec % 60}秒'
        elif dur_sec < 86400:
            h, rem = divmod(dur_sec, 3600)
            dur_text = f'{h}小时{rem // 60}分'
        else:
            d, rem = divmod(dur_sec, 86400)
            dur_text = f'{d}天{rem // 3600}小时'
        phases.append({
            'phase': to_dept,
            'from': start_at,
            'to': end_at,
            'durationSec': dur_sec,
            'durationText': dur_text,
            'ongoing': ongoing,
            'remark': remark,
        })
    return phases


def _compute_todos_summary(todos):
    """计算 todos 完成率汇总。"""
    if not todos:
        return None
    total = len(todos)
    completed = sum(1 for t in todos if t.get('status') == 'completed')
    in_progress = sum(1 for t in todos if t.get('status') == 'in-progress')
    not_started = total - completed - in_progress
    percent = round(completed / total * 100) if total else 0
    return {
        'total': total,
        'completed': completed,
        'inProgress': in_progress,
        'notStarted': not_started,
        'percent': percent,
    }


def _compute_todos_diff(prev_todos, curr_todos):
    """计算两个 todos 快照之间的差异。"""
    prev_map = {str(t.get('id', '')): t for t in (prev_todos or [])}
    curr_map = {str(t.get('id', '')): t for t in (curr_todos or [])}
    changed, added, removed = [], [], []
    for tid, ct in curr_map.items():
        if tid in prev_map:
            pt = prev_map[tid]
            if pt.get('status') != ct.get('status'):
                changed.append({
                    'id': tid, 'title': ct.get('title', ''),
                    'from': pt.get('status', ''), 'to': ct.get('status', ''),
                })
        else:
            added.append({'id': tid, 'title': ct.get('title', '')})
    for tid, pt in prev_map.items():
        if tid not in curr_map:
            removed.append({'id': tid, 'title': pt.get('title', '')})
    if not changed and not added and not removed:
        return None
    return {'changed': changed, 'added': added, 'removed': removed}


def get_task_activity(task_id):
    """获取任务的实时进展数据。
    数据来源：
    1. 任务自身的 now / todos / flow_log 字段（由 Agent 通过 progress 命令主动上报）
    2. Agent session JSONL 中的对话日志（thinking / tool_result / user，用于展示思考过程）

    增强字段:
    - taskMeta: 任务元信息 (title/state/org/output/block/priority/reviewRound/archived)
    - phaseDurations: 各阶段停留时长
    - todosSummary: todos 完成率汇总
    - resourceSummary: Agent 资源消耗汇总 (tokens/cost/elapsed)
    - activity 条目中 progress/todos 保留 state/org 快照
    - activity 中 todos 条目含 diff 字段
    """
    tasks = load_tasks()
    task = next((t for t in tasks if t.get('id') == task_id), None)
    if not task:
        return {'ok': False, 'error': f'任务 {task_id} 不存在'}

    state = task.get('state', '')
    org = task.get('org', '')
    now_text = task.get('now', '')
    todos = task.get('todos', [])
    updated_at = task.get('updatedAt', '')

    # ── 任务元信息 ──
    task_meta = {
        'title': task.get('title', ''),
        'state': state,
        'org': org,
        'output': task.get('output', ''),
        'block': task.get('block', ''),
        'priority': task.get('priority', 'normal'),
        'reviewRound': task.get('review_round', 0),
        'archived': task.get('archived', False),
    }

    # 当前负责 Agent（兼容旧逻辑）。六部阶段必须从明确的执行部门解析，
    # 不再把无法识别的记录交回中书省或伪装成“无数据”。
    agent_id = _STATE_AGENT_MAP.get(state)
    if agent_id is None and state in ('Doing', 'Next'):
        _, agent_id = _resolve_execution_assignment(task)

    # ── 构建活动条目列表（flow_log + progress_log）──
    activity = []
    flow_log = task.get('flow_log', [])

    # 1. flow_log 转为活动条目
    for fl in flow_log:
        activity.append({
            'at': fl.get('at', ''),
            'kind': 'flow',
            'scheduler': fl.get('kind') == 'scheduler' or fl.get('from') == '太子调度',
            'from': fl.get('from', ''),
            'to': fl.get('to', ''),
            'remark': fl.get('remark', ''),
        })

    progress_log = task.get('progress_log', [])
    related_agents = set()

    # 资源消耗累加
    total_tokens = 0
    total_cost = 0.0
    total_elapsed = 0
    has_resource_data = False

    # 用于 todos diff 计算
    prev_todos_snapshot = None

    if progress_log:
        # 2. 多 Agent 实时进展日志（每条 progress 都保留自己的 todo 快照）
        for pl in progress_log:
            p_at = pl.get('at', '')
            p_agent = pl.get('agent', '')
            p_text = pl.get('text', '')
            p_todos = pl.get('todos', [])
            p_state = pl.get('state', '')
            p_org = pl.get('org', '')
            if p_agent:
                related_agents.add(p_agent)
            # 累加资源消耗
            if pl.get('tokens'):
                total_tokens += pl['tokens']
                has_resource_data = True
            if pl.get('cost'):
                total_cost += pl['cost']
                has_resource_data = True
            if pl.get('elapsed'):
                total_elapsed += pl['elapsed']
                has_resource_data = True
            if p_text:
                entry = {
                    'at': p_at,
                    'kind': 'progress',
                    'text': p_text,
                    'agent': p_agent,
                    'agentLabel': pl.get('agentLabel', ''),
                    'state': p_state,
                    'org': p_org,
                }
                # 单条资源数据
                if pl.get('tokens'):
                    entry['tokens'] = pl['tokens']
                if pl.get('cost'):
                    entry['cost'] = pl['cost']
                if pl.get('elapsed'):
                    entry['elapsed'] = pl['elapsed']
                activity.append(entry)
            if p_todos:
                todos_entry = {
                    'at': p_at,
                    'kind': 'todos',
                    'items': p_todos,
                    'agent': p_agent,
                    'agentLabel': pl.get('agentLabel', ''),
                    'state': p_state,
                    'org': p_org,
                }
                # 计算 diff
                diff = _compute_todos_diff(prev_todos_snapshot, p_todos)
                if diff:
                    todos_entry['diff'] = diff
                activity.append(todos_entry)
                prev_todos_snapshot = p_todos

        # 仅当无法通过状态确定 Agent 时，才回退到最后一次上报的 Agent
        if not agent_id:
            last_pl = progress_log[-1]
            if last_pl.get('agent'):
                agent_id = last_pl.get('agent')
    else:
        # 兼容旧数据：仅使用 now/todos
        if now_text:
            activity.append({
                'at': updated_at,
                'kind': 'progress',
                'text': now_text,
                'agent': agent_id or '',
                'state': state,
                'org': org,
            })
        if todos:
            activity.append({
                'at': updated_at,
                'kind': 'todos',
                'items': todos,
                'agent': agent_id or '',
                'state': state,
                'org': org,
            })

    # 按时间排序，保证流转/进展穿插正确
    activity.sort(key=lambda x: x.get('at', ''))

    if agent_id:
        related_agents.add(agent_id)

    # ── 融合 Agent Session 活动（thinking / tool_result / user）──
    # 从 session JSONL 中提取 Agent 的思考过程和工具调用记录
    try:
        session_entries = []
        # 活跃任务：尝试按 task_id 精确匹配
        if state not in ('Done', 'Cancelled'):
            if agent_id:
                entries = get_agent_activity(agent_id, limit=30, task_id=task_id)
                session_entries.extend(entries)
            # 也从其他相关 Agent 获取
            for ra in related_agents:
                if ra != agent_id:
                    entries = get_agent_activity(ra, limit=20, task_id=task_id)
                    session_entries.extend(entries)
        else:
            # 已完成任务：基于关键词匹配
            title = task.get('title', '')
            keywords = _extract_keywords(title)
            if keywords:
                agents_to_scan = list(related_agents) if related_agents else ([agent_id] if agent_id else [])
                for ra in agents_to_scan[:5]:
                    entries = get_agent_activity_by_keywords(ra, keywords, limit=15)
                    session_entries.extend(entries)
        # 去重（通过 at+kind 去重避免重复）
        existing_keys = {(a.get('at', ''), a.get('kind', '')) for a in activity}
        for se in session_entries:
            key = (se.get('at', ''), se.get('kind', ''))
            if key not in existing_keys:
                activity.append(se)
                existing_keys.add(key)
        # 重新排序
        activity.sort(key=lambda x: x.get('at', ''))
    except Exception as e:
        log.warning(f'Session JSONL 融合失败 (task={task_id}): {e}')

    # ── 阶段耗时统计 ──
    phase_durations = _compute_phase_durations(flow_log)

    # ── Todos 汇总 ──
    todos_summary = _compute_todos_summary(todos)

    # ── 总耗时（首条 flow_log 到最后一条/当前） ──
    total_duration = None
    if flow_log:
        try:
            first_at = datetime.datetime.fromisoformat(flow_log[0].get('at', '').replace('Z', '+00:00'))
            if state in ('Done', 'Cancelled') and len(flow_log) >= 2:
                last_at = datetime.datetime.fromisoformat(flow_log[-1].get('at', '').replace('Z', '+00:00'))
            else:
                last_at = datetime.datetime.now(datetime.timezone.utc)
            dur = max(0, int((last_at - first_at).total_seconds()))
            if dur < 60:
                total_duration = f'{dur}秒'
            elif dur < 3600:
                total_duration = f'{dur // 60}分{dur % 60}秒'
            elif dur < 86400:
                h, rem = divmod(dur, 3600)
                total_duration = f'{h}小时{rem // 60}分'
            else:
                d, rem = divmod(dur, 86400)
                total_duration = f'{d}天{rem // 3600}小时'
        except Exception:
            pass

    last_active = None
    if updated_at:
        try:
            dt = _parse_iso(updated_at)
            if dt:
                last_active = dt.astimezone().strftime('%Y-%m-%d %H:%M:%S')
            else:
                last_active = updated_at[:19].replace('T', ' ')
        except Exception:
            last_active = updated_at[:19].replace('T', ' ')

    result = {
        'ok': True,
        'taskId': task_id,
        'taskMeta': task_meta,
        'agentId': agent_id,
        'agentLabel': _STATE_LABELS.get(state, state),
        'lastActive': last_active,
        'activity': activity,
        'activitySource': 'progress+session',
        'relatedAgents': sorted(list(related_agents)),
        'phaseDurations': phase_durations,
        'totalDuration': total_duration,
    }
    if todos_summary:
        result['todosSummary'] = todos_summary
    if has_resource_data:
        result['resourceSummary'] = {
            'totalTokens': total_tokens,
            'totalCost': round(total_cost, 4),
            'totalElapsedSec': total_elapsed,
        }
    return result


# 状态推进顺序（手动推进用）
_STATE_FLOW = {
    'Pending':  ('Taizi', '皇上', '太子', '待处理旨意转交太子分拣'),
    'Taizi':    ('Zhongshu', '太子', '中书省', '太子分拣完毕，转中书省起草'),
    'Zhongshu': ('Menxia', '中书省', '门下省', '中书省方案提交门下省审议'),
    'Menxia':   ('Assigned', '门下省', '尚书省', '门下省准奏，转尚书省派发'),
    'Assigned': ('Doing', '尚书省', '六部', '尚书省开始派发执行'),
    'Next':     ('Doing', '尚书省', '六部', '待执行任务开始执行'),
    'Doing':    ('Review', '六部', '尚书省', '各部完成，进入汇总'),
    'Review':   ('Done', '尚书省', '太子', '全流程完成，回奏太子转报皇上'),
}
_STATE_LABELS = {
    'Pending': '待处理', 'Taizi': '太子', 'Zhongshu': '中书省', 'Menxia': '门下省',
    'Assigned': '尚书省', 'Next': '待执行', 'Doing': '执行中', 'Review': '审查', 'Done': '完成',
}


def _mark_waiting_for_execution_assignment(task, sched, trigger='state-transition'):
    """Keep a task at 尚书省 until one of the six departments is selected."""
    reason = '尚书省尚未指定六部执行部门，未调用 Agent。'
    previous_state = task.get('state', '')
    if previous_state in {'Doing', 'Next'}:
        task['_prev_state'] = 'Assigned'
    task['state'] = 'Assigned'
    task['org'] = '尚书省'
    task['block'] = '无'
    task['now'] = f'⏳ {reason}'
    task['dispatchAssignmentRequired'] = True
    task['dispatchAssignmentError'] = reason
    sched.update({
        'lastDispatchAt': now_iso(),
        'lastDispatchStatus': 'awaiting_assignment',
        'lastDispatchMode': '',
        'lastDispatchAgent': '',
        'lastDispatchTrigger': trigger,
        'lastDispatchError': '',
        'dispatchAttemptId': '',
        'dispatchQueuedAt': '',
        'dispatchStartedAt': '',
    })
    _scheduler_set_event(task, reason, status='awaiting_assignment')
    _scheduler_add_flow(task, reason, to='尚书省')


def _hold_for_execution_assignment(task_id, new_state, trigger='state-transition'):
    """Repair an invalid execution-stage record without invoking any Agent."""
    def _apply(task, sched):
        if task.get('state') not in {new_state, 'Doing', 'Next'}:
            return
        _mark_waiting_for_execution_assignment(task, sched, trigger)

    return _update_task_scheduler(task_id, _apply)


def dispatch_for_state(task_id, task, new_state, trigger='state-transition'):
    """推进/审批后自动派发对应 Agent（后台异步，不阻塞响应）。"""
    execution_department = ''
    execution_agent = ''
    if new_state in ('Doing', 'Next'):
        execution_department, execution_agent = _resolve_execution_assignment(task)
        if not execution_agent:
            log.error(f'⛔ {task_id} 无法解析六部执行 Agent，拒绝盲目派发')
            _hold_for_execution_assignment(task_id, new_state, trigger=trigger)
            return
    if not _auto_dispatch_enabled():
        log.info(f'⏸️ {task_id} 自动派发已关闭（手动模式）')
        reason = '自动派发已关闭（手动模式）'
        _update_task_scheduler(task_id, lambda t, s: (
            s.update({
                'lastDispatchAt': '',
                'lastDispatchStatus': 'disabled',
                'lastDispatchMode': 'disabled',
                'lastDispatchAgent': '',
                'lastDispatchTrigger': trigger,
                'lastDispatchError': reason,
                'dispatchAttemptId': '',
                'dispatchQueuedAt': '',
                'dispatchStartedAt': '',
            }),
            t.update({'now': f'⏸️ {reason}'}) if t.get('state') == new_state else None,
            _scheduler_set_event(t, reason, status='disabled'),
            _scheduler_add_flow(t, reason, to=t.get('org', '')),
        ))
        return
    agent_id = _STATE_AGENT_MAP.get(new_state)
    if agent_id is None and new_state in ('Doing', 'Next'):
        agent_id = execution_agent
    if not agent_id:
        log.info(f'ℹ️ {task_id} 新状态 {new_state} 无需自动派发')
        reason = f'状态 {new_state} 无需自动派发'
        _update_task_scheduler(task_id, lambda t, s: (
            s.update({
                'lastDispatchStatus': 'not_needed',
                'lastDispatchMode': '',
                'lastDispatchAgent': '',
                'lastDispatchTrigger': trigger,
                'lastDispatchError': reason,
            }),
            _scheduler_set_event(t, reason, status='not_needed'),
        ))
        return

    # Desktop workspaces use the bundled OpenClaw in embedded/local mode until
    # an external channel has been explicitly enabled and verified. Keeping
    # the opt-in gate in the server prevents stale UI/config state from
    # silently sending a task through an unauthenticated Gateway.
    _channel = _dispatch_channel_config()
    _local_dispatch = os.environ.get('EDICT_DESKTOP') == '1' and not _channel

    attempt_id = uuid.uuid4().hex[:16]
    queued_at = now_iso()
    queue_result = {'ok': False}

    def _queue_dispatch(t, s):
        # A stale callback must never enqueue a dispatch for a newer stage.
        if t.get('state') != new_state:
            return
        if execution_department:
            t['org'] = execution_department
            t['targetDept'] = execution_department
            t['targetAgent'] = agent_id
            t.pop('dispatchAssignmentRequired', None)
            t.pop('dispatchAssignmentError', None)
        s.update({
            'lastDispatchAt': queued_at,
            'lastDispatchStatus': 'queued',
            'lastDispatchAgent': agent_id,
            'lastDispatchTrigger': trigger,
            'lastDispatchMode': 'local' if _local_dispatch else 'gateway',
            'lastDispatchError': '',
            'dispatchAttemptId': attempt_id,
            'dispatchQueuedAt': queued_at,
            'dispatchStartedAt': '',
        })
        t['now'] = f'🧭 已入队派发：{_STATE_LABELS.get(new_state, new_state)} → {agent_id}'
        _scheduler_add_flow(t, f'已入队派发：{new_state} → {agent_id}（{trigger}）', to=execution_department or _STATE_LABELS.get(new_state, new_state))
        queue_result['ok'] = True

    _update_task_scheduler(task_id, _queue_dispatch)
    if not queue_result['ok']:
        log.info(f'ℹ️ {task_id} 状态已变化，跳过过期派发请求：{new_state}')
        return

    title = task.get('title', '(无标题)')
    target_dept = execution_department or task.get('targetDept', '')

    # 根据 agent_id 构造针对性消息
    _msgs = {
        'taizi': (
            f'📜 皇上旨意需要你处理\n'
            f'任务ID: {task_id}\n'
            f'旨意: {title}\n'
            f'⚠️ 看板已有此任务，请勿重复创建。直接用 kanban_update.py 更新状态。\n'
            f'请立即转交中书省起草执行方案。'
        ),
        'zhongshu': (
            f'📜 旨意已到中书省，请起草方案\n'
            f'任务ID: {task_id}\n'
            f'旨意: {title}\n'
            f'⚠️ 看板已有此任务记录，请勿重复创建。直接用 kanban_update.py state 更新状态。\n'
            f'请立即起草执行方案，走完完整三省流程（中书起草→门下审议→尚书派发→六部执行）。'
        ),
        'menxia': (
            f'📋 中书省方案提交审议\n'
            f'任务ID: {task_id}\n'
            f'旨意: {title}\n'
            f'⚠️ 看板已有此任务，请勿重复创建。\n'
            f'请审议中书省方案，给出准奏或封驳意见。'
        ),
        'shangshu': (
            f'📮 门下省已准奏，请派发执行\n'
            f'任务ID: {task_id}\n'
            f'旨意: {title}\n'
            f'{"建议派发部门: " + target_dept if target_dept else ""}\n'
            f'⚠️ 看板已有此任务，请勿重复创建。\n'
            f'请分析方案并派发给六部执行。'
        ),
    }
    msg = _msgs.get(agent_id, (
        f'📌 请处理任务\n'
        f'任务ID: {task_id}\n'
        f'旨意: {title}\n'
        f'⚠️ 看板已有此任务，请勿重复创建。直接用 kanban_update.py 更新状态。'
    ))
    if task.get('dispatchMessage'):
        msg += '\n\n总控台原始指令（请按此执行，不要另建任务）：\n' + str(task.get('dispatchMessage'))[:12_000]
    approved = task.get('templateParams') or {}
    project_dir = str(task.get('projectPath') or os.environ.get('EDICT_PROJECT_DIR', '')).strip()
    if project_dir:
        msg += (
            '\n当前项目目录（本旨意的唯一工作项目）：'
            + project_dir[:2_000]
            + '\n涉及代码、文档或测试时，请只在该项目目录内完成。完成的文件请优先写入 Edict_Output/'
            + task_id
            + '，并在回奏中列出实际产出路径和测试结果。'
        )
    if task.get('outputDir'):
        msg += '\n本任务指定输出目录：' + str(task.get('outputDir'))[:2_000]
    if approved.get('yushufangRoomId') and approved.get('proposalId'):
        msg += (
            '\n御书房已御批事项（仅以下内容获准转交，不包含其他密谈记录）：\n'
            + str(approved.get('approvedTitle') or title)[:500]
            + '\n' + str(approved.get('detail') or '')[:2000]
        )

    record = _register_dispatch(task_id, attempt_id)
    record['local_tree'] = _local_dispatch

    def _do_dispatch():
        dispatch_runtime_root = None
        try:
            if not _dispatch_target_is_active(task_id, new_state, record):
                return

            _dispatch_scheduler_update(task_id, record, lambda t, s: (
                s.update({'dispatchStartedAt': now_iso()}),
                _scheduler_set_event(t, '正在准备调用 Agent', status='dispatching'),
            ), expected_state=new_state)

            # External channels use the user's Gateway. Local task RPC uses
            # its own supervised transport and never waits on that service.
            if _channel:
                _preflight_ok, _preflight_detail = _external_dispatch_preflight(_channel)
                if not _preflight_ok:
                    err = f'外部派发未通过开工体检：{_preflight_detail}'
                    log.warning(f'⚠️ {task_id} 自动派发阻塞: {err}')
                    _record_dispatch_failure(task_id, record, new_state, agent_id, trigger, 'preflight-blocked', err, '外部派发配置未就绪')
                    return
            if not _local_dispatch:
                _dispatch_scheduler_update(task_id, record, lambda t, s: (
                    _scheduler_set_event(t, '正在等待外部 Gateway 响应', status='waiting_gateway'),
                ), expected_state=new_state)
                import time as _time
                _gw_alive = False
                for _gw_attempt in range(3):
                    if not _dispatch_target_is_active(task_id, new_state, record):
                        return
                    if _check_gateway_alive():
                        _gw_alive = True
                        break
                    if _gw_attempt < 2:
                        if record['cancel_event'].wait(5 * (_gw_attempt + 1)):
                            return
                if not _gw_alive:
                    err = '外部派发渠道需要 OpenClaw Gateway；当前 Gateway 未运行，请启动 Gateway 或在设置中检查渠道配置。'
                    log.warning(f'⚠️ {task_id} 自动派发失败: {err}')
                    _record_dispatch_failure(task_id, record, new_state, agent_id, trigger, 'gateway-offline', err, 'Gateway 未运行')
                    return

            openclaw_bin = _resolve_openclaw_bin()
            if not openclaw_bin:
                err = 'OpenClaw CLI 未找到：请确认应用内置运行时完整，或在设置中检查运行依赖。'
                log.warning(f'⚠️ {task_id} 自动派发异常: {err}')
                _record_dispatch_failure(task_id, record, new_state, agent_id, trigger, 'openclaw-missing', err, 'OpenClaw 不可用')
                return

            cmd = [openclaw_bin, 'agent']
            cmd.extend(['--agent', agent_id, '-m', msg, '--timeout', '300'])
            if _channel:
                cmd.extend(['--deliver', '--channel', _channel])
            dispatch_environment = runtime_environment()
            dispatch_runtime_root = None
            if _local_dispatch:
                source_path = pathlib.Path(
                    dispatch_environment.get('OPENCLAW_CONFIG_PATH')
                    or pathlib.Path(dispatch_environment.get('EDICT_OPENCLAW_HOME', str(pathlib.Path.home() / '.openclaw'))) / 'openclaw.json'
                ).expanduser()
                dispatch_runtime_root = DATA / 'dispatch-runtime' / attempt_id / agent_id
                _, dispatch_environment, _ = prepare_local_dispatch_runtime(
                    dispatch_runtime_root,
                    agent_id,
                    source_path,
                    base_environment=dispatch_environment,
                    managed_gateway=True,
                )
                dispatch_environment['EDICT_DISPATCH_STATE_DIR'] = str(DATA / 'dispatch-sessions' / attempt_id)
                # --local still needs Gateway RPC for native subagent announce.
                # Supervise a private loopback transport instead of using the
                # user's external-channel Gateway or an unauthenticated CLI.
                cmd = [python_bin(), str(SCRIPTS / 'local_dispatch.py'), openclaw_bin,
                       '--agent', agent_id, '--session-key', f'agent:{agent_id}:edict:{attempt_id}',
                       '-m', msg, '--timeout', '260']
            # A local turn may already have spawned work. Never replay the
            # whole tree automatically after an ambiguous failure.
            max_retries = 1 if _local_dispatch else 2
            err = ''
            for attempt in range(1, max_retries + 1):
                if not _dispatch_target_is_active(task_id, new_state, record):
                    return
                log.info(f'🔄 自动派发 {task_id} → {agent_id} ({"本地" if _local_dispatch else _channel} 第{attempt}次)...')
                _dispatch_scheduler_update(task_id, record, lambda t, s: (
                    _scheduler_set_event(t, f'正在调用 {agent_id}', status='running'),
                ), expected_state=new_state)
                popen_options = {
                    'stdout': subprocess.PIPE,
                    'stderr': subprocess.PIPE,
                    'text': True,
                    'env': dispatch_environment,
                }
                if os.name != 'nt':
                    popen_options['start_new_session'] = True
                process = subprocess.Popen(cmd, **popen_options)
                if not _attach_dispatch_process(task_id, record, process):
                    return
                try:
                    stdout, stderr = process.communicate(timeout=310)
                except subprocess.TimeoutExpired:
                    _terminate_dispatch_process(process)
                    raise
                if record['cancel_event'].is_set() or not _dispatch_is_current(task_id, record):
                    return
                if process.returncode == 0:
                    log.info(f'✅ {task_id} 自动派发成功 → {agent_id}')
                    record['stdout'] = (stdout or '')[-8_000:]

                    def _record_success(t, s):
                        state_unchanged = t.get('state') == new_state
                        s.update({
                            'lastDispatchAt': now_iso(),
                            'lastDispatchStatus': 'success',
                            'lastDispatchAgent': agent_id,
                            'lastDispatchTrigger': trigger,
                            'lastDispatchError': '',
                            'stateTransitionObserved': not state_unchanged,
                        })
                        _scheduler_add_flow(t, f'派发成功：{agent_id}（{trigger}）', to=t.get('org', ''))
                        if state_unchanged:
                            _scheduler_set_event(t, f'{agent_id} 进程已返回，尚未观察到任务阶段更新', status='success')
                            if t.get('dispatchKind') == 'small':
                                t['state'] = 'Done'
                                t['org'] = '回奏'
                                t['now'] = f'✅ 小任务完成：{agent_id} 已回奏'
                                t['output'] = t.get('output') or t.get('outputDir', '')
                                t['smallResult'] = record.get('stdout', '')
                                t.setdefault('flow_log', []).append({
                                    'at': now_iso(), 'from': agent_id, 'to': '回奏',
                                    'remark': '小任务执行完成并回奏',
                                })
                                s['stateTransitionObserved'] = True

                    _dispatch_scheduler_update(task_id, record, _record_success, expected_state=None if _local_dispatch else new_state)
                    return
                err = (stderr or stdout or '').strip()[:500] or f'OpenClaw 返回退出码 {process.returncode}'
                log.warning(f'⚠️ {task_id} 自动派发失败(第{attempt}次): {err}')
                if attempt < max_retries and record['cancel_event'].wait(5):
                    return
            log.error(f'❌ {task_id} 自动派发最终失败 → {agent_id}')
            _record_dispatch_failure(task_id, record, new_state, agent_id, trigger, 'failed', err, 'Agent 派发失败')
        except subprocess.TimeoutExpired:
            log.error(f'❌ {task_id} 自动派发超时 → {agent_id}')
            _record_dispatch_failure(task_id, record, new_state, agent_id, trigger, 'timeout', 'OpenClaw 执行超过 310 秒未返回', 'Agent 派发超时')
        except FileNotFoundError as e:
            err = f'OpenClaw CLI 未找到：{e}'
            log.warning(f'⚠️ {task_id} 自动派发异常: {err}')
            _record_dispatch_failure(task_id, record, new_state, agent_id, trigger, 'openclaw-missing', err, 'OpenClaw 不可用')
        except Exception as e:
            if record['cancel_event'].is_set() or not _dispatch_is_current(task_id, record):
                return
            log.warning(f'⚠️ {task_id} 自动派发异常: {e}')
            _record_dispatch_failure(task_id, record, new_state, agent_id, trigger, 'error', str(e), 'Agent 派发异常')
        finally:
            if _local_dispatch and dispatch_runtime_root:
                shutil.rmtree(dispatch_runtime_root, ignore_errors=True)
            _unregister_dispatch(task_id, record)

    threading.Thread(target=_do_dispatch, daemon=True).start()
    log.info(f'🚀 {task_id} 推进后自动派发 → {agent_id}')


def handle_advance_state(task_id, comment=''):
    """手动推进任务到下一阶段（解卡用），推进后自动派发对应 Agent。"""
    tasks = load_tasks()
    task = next((t for t in tasks if t.get('id') == task_id), None)
    if not task:
        return {'ok': False, 'error': f'任务 {task_id} 不存在'}
    cur = task.get('state', '')
    if cur not in _STATE_FLOW:
        return {'ok': False, 'error': f'任务 {task_id} 状态为 {cur}，无法推进'}
    _ensure_scheduler(task)
    _scheduler_snapshot(task, f'advance-before-{cur}')
    next_state, from_dept, to_dept, default_remark = _STATE_FLOW[cur]
    remark = comment or default_remark

    # 尚书省必须先明确六部中的一个执行部门，才能进入 Doing。
    # 这里在状态落盘前拦截，避免“先进入执行中、再发现没有 Agent”的空转。
    execution_department = ''
    if next_state in ('Doing', 'Next'):
        execution_department, _ = _resolve_execution_assignment(task)
        if not execution_department:
            _mark_waiting_for_execution_assignment(task, task['_scheduler'], trigger='manual-advance')
            task['updatedAt'] = now_iso()
            save_tasks(tasks)
            return {
                'ok': True,
                'message': f'{task_id} 尚书省尚未指定六部执行部门，已停在派发阶段，未调用 Agent',
            }

    task['state'] = next_state
    if execution_department:
        task['org'] = execution_department
        task['targetDept'] = execution_department
        task.pop('dispatchAssignmentRequired', None)
        task.pop('dispatchAssignmentError', None)
    task['now'] = f'⬇️ 手动推进：{remark}'
    task.setdefault('flow_log', []).append({
        'at': now_iso(),
        'from': from_dept,
        'to': execution_department or to_dept,
        'remark': f'⬇️ 手动推进：{remark}'
    })
    _scheduler_mark_progress(task, f'手动推进 {cur} -> {next_state}')
    task['updatedAt'] = now_iso()
    save_tasks(tasks)

    # 🚀 推进后自动派发对应 Agent（Done 状态无需派发）
    if next_state != 'Done':
        dispatch_for_state(task_id, task, next_state)

    from_label = _STATE_LABELS.get(cur, cur)
    to_label = _STATE_LABELS.get(next_state, next_state)
    dispatched = ' (已自动派发 Agent)' if next_state != 'Done' else ''
    return {'ok': True, 'message': f'{task_id} {from_label} → {to_label}{dispatched}'}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        # 只记录 4xx/5xx 错误请求
        if args and len(args) >= 1:
            status = str(args[0]) if args else ''
            if status.startswith('4') or status.startswith('5'):
                log.warning(f'{self.client_address[0]} {fmt % args}')

    def handle_error(self):
        pass  # 静默处理连接错误，避免 BrokenPipe 崩溃

    def handle(self):
        try:
            super().handle()
        except (BrokenPipeError, ConnectionResetError):
            pass  # 客户端断开连接，忽略

    def do_OPTIONS(self):
        self.send_response(200)
        cors_headers(self)
        self.end_headers()

    def send_json(self, data, code=200):
        try:
            body = json.dumps(data, ensure_ascii=False).encode()
            self.send_response(code)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Content-Length', str(len(body)))
            cors_headers(self)
            self.end_headers()
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def send_file(self, path: pathlib.Path, mime='text/html; charset=utf-8'):
        if not path.exists():
            self.send_error(404)
            return
        try:
            body = path.read_bytes()
            self.send_response(200)
            self.send_header('Content-Type', mime)
            self.send_header('Content-Length', str(len(body)))
            cors_headers(self)
            self.end_headers()
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _serve_static(self, rel_path):
        """从 dist/ 目录提供静态文件。"""
        safe = rel_path.replace('\\', '/').lstrip('/')
        if '..' in safe:
            self.send_error(403)
            return True
        fp = DIST / safe
        if fp.is_file():
            mime = _MIME_TYPES.get(fp.suffix.lower(), 'application/octet-stream')
            self.send_file(fp, mime)
            return True
        return False

    def _check_auth(self):
        """检查认证，未通过返回 True（已发送 401 响应）。"""
        p = urlparse(self.path).path.rstrip('/')
        if not requires_auth(p):
            return False
        token = extract_token(self.headers)
        if not token or not verify_token(token):
            self.send_json({'ok': False, 'error': '未登录或会话已过期'}, 401)
            return True
        return False

    def do_GET(self):
        p = urlparse(self.path).path.rstrip('/')
        # 认证状态端点（公开）
        if p == '/api/auth/status':
            self.send_json({'enabled': auth_enabled(), 'configured': auth_configured()})
            return

        # Command center and workspace inspection are protected like the rest
        # of the application API.  Keep only the authentication status endpoint
        # public so the desktop shell can decide whether to show login/setup.
        if self._check_auth():
            return

        if p == '/api/command-center':
            self.send_json(get_command_center())
            return
        if p.startswith('/api/task-workspace/'):
            task_id = p.replace('/api/task-workspace/', '', 1)
            self.send_json(get_task_workspace(task_id), 200)
            return
        if p == '/api/model-capabilities':
            try:
                self.send_json(model_caps.snapshot(read_json(OCLAW_HOME / 'openclaw.json', {}), DATA))
            except ValueError as exc:
                self.send_json({'ok': False, 'error': str(exc)}, 400)
            return
        if p == '/api/chat-attachments':
            query = parse_qs(urlparse(self.path).query)
            scope = query.get('scope', [''])[0]
            attachment_id = query.get('id', [''])[0]
            try:
                self._attachment_room(scope)
                meta, content = CHAT_ATTACHMENTS.read(scope, attachment_id)
            except ValueError as exc:
                self.send_json({'ok': False, 'error': str(exc)}, 404)
                return
            self.send_response(200)
            self.send_header('Content-Type', meta['mime'])
            self.send_header('Content-Length', str(len(content)))
            self.send_header('X-Content-Type-Options', 'nosniff')
            self.send_header('Cache-Control', 'private, no-store')
            self.send_header('Content-Disposition', f"attachment; filename*=UTF-8''{quote(meta['name'], safe='')}")
            cors_headers(self)
            self.end_headers()
            self.wfile.write(content)
        elif p in ('', '/dashboard', '/dashboard.html'):
            self.send_file(DIST / 'index.html')
        elif p == '/healthz':
            task_data_dir = get_task_data_dir()
            checks = {'dataDir': task_data_dir.is_dir(), 'tasksReadable': (task_data_dir / 'tasks_source.json').exists()}
            checks['dataWritable'] = os.access(str(task_data_dir), os.W_OK)
            all_ok = all(checks.values())
            self.send_json({'status': 'ok' if all_ok else 'degraded', 'ts': now_iso(), 'checks': checks})
        elif p == '/api/live-status':
            task_data_dir = get_task_data_dir()
            self.send_json(read_json(task_data_dir / 'live_status.json'))
        elif p == '/api/agent-config':
            self.send_json(read_json(DATA / 'agent_config.json'))
        elif p == '/api/model-change-log':
            self.send_json(read_json(DATA / 'model_change_log.json', []))
        elif p == '/api/last-result':
            self.send_json(read_json(DATA / 'last_model_change_result.json', {}))
        elif p == '/api/officials-stats':
            self.send_json(read_json(DATA / 'officials_stats.json', {}))
        elif p == '/api/morning-brief':
            self.send_json(read_json(DATA / 'morning_brief.json', {}))
        elif p == '/api/morning-config':
            migrate_notification_config()
            self.send_json(read_json(DATA / 'morning_brief_config.json', {
                'categories': [
                    {'name': '政治', 'enabled': True},
                    {'name': '军事', 'enabled': True},
                    {'name': '经济', 'enabled': True},
                    {'name': 'AI大模型', 'enabled': True},
                ],
                'keywords': [], 'custom_feeds': [],
                'notification': {'enabled': True, 'channel': 'feishu', 'webhook': ''},
            }))
        elif p == '/api/notification-channels':
            self.send_json({'ok': True, 'channels': get_channel_info()})
        elif p.startswith('/api/morning-brief/'):
            date = p.split('/')[-1]
            # 标准化日期格式为 YYYYMMDD（兼容 YYYY-MM-DD 输入）
            date_clean = date.replace('-', '')
            if not date_clean.isdigit() or len(date_clean) != 8:
                self.send_json({'ok': False, 'error': f'日期格式无效: {date}，请使用 YYYYMMDD'}, 400)
                return
            self.send_json(read_json(DATA / f'morning_brief_{date_clean}.json', {}))
        elif p == '/api/remote-skills-list':
            self.send_json(get_remote_skills_list())
        elif p.startswith('/api/skill-content/'):
            # /api/skill-content/{agentId}/{skillName}
            parts = p.replace('/api/skill-content/', '').split('/', 1)
            if len(parts) == 2:
                self.send_json(read_skill_content(parts[0], parts[1]))
            else:
                self.send_json({'ok': False, 'error': 'Usage: /api/skill-content/{agentId}/{skillName}'}, 400)
        elif p.startswith('/api/task-activity/'):
            task_id = p.replace('/api/task-activity/', '')
            if not task_id:
                self.send_json({'ok': False, 'error': 'task_id required'}, 400)
            else:
                self.send_json(get_task_activity(task_id))
        elif p.startswith('/api/scheduler-state/'):
            task_id = p.replace('/api/scheduler-state/', '')
            if not task_id:
                self.send_json({'ok': False, 'error': 'task_id required'}, 400)
            else:
                self.send_json(get_scheduler_state(task_id))
        elif p == '/api/agents-status':
            self.send_json(get_agents_status())
        elif p == '/api/readiness':
            self.send_json(get_readiness())
        elif p.startswith('/api/task-output/'):
            task_id = p.replace('/api/task-output/', '')
            if not task_id or not _SAFE_NAME_RE.match(task_id):
                self.send_json({'ok': False, 'error': 'invalid task_id'}, 400)
            else:
                tasks = load_tasks()
                task = next((t for t in tasks if t.get('id') == task_id), None)
                if not task:
                    self.send_json({'ok': False, 'error': 'task not found'}, 404)
                else:
                    output_path = task.get('output', '')
                    if not output_path or output_path == '-':
                        self.send_json({'ok': True, 'taskId': task_id, 'content': '', 'exists': False})
                    else:
                        p_out = pathlib.Path(output_path)
                        if not p_out.exists():
                            self.send_json({'ok': True, 'taskId': task_id, 'content': '', 'exists': False})
                        else:
                            try:
                                content = p_out.read_text(encoding='utf-8', errors='replace')[:50000]
                                self.send_json({'ok': True, 'taskId': task_id, 'content': content, 'exists': True})
                            except Exception as e:
                                self.send_json({'ok': False, 'error': f'读取失败: {e}'}, 500)
        elif p.startswith('/api/agent-activity/'):
            agent_id = p.replace('/api/agent-activity/', '')
            if not agent_id or not _SAFE_NAME_RE.match(agent_id):
                self.send_json({'ok': False, 'error': 'invalid agent_id'}, 400)
            else:
                self.send_json({'ok': True, 'agentId': agent_id, 'activity': get_agent_activity(agent_id)})
        # ── 朝堂议政 ──
        elif p == '/api/court-discuss/list':
            self.send_json({'ok': True, 'sessions': cd_list()})
        elif p == '/api/court-discuss/officials':
            self.send_json({'ok': True, 'officials': CD_PROFILES})
        elif p.startswith('/api/court-discuss/session/'):
            sid = p.replace('/api/court-discuss/session/', '')
            data = cd_get(sid)
            self.send_json(data if data else {'ok': False, 'error': 'session not found'}, 200 if data else 404)
        elif p == '/api/court-discuss/fate':
            self.send_json({'ok': True, 'event': cd_fate()})
        # ── 御书房（独立、定点召见会话） ──
        elif p == '/api/yushufang/runtime':
            self.send_json(get_yushufang_service().check_runtime())
        elif p == '/api/yushufang/officials':
            self.send_json(get_yushufang_service().list_agents())
        elif p == '/api/yushufang/rooms':
            # Include archived rooms so the desktop can render “内廷密档”.
            self.send_json(get_yushufang_service().list_rooms(include_archived=True))
        elif p.startswith('/api/yushufang/room/'):
            room_id = p.replace('/api/yushufang/room/', '', 1)
            result = get_yushufang_service().get_room(room_id)
            self.send_json(result, 200 if result.get('ok') else 404)
        elif self._serve_static(p):
            pass  # 已由 _serve_static 处理 (JS/CSS/图片等)
        else:
            # SPA fallback：非 /api/ 路径返回 index.html
            if not p.startswith('/api/'):
                idx = DIST / 'index.html'
                if idx.exists():
                    self.send_file(idx)
                    return
            self.send_error(404)

    def _attachment_room(self, scope, writable=False):
        if not isinstance(scope, str):
            raise ValueError('会话标识无效')
        if scope.startswith('ysf-'):
            result = get_yushufang_service().get_room(scope)
            room = result.get('room')
            ended = room and room['phase'] in {'concluded', 'cancelled', 'archived'}
        elif re.fullmatch(r'court-[0-9a-f]{8}', scope):
            room = cd_get(scope[6:])
            ended = room and room['phase'] != 'discussing'
        else:
            room, ended = None, False
        if not room or (writable and ended):
            raise ValueError('会话不存在或已结束')
        return room

    def _attachment_origin_allowed(self):
        origin = self.headers.get('Origin')
        if origin and origin not in _DEFAULT_ORIGINS and origin != ALLOWED_ORIGIN and origin != f"http://{self.headers.get('Host')}":
            self.send_json({'ok': False, 'error': '不允许跨站上传附件'}, 403)
            return False
        return True

    def do_POST(self):
        p = urlparse(self.path).path.rstrip('/')
        try:
            length = int(self.headers.get('Content-Length', 0))
            if length < 0:
                raise ValueError()
        except ValueError:
            self.send_json({'ok': False, 'error': 'invalid Content-Length'}, 400)
            return
        if p == '/api/chat-attachments':
            if self._check_auth() or not self._attachment_origin_allowed():
                return
            if not 0 < length <= MAX_FILE_SIZE:
                self.close_connection = True
                self.send_json({'ok': False, 'error': '附件须为非空文件，单个文件不超过 10 MB'}, 413)
                return
            query = parse_qs(urlparse(self.path).query)
            scope = query.get('scope', [''])[0]
            try:
                self._attachment_room(scope, writable=True)
                meta = CHAT_ATTACHMENTS.upload(scope, query.get('name', [''])[0], self.rfile.read(length))
                self.send_json({'ok': True, 'attachment': meta})
            except ValueError as exc:
                self.send_json({'ok': False, 'error': str(exc)}, 400)
            return
        if length > MAX_REQUEST_BODY:
            self.send_json({'ok': False, 'error': f'Request body too large (max {MAX_REQUEST_BODY} bytes)'}, 413)
            return
        raw = self.rfile.read(length) if length else b''
        try:
            body = json.loads(raw) if raw else {}
            if not isinstance(body, dict):
                raise ValueError()
        except Exception:
            self.send_json({'ok': False, 'error': 'invalid JSON'}, 400)
            return

        # ── 认证端点（公开） ──
        if p == '/api/auth/setup':
            pw = body.get('password', '')
            if not isinstance(pw, str) or not pw:
                self.send_json({'ok': False, 'error': '请提供密码'}, 400)
                return
            self.send_json(setup_password(pw))
            return
        if p == '/api/auth/login':
            pw = body.get('password', '')
            if not isinstance(pw, str) or not pw:
                self.send_json({'ok': False, 'error': '请提供密码'}, 400)
                return
            if verify_password(pw):
                token = create_token()
                resp = {'ok': True, 'token': token}
                # 同时设置 HttpOnly cookie
                try:
                    body_bytes = json.dumps(resp, ensure_ascii=False).encode()
                    self.send_response(200)
                    self.send_header('Content-Type', 'application/json; charset=utf-8')
                    self.send_header('Content-Length', str(len(body_bytes)))
                    self.send_header('Set-Cookie', f'edict_token={token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400')
                    cors_headers(self)
                    self.end_headers()
                    self.wfile.write(body_bytes)
                except (BrokenPipeError, ConnectionResetError):
                    pass
            else:
                self.send_json({'ok': False, 'error': '密码错误'}, 401)
            return

        # ── 认证检查 ──
        if self._check_auth():
            return

        if p == '/api/preflight/repair':
            action = body.get('action', '')
            if not isinstance(action, str):
                self.send_json({'ok': False, 'error': 'action 必须是字符串'}, 400)
                return
            result = repair_readiness(action.strip())
            self.send_json(result, 200 if result.get('ok') else 400)
            return

        if p == '/api/command-center/message':
            result = handle_command_center_message(body)
            self.send_json(result, 200 if result.get('ok') else 400)
            return

        if p == '/api/command-center/approve':
            result = handle_command_center_approve()
            self.send_json(result, 200 if result.get('ok') else 400)
            return

        if p == '/api/task-workspace/test':
            task_id = str(body.get('taskId') or '').strip()
            command_id = str(body.get('commandId') or '').strip()
            if not task_id:
                self.send_json({'ok': False, 'error': 'taskId required'}, 400)
                return
            result = start_task_workspace_test(task_id, command_id)
            self.send_json(result, 200 if result.get('ok') else 400)
            return

        if p == '/api/task-workspace/test/cancel':
            run_id = str(body.get('runId') or '').strip()
            if not run_id or not _SAFE_NAME_RE.fullmatch(run_id):
                self.send_json({'ok': False, 'error': 'runId required'}, 400)
                return
            result = cancel_workspace_run(run_id)
            self.send_json(result, 200 if result.get('ok') else 400)
            return

        if p == '/api/morning-config':
            if not isinstance(body, dict):
                self.send_json({'ok': False, 'error': '请求体必须是 JSON 对象'}, 400)
                return
            allowed_keys = {'categories', 'keywords', 'custom_feeds', 'notification', 'feishu_webhook'}
            unknown = set(body.keys()) - allowed_keys
            if unknown:
                self.send_json({'ok': False, 'error': f'未知字段: {", ".join(unknown)}'}, 400)
                return
            if 'categories' in body and not isinstance(body['categories'], list):
                self.send_json({'ok': False, 'error': 'categories 必须是数组'}, 400)
                return
            if 'keywords' in body and not isinstance(body['keywords'], list):
                self.send_json({'ok': False, 'error': 'keywords 必须是数组'}, 400)
                return
            if 'notification' in body:
                noti = body['notification']
                if not isinstance(noti, dict):
                    self.send_json({'ok': False, 'error': 'notification 必须是对象'}, 400)
                    return
                channel_type = noti.get('channel', 'feishu')
                if channel_type not in NOTIFICATION_CHANNELS:
                    self.send_json({'ok': False, 'error': f'不支持的渠道: {channel_type}'}, 400)
                    return
                webhook = noti.get('webhook', '').strip()
                if webhook:
                    channel_cls = get_channel(channel_type)
                    if channel_cls and not channel_cls.validate_webhook(webhook):
                        self.send_json({'ok': False, 'error': f'{channel_cls.label} Webhook URL 无效'}, 400)
                        return
            webhook_legacy = body.get('feishu_webhook', '').strip()
            if webhook_legacy and 'notification' not in body:
                body['notification'] = {'enabled': True, 'channel': 'feishu', 'webhook': webhook_legacy}
            cfg_path = DATA / 'morning_brief_config.json'
            cfg_path.write_text(json.dumps(body, ensure_ascii=False, indent=2))
            self.send_json({'ok': True, 'message': '订阅配置已保存'})
            return

        if p == '/api/scheduler-scan':
            threshold_sec = body.get('thresholdSec', 180)
            try:
                result = handle_scheduler_scan(threshold_sec)
                self.send_json(result)
            except Exception as e:
                self.send_json({'ok': False, 'error': f'scheduler scan failed: {e}'}, 500)
            return

        if p == '/api/repair-flow-order':
            try:
                self.send_json(handle_repair_flow_order())
            except Exception as e:
                self.send_json({'ok': False, 'error': f'repair flow order failed: {e}'}, 500)
            return

        if p == '/api/scheduler-retry':
            task_id = body.get('taskId', '').strip()
            reason = body.get('reason', '').strip()
            if not task_id:
                self.send_json({'ok': False, 'error': 'taskId required'}, 400)
                return
            self.send_json(handle_scheduler_retry(task_id, reason))
            return

        if p == '/api/scheduler-escalate':
            task_id = body.get('taskId', '').strip()
            reason = body.get('reason', '').strip()
            if not task_id:
                self.send_json({'ok': False, 'error': 'taskId required'}, 400)
                return
            self.send_json(handle_scheduler_escalate(task_id, reason))
            return

        if p == '/api/scheduler-rollback':
            task_id = body.get('taskId', '').strip()
            reason = body.get('reason', '').strip()
            if not task_id:
                self.send_json({'ok': False, 'error': 'taskId required'}, 400)
                return
            self.send_json(handle_scheduler_rollback(task_id, reason))
            return

        if p == '/api/morning-brief/refresh':
            force = body.get('force', True)  # 从看板手动触发默认强制
            def do_refresh():
                try:
                    cmd = [python_bin(), str(SCRIPTS / 'fetch_morning_news.py')]
                    if force:
                        cmd.append('--force')
                    subprocess.run(cmd, timeout=120)
                    push_to_feishu()
                except Exception as e:
                    print(f'[refresh error] {e}', file=sys.stderr)
            threading.Thread(target=do_refresh, daemon=True).start()
            self.send_json({'ok': True, 'message': '采集已触发，约30-60秒后刷新'})
            return

        if p == '/api/add-skill':
            agent_id = body.get('agentId', '').strip()
            skill_name = body.get('skillName', body.get('name', '')).strip()
            desc = body.get('description', '').strip() or skill_name
            trigger = body.get('trigger', '').strip()
            if not agent_id or not skill_name:
                self.send_json({'ok': False, 'error': 'agentId and skillName required'}, 400)
                return
            result = add_skill_to_agent(agent_id, skill_name, desc, trigger)
            self.send_json(result)
            return

        if p == '/api/add-remote-skill':
            agent_id = body.get('agentId', '').strip()
            skill_name = body.get('skillName', '').strip()
            source_url = body.get('sourceUrl', '').strip()
            description = body.get('description', '').strip()
            if not agent_id or not skill_name or not source_url:
                self.send_json({'ok': False, 'error': 'agentId, skillName, and sourceUrl required'}, 400)
                return
            result = add_remote_skill(agent_id, skill_name, source_url, description)
            self.send_json(result)
            return

        if p == '/api/remote-skills-list':
            result = get_remote_skills_list()
            self.send_json(result)
            return

        if p == '/api/update-remote-skill':
            agent_id = body.get('agentId', '').strip()
            skill_name = body.get('skillName', '').strip()
            if not agent_id or not skill_name:
                self.send_json({'ok': False, 'error': 'agentId and skillName required'}, 400)
                return
            result = update_remote_skill(agent_id, skill_name)
            self.send_json(result)
            return

        if p == '/api/remove-remote-skill':
            agent_id = body.get('agentId', '').strip()
            skill_name = body.get('skillName', '').strip()
            if not agent_id or not skill_name:
                self.send_json({'ok': False, 'error': 'agentId and skillName required'}, 400)
                return
            result = remove_remote_skill(agent_id, skill_name)
            self.send_json(result)
            return

        if p == '/api/task-action':
            task_id = body.get('taskId', '').strip()
            action = body.get('action', '').strip()  # stop, cancel, resume
            reason = body.get('reason', '').strip() or f'皇上从看板{action}'
            if not task_id or action not in ('stop', 'cancel', 'resume'):
                self.send_json({'ok': False, 'error': 'taskId and action(stop/cancel/resume) required'}, 400)
                return
            result = handle_task_action(task_id, action, reason)
            self.send_json(result)
            return

        if p == '/api/archive-task':
            task_id = body.get('taskId', '').strip() if body.get('taskId') else ''
            archived = body.get('archived', True)
            archive_all = body.get('archiveAllDone', False)
            if not task_id and not archive_all:
                self.send_json({'ok': False, 'error': 'taskId or archiveAllDone required'}, 400)
                return
            result = handle_archive_task(task_id, archived, archive_all)
            self.send_json(result)
            return

        if p == '/api/delete-task':
            task_id = body.get('taskId', '').strip() if isinstance(body.get('taskId', ''), str) else ''
            if not task_id:
                self.send_json({'ok': False, 'error': 'taskId required'}, 400)
                return
            result = handle_delete_task(task_id)
            self.send_json(result, 200 if result.get('ok') else 400)
            return

        if p == '/api/task-todos':
            task_id = body.get('taskId', '').strip()
            todos = body.get('todos', [])  # [{id, title, status}]
            if not task_id:
                self.send_json({'ok': False, 'error': 'taskId required'}, 400)
                return
            # todos 输入校验
            if not isinstance(todos, list) or len(todos) > 200:
                self.send_json({'ok': False, 'error': 'todos must be a list (max 200 items)'}, 400)
                return
            valid_statuses = {'not-started', 'in-progress', 'completed'}
            for td in todos:
                if not isinstance(td, dict) or 'id' not in td or 'title' not in td:
                    self.send_json({'ok': False, 'error': 'each todo must have id and title'}, 400)
                    return
                if td.get('status', 'not-started') not in valid_statuses:
                    td['status'] = 'not-started'
            result = update_task_todos(task_id, todos)
            self.send_json(result)
            return

        if p == '/api/create-task':
            title = body.get('title', '').strip()
            org = body.get('org', '中书省').strip()
            official = body.get('official', '中书令').strip()
            priority = body.get('priority', 'normal').strip()
            template_id = body.get('templateId', '')
            params = body.get('params', {})
            if not title:
                self.send_json({'ok': False, 'error': 'title required'}, 400)
                return
            target_dept = body.get('targetDept', '').strip()
            result = handle_create_task(
                title, org, official, priority, template_id, params, target_dept,
                body.get('workflowMode', 'standard'), body.get('permissionMode', 'full'),
                body.get('plan') if isinstance(body.get('plan'), dict) else None,
                str(body.get('commandMessageId') or '').strip(),
            )
            self.send_json(result)
            return

        if p == '/api/review-action':
            task_id = body.get('taskId', '').strip()
            action = body.get('action', '').strip()  # approve, reject
            comment = body.get('comment', '').strip()
            if not task_id or action not in ('approve', 'reject'):
                self.send_json({'ok': False, 'error': 'taskId and action(approve/reject) required'}, 400)
                return
            result = handle_review_action(task_id, action, comment)
            self.send_json(result)
            return

        if p == '/api/advance-state':
            task_id = body.get('taskId', '').strip()
            comment = body.get('comment', '').strip()
            if not task_id:
                self.send_json({'ok': False, 'error': 'taskId required'}, 400)
                return
            result = handle_advance_state(task_id, comment)
            self.send_json(result)
            return

        if p == '/api/agent-wake':
            agent_id = body.get('agentId', '').strip()
            message = body.get('message', '').strip()
            if not agent_id:
                self.send_json({'ok': False, 'error': 'agentId required'}, 400)
                return
            result = wake_agent(agent_id, message)
            self.send_json(result)
            return

        if p.startswith('/api/model-capabilities/'):
            if not self._attachment_origin_allowed():
                return
            config = read_json(OCLAW_HOME / 'openclaw.json', {})
            try:
                if p.endswith('/configure'):
                    result = {'ok': True, 'capability': model_caps.configure(config, DATA, body.get('model'), body.get('levels'))}
                    if body.get('levels') is None:
                        atomic_json_update(OCLAW_HOME / 'openclaw.json',
                                           lambda current: model_caps.restore_definitions(current, DATA, {body.get('model')}), {})
                elif p.endswith('/probe'):
                    result = model_caps.probe(config, DATA, body.get('model'), body.get('levels'),
                                              body.get('confirmed'), body.pop('_apiKey', None))
                elif p.endswith('/validate'):
                    result = {'ok': True, 'thinking': model_caps.validate(
                        config, DATA, body.get('thinking'), body.get('model'), body.get('agentId'), body.get('global') is True)}
                else:
                    self.send_json({'ok': False, 'error': 'unknown capability action'}, 404)
                    return
                self.send_json(result)
            except ValueError as exc:
                self.send_json({'ok': False, 'error': str(exc)}, 400)
            return

        if p == '/api/set-model':
            agent_id = body.get('agentId', '').strip()
            model = body.get('model', '').strip()
            if not agent_id or not model:
                self.send_json({'ok': False, 'error': 'agentId and model required'}, 400)
                return
            try:
                config = read_json(OCLAW_HOME / 'openclaw.json', {})
                defaults = config.get('agents', {}).get('defaults', {})
                agent = next((item for item in config.get('agents', {}).get('list', []) if item.get('id') == agent_id), None)
                if not agent:
                    raise ValueError('Agent 未注册')
                old_model = model_caps.primary(agent.get('model')) or model_caps.primary(defaults.get('model'))
                thinking = model_caps.model_thinking(config, DATA, old_model,
                    agent.get('thinkingDefault', defaults.get('thinkingDefault', 'default')))
                model_caps.validate(config, DATA, thinking, model=model)
            except ValueError as exc:
                self.send_json({'ok': False, 'error': str(exc)}, 400)
                return

            # Write to pending (atomic)
            pending_path = DATA / 'pending_model_changes.json'
            def update_pending(current):
                current = [x for x in current if x.get('agentId') != agent_id]
                current.append({'agentId': agent_id, 'model': model})
                return current
            atomic_json_update(pending_path, update_pending, [])

            # Async apply
            def apply_async():
                try:
                    subprocess.run([python_bin(), str(SCRIPTS / 'apply_model_changes.py')], timeout=30)
                    subprocess.run([python_bin(), str(SCRIPTS / 'sync_agent_config.py')], timeout=10)
                except Exception as e:
                    print(f'[apply error] {e}', file=sys.stderr)

            threading.Thread(target=apply_async, daemon=True).start()
            self.send_json({'ok': True, 'message': f'Queued: {agent_id} → {model}'})

        elif p == '/api/set-model-profile':
            # Apply one model/thinking profile to every registered Agent. The
            # worker performs the atomic OpenClaw update and clears per-Agent
            # model/thinking overrides so sync_agent_config cannot fall back
            # to stale or unsupported values later.
            provider_id = body.get('providerId', '')
            provider_id = provider_id.strip() if isinstance(provider_id, str) else ''
            provider_id = _openclaw_provider_id(provider_id)
            model = body.get('model', '')
            model = model.strip() if isinstance(model, str) else ''
            thinking = body.get('thinkingDefault', '')
            thinking = thinking.strip().lower() if isinstance(thinking, str) else ''
            if not model or not thinking:
                self.send_json({'ok': False, 'error': 'model and thinkingDefault are required'}, 400)
                return
            qualified_model = f'{provider_id}/{model}' if provider_id and not model.startswith(provider_id + '/') else model
            try:
                model_caps.validate(read_json(OCLAW_HOME / 'openclaw.json', {}), DATA, thinking, model=qualified_model)
            except ValueError as exc:
                self.send_json({'ok': False, 'error': str(exc)}, 400)
                return

            profile_path = DATA / 'pending_model_profile.json'
            atomic_json_write(profile_path, {
                **({'providerId': provider_id} if provider_id else {}),
                'model': model,
                'thinkingDefault': thinking,
                'requestedAt': now_iso(),
            })

            configured_payload = read_json(DATA / 'agent_config.json', {})
            configured_agents = configured_payload.get('agents', []) if isinstance(configured_payload, dict) else []
            agent_count = len(configured_agents) if isinstance(configured_agents, list) else 0
            qualified_model = f'{provider_id}/{model}' if provider_id and not model.startswith(provider_id + '/') else model

            def apply_profile_async():
                try:
                    subprocess.run([python_bin(), str(SCRIPTS / 'apply_model_changes.py')], timeout=30)
                    subprocess.run([python_bin(), str(SCRIPTS / 'sync_agent_config.py')], timeout=10)
                except Exception as e:
                    print(f'[profile apply error] {e}', file=sys.stderr)

            threading.Thread(target=apply_profile_async, daemon=True).start()
            self.send_json({
                'ok': True,
                'message': f'已排队统一配置：{qualified_model} / {thinking}',
                'model': qualified_model,
                'providerId': provider_id,
                'thinkingDefault': thinking,
                'thinking': thinking,
                'agentCount': agent_count,
            })

        # 设置派发渠道（feishu/telegram/wecom/signal/tui）。
        # channel 可以保留为已配置的候选渠道，但必须显式 enabled=true
        # 才能让调度器离开桌面本地模式。
        elif p == '/api/set-dispatch-channel':
            channel = body.get('channel', '')
            if not isinstance(channel, str):
                channel = ''
            channel = channel.strip().lower()
            enabled = body.get('enabled')
            if enabled is None:
                enabled = bool(channel)
            allowed = {'feishu', 'telegram', 'wecom', 'signal', 'tui', 'discord', 'slack'}
            if channel and channel not in allowed:
                self.send_json({'ok': False, 'error': f'channel must be one of: {", ".join(sorted(allowed))}'}, 400)
                return
            if not isinstance(enabled, bool):
                self.send_json({'ok': False, 'error': 'enabled must be a boolean'}, 400)
                return
            def _set_channel(cfg):
                cfg['dispatchChannel'] = channel
                cfg['dispatchChannelEnabled'] = bool(enabled and channel)
                return cfg
            atomic_json_update(DATA / 'agent_config.json', _set_channel, {})
            if enabled and channel:
                self.send_json({'ok': True, 'message': f'派发渠道已开启：{channel}', 'dispatchChannel': channel, 'dispatchChannelEnabled': True})
            else:
                self.send_json({'ok': True, 'message': '外部派发已关闭，将使用桌面内置本地派发。', 'dispatchChannel': channel, 'dispatchChannelEnabled': False})

        # ── 朝堂议政 POST ──
        elif p == '/api/chat-attachments/remove':
            if not self._attachment_origin_allowed():
                return
            scope, attachment_id = body.get('scope', ''), body.get('id', '')
            try:
                self._attachment_room(scope, writable=True)
                if scope.startswith('ysf-'):
                    get_yushufang_service().delete_attachment(scope, attachment_id)
                else:
                    cd_delete_attachment(scope[6:], attachment_id)
                self.send_json({'ok': True})
            except ValueError as exc:
                self.send_json({'ok': False, 'error': str(exc)}, 400)
        elif p == '/api/court-discuss/start':
            topic = body.get('topic', '').strip()
            officials = body.get('officials', [])
            task_id = body.get('taskId', '').strip()
            if not topic:
                self.send_json({'ok': False, 'error': 'topic required'}, 400)
                return
            if not officials or not isinstance(officials, list):
                self.send_json({'ok': False, 'error': 'officials list required'}, 400)
                return
            # 校验官员 ID
            valid_ids = set(CD_PROFILES.keys())
            officials = [o for o in officials if o in valid_ids]
            if len(officials) < 2:
                self.send_json({'ok': False, 'error': '至少选择2位官员'}, 400)
                return
            self.send_json(cd_create(topic, officials, task_id))

        elif p == '/api/court-discuss/advance':
            sid = body.get('sessionId', '').strip()
            user_msg = body.get('userMessage', '').strip() or None
            decree = body.get('decree', '').strip() or None
            if not sid:
                self.send_json({'ok': False, 'error': 'sessionId required'}, 400)
                return
            result = cd_advance(sid, user_msg, decree, body.get('attachmentIds', []))
            self.send_json(result, 200 if result.get('ok') else 400)

        elif p == '/api/court-discuss/conclude':
            sid = body.get('sessionId', '').strip()
            if not sid:
                self.send_json({'ok': False, 'error': 'sessionId required'}, 400)
                return
            self.send_json(cd_conclude(sid))

        elif p == '/api/court-discuss/destroy':
            sid = body.get('sessionId', '').strip()
            if sid:
                cd_destroy(sid)
            self.send_json({'ok': True})

        elif p == '/api/court-discuss/delete':
            result = cd_delete(body.get('sessionId', ''))
            self.send_json(result, 200 if result.get('ok') else 400)

        # ── 御书房 POST ──
        elif p == '/api/yushufang/open':
            topic = body.get('topic', '').strip()
            officials = body.get('officials', body.get('agentIds', []))
            thinking = body.get('thinkingDefault', body.get('thinking', 'default'))
            result = get_yushufang_service().open_room(topic, officials, thinking=thinking, audience=body.get('audience', 'ministers'))
            self.send_json(result, 200 if result.get('ok') else 400)

        elif p == '/api/yushufang/invite':
            room_id = body.get('roomId', '').strip()
            officials = body.get('officials', body.get('agentIds', []))
            result = get_yushufang_service().invite(room_id, officials, join_prince=body.get('joinPrince') is True)
            self.send_json(result, 200 if result.get('ok') else 400)

        elif p == '/api/yushufang/remove-queued':
            result = get_yushufang_service().remove_queued_message(body.get('roomId', ''), body.get('messageId', ''))
            self.send_json(result, 200 if result.get('ok') else 400)

        elif p == '/api/yushufang/speak':
            room_id = body.get('roomId', '').strip()
            message = body.get('message', '').strip()
            thinking = body.get('thinkingDefault', body.get('thinking'))
            result = get_yushufang_service().speak(room_id, message, thinking=thinking, attachment_ids=body.get('attachmentIds', []))
            self.send_json(result, 200 if result.get('ok') else 400)

        elif p == '/api/yushufang/ask-progress':
            result = get_yushufang_service().ask_progress(
                body.get('roomId', '').strip(),
                body.get('agentId', '').strip(),
                body.get('question'),
            )
            self.send_json(result, 200 if result.get('ok') else 400)

        elif p == '/api/yushufang/remove-participant':
            room_id = body.get('roomId', '').strip()
            agent_id = body.get('agentId', '').strip()
            result = get_yushufang_service().remove_participant(room_id, agent_id)
            self.send_json(result, 200 if result.get('ok') else 400)

        elif p == '/api/yushufang/cancel':
            result = get_yushufang_service().cancel(body.get('roomId', '').strip())
            self.send_json(result, 200 if result.get('ok') else 400)

        elif p == '/api/yushufang/resume':
            result = get_yushufang_service().resume(
                body.get('roomId', '').strip(), thinking=body.get('thinkingDefault', body.get('thinking')))
            self.send_json(result, 200 if result.get('ok') else 400)

        elif p == '/api/yushufang/disband':
            result = get_yushufang_service().disband(body.get('roomId', '').strip())
            self.send_json(result, 200 if result.get('ok') else 400)

        elif p == '/api/yushufang/conclude':
            actions = body.get('proposedActions')
            result = get_yushufang_service().conclude(body.get('roomId', '').strip(), actions if isinstance(actions, list) else None)
            self.send_json(result, 200 if result.get('ok') else 400)

        elif p == '/api/yushufang/approve':
            result = get_yushufang_service().approve(
                body.get('roomId', '').strip(),
                body.get('actionId', '').strip(),
                body.get('approved'),
            )
            self.send_json(result, 200 if result.get('ok') else 400)

        elif p == '/api/yushufang/execute-approved':
            result = get_yushufang_service().execute_approved(
                body.get('roomId', '').strip(), body.get('actionId', '').strip(),
                confirmed=body.get('confirmed') is True,
            )
            self.send_json(result, 200 if result.get('ok') else 409)

        elif p == '/api/yushufang/archive':
            result = get_yushufang_service().archive(body.get('roomId', '').strip())
            self.send_json(result, 200 if result.get('ok') else 400)

        elif p == '/api/yushufang/delete':
            result = get_yushufang_service().delete(body.get('roomId', '').strip())
            self.send_json(result, 200 if result.get('ok') else 400)

        else:
            self.send_error(404)


def main():
    parser = argparse.ArgumentParser(description='三省六部看板服务器')
    parser.add_argument('--port', type=int, default=7891)
    parser.add_argument('--host', default='127.0.0.1')
    parser.add_argument('--cors', default=None, help='Allowed CORS origin (default: reflect request Origin header)')
    args = parser.parse_args()

    global ALLOWED_ORIGIN, _DASHBOARD_PORT, _DEFAULT_ORIGINS
    ALLOWED_ORIGIN = args.cors
    _DASHBOARD_PORT = args.port
    _DEFAULT_ORIGINS = _DEFAULT_ORIGINS | {
        f'http://127.0.0.1:{args.port}', f'http://localhost:{args.port}',
    }

    server = HTTPServer((args.host, args.port), Handler)
    log.info(f'三省六部看板启动 → http://{args.host}:{args.port}')
    print(f'   按 Ctrl+C 停止')

    auth_init(DATA)
    if auth_enabled():
        log.info('🔒 JWT 认证已启用')
    else:
        log.info('🔓 认证未配置，所有 API 公开访问（POST /api/auth/setup 设置密码）')

    migrate_notification_config()

    if _auto_dispatch_enabled():
        # 启动恢复：重新派发上次被 kill 中断的 queued 任务
        threading.Timer(3.0, _startup_recover_queued_dispatches).start()

        # 定时巡检：每 120 秒自动扫描停滞任务并触发重试/升级/回滚
        def _periodic_scheduler_scan():
            while True:
                try:
                    import time as _time
                    _time.sleep(120)
                    result = handle_scheduler_scan(threshold_sec=180)
                    count = result.get('count', 0) if isinstance(result, dict) else 0
                    if count > 0:
                        log.info(f'🔍 定时巡检：{count} 个动作')
                except Exception as e:
                    log.warning(f'定时巡检异常: {e}')
        threading.Thread(target=_periodic_scheduler_scan, daemon=True).start()
        log.info('🔍 定时巡检已启动（每120秒）')
    else:
        log.info('⏸️ 手动模式：自动派发与定时巡检已关闭')

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print('\n已停止')


if __name__ == '__main__':
    main()
