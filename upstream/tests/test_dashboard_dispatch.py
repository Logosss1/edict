"""Tests for dashboard auto-dispatch error handling."""
import json
import pathlib
import sys
import threading

import pytest

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / 'dashboard'))
sys.path.insert(0, str(ROOT / 'scripts'))


def test_local_tree_failure_reports_current_ministry_not_stale_taizi(monkeypatch, tmp_path):
    import server as srv
    task_id = 'JJC-20260906-990'
    tasks_path = tmp_path / 'tasks_source.json'
    tasks_path.write_text(json.dumps([{'id': task_id, 'title': '子任务回报失败测试', 'state': 'Doing',
        'org': '礼部', '_scheduler': {'dispatchAttemptId': 'fixture'}}]))
    monkeypatch.setattr(srv, 'DATA', tmp_path)
    monkeypatch.setattr(srv, '_ACTIVE_TASK_DATA_DIR', tmp_path)
    monkeypatch.setattr(srv, '_trigger_refresh', lambda: None)
    record = srv._register_dispatch(task_id, 'fixture')
    record['local_tree'] = True
    try:
        srv._record_dispatch_failure(task_id, record, 'Taizi', 'taizi', 'test', 'failed', '子 Agent 回报失败', 'Agent 派发失败')
        task = json.loads(tasks_path.read_text())[0]
        assert task['state'] == 'Blocked'
        assert task['_prev_state'] == 'Doing'
        assert task['org'] == '礼部'
        assert task['_scheduler']['lastDispatchStatus'] == 'failed'
    finally:
        srv._unregister_dispatch(task_id, record)


def test_dispatch_records_missing_openclaw_cli(monkeypatch, tmp_path):
    """Missing OpenClaw CLI should become an actionable dispatch status."""
    import server as srv

    data_dir = tmp_path / 'data'
    data_dir.mkdir()
    task_id = 'JJC-20260415-004'
    task = {
        'id': task_id,
        'title': '小任务',
        'state': 'Taizi',
        'org': '太子',
        'updatedAt': '2026-04-15T15:34:16Z',
    }
    tasks_path = data_dir / 'tasks_source.json'
    tasks_path.write_text(json.dumps([task], ensure_ascii=False), encoding='utf-8')
    (data_dir / 'agent_config.json').write_text('{}', encoding='utf-8')

    monkeypatch.setattr(srv, 'DATA', data_dir)
    monkeypatch.setattr(srv, '_ACTIVE_TASK_DATA_DIR', data_dir)
    monkeypatch.setattr(srv, '_check_gateway_alive', lambda: True)
    monkeypatch.setattr(srv, '_resolve_openclaw_bin', lambda: None)
    monkeypatch.setattr(
        srv,
        'save_tasks',
        lambda tasks: tasks_path.write_text(
            json.dumps(tasks, ensure_ascii=False),
            encoding='utf-8',
        ),
    )

    class ImmediateThread:
        def __init__(self, target=None, daemon=None):
            self.target = target

        def start(self):
            if self.target:
                self.target()

    monkeypatch.setattr(srv.threading, 'Thread', ImmediateThread)

    srv.dispatch_for_state(task_id, task, 'Taizi', trigger='test')

    updated = json.loads(tasks_path.read_text(encoding='utf-8'))[0]
    sched = updated['_scheduler']
    assert sched['lastDispatchStatus'] == 'openclaw-missing'
    assert updated['state'] == 'Blocked'
    assert 'OpenClaw CLI 未找到' in sched['lastDispatchError']
    assert '[WinError 2]' not in sched['lastDispatchError']
    assert any('OpenClaw CLI 未找到' in item['remark'] for item in updated['flow_log'])


def test_desktop_local_dispatch_does_not_require_gateway(monkeypatch, tmp_path):
    """A desktop task needs no user-managed external-channel Gateway."""
    import server as srv

    data_dir = tmp_path / 'data'
    data_dir.mkdir()
    task_id = 'JJC-20260415-005'
    task = {
        'id': task_id,
        'title': '本地派发测试',
        'state': 'Taizi',
        'org': '太子',
        'updatedAt': '2026-04-15T15:34:16Z',
    }
    tasks_path = data_dir / 'tasks_source.json'
    tasks_path.write_text(json.dumps([task], ensure_ascii=False), encoding='utf-8')
    (data_dir / 'agent_config.json').write_text('{}', encoding='utf-8')
    source_path = tmp_path / 'openclaw.json'
    source_path.write_text(json.dumps({
        'agents': {'defaults': {'model': 'test/model'}, 'list': [{'id': 'taizi'}]},
        'models': {'providers': {'test': {
            'baseUrl': 'http://127.0.0.1:1/v1',
            'api': 'openai-completions',
            'apiKey': {'source': 'env', 'provider': 'default', 'id': 'EDICT_PROVIDER_TEST_API_KEY'},
            'models': [{'id': 'model', 'name': 'Model'}],
        }}},
    }), encoding='utf-8')

    monkeypatch.setattr(srv, 'DATA', data_dir)
    monkeypatch.setattr(srv, '_ACTIVE_TASK_DATA_DIR', data_dir)
    monkeypatch.setattr(srv, '_trigger_refresh', lambda: None)
    monkeypatch.setenv('EDICT_AUTO_DISPATCH', '1')
    monkeypatch.setenv('EDICT_DESKTOP', '1')
    monkeypatch.setenv('OPENCLAW_CONFIG_PATH', str(source_path))
    monkeypatch.setenv('EDICT_PROVIDER_TEST_API_KEY', 'fixture-local-secret')
    monkeypatch.setattr(srv, '_check_gateway_alive', lambda: (_ for _ in ()).throw(AssertionError('local dispatch must skip Gateway')))
    monkeypatch.setattr(srv, '_resolve_openclaw_bin', lambda: '/fixture/openclaw')

    seen = {}

    class FakeProcess:
        pid = 12345

        def __init__(self):
            self.returncode = 0

        def communicate(self, timeout=None):
            return '{}', ''

        def poll(self):
            return self.returncode

        def wait(self, timeout=None):
            return self.returncode

        def terminate(self):
            self.returncode = -15

        def kill(self):
            self.returncode = -9

    def fake_popen(command, **options):
        seen['command'] = command
        child_config = json.loads(pathlib.Path(options['env']['OPENCLAW_CONFIG_PATH']).read_text(encoding='utf-8'))
        seen['child_config'] = child_config
        seen['environment'] = options['env']
        process = FakeProcess()
        seen['process'] = process
        return process

    monkeypatch.setattr(srv.subprocess, 'Popen', fake_popen)

    class ImmediateThread:
        def __init__(self, target=None, daemon=None):
            self.target = target

        def start(self):
            if self.target:
                self.target()

    monkeypatch.setattr(srv.threading, 'Thread', ImmediateThread)
    srv.dispatch_for_state(task_id, task, 'Taizi', trigger='test-local')

    assert '--local' not in seen['command']
    assert any(part.endswith('/local_dispatch.py') for part in seen['command'])
    assert '--session-key' in seen['command']
    assert seen['child_config']['models']['providers']['test']['apiKey'] == 'OPENAI_API_KEY'
    assert seen['environment']['OPENAI_API_KEY'] == 'fixture-local-secret'
    updated = json.loads(tasks_path.read_text(encoding='utf-8'))[0]
    assert updated['state'] == 'Taizi'
    assert updated['_scheduler']['lastDispatchStatus'] == 'success'
    assert updated['_scheduler']['lastDispatchMode'] == 'local'


def test_cancel_terminates_registered_dispatch(monkeypatch, tmp_path):
    """Cancel must signal the real active child, not only change JSON state."""
    import server as srv

    data_dir = tmp_path / 'data'
    data_dir.mkdir()
    task_id = 'JJC-20260415-006'
    tasks_path = data_dir / 'tasks_source.json'
    tasks_path.write_text(json.dumps([{
        'id': task_id, 'title': '终止测试', 'state': 'Taizi', 'org': '太子',
        'updatedAt': '2026-04-15T15:34:16Z',
    }], ensure_ascii=False), encoding='utf-8')
    (data_dir / 'agent_config.json').write_text('{}', encoding='utf-8')
    monkeypatch.setattr(srv, 'DATA', data_dir)
    monkeypatch.setattr(srv, '_ACTIVE_TASK_DATA_DIR', data_dir)
    monkeypatch.setattr(srv, '_trigger_refresh', lambda: None)

    class FakeProcess:
        pid = None

        def __init__(self):
            self.returncode = None
            self.terminated = False

        def poll(self):
            return self.returncode

        def terminate(self):
            self.terminated = True
            self.returncode = -15

        def kill(self):
            self.terminated = True
            self.returncode = -9

        def wait(self, timeout=None):
            return self.returncode

    process = FakeProcess()
    record = {'cancel_event': threading.Event(), 'process': process}
    with srv._ACTIVE_DISPATCH_LOCK:
        srv._ACTIVE_DISPATCHES[task_id] = record

    result = srv.handle_task_action(task_id, 'cancel', '用户取消测试')
    assert result['ok'] is True
    assert process.terminated is True
    updated = json.loads(tasks_path.read_text(encoding='utf-8'))[0]
    assert updated['state'] == 'Cancelled'
    assert updated['now'] == '🚫 已取消：用户取消测试'
    with srv._ACTIVE_DISPATCH_LOCK:
        srv._ACTIVE_DISPATCHES.pop(task_id, None)


def test_disabled_dispatch_is_visible_in_scheduler(monkeypatch, tmp_path):
    """Safe mode must not leave a task looking like it is waiting for an Agent."""
    import server as srv

    data_dir = tmp_path / 'data'
    data_dir.mkdir()
    task_id = 'JJC-20260415-007'
    task = {
        'id': task_id,
        'title': '安全模式测试',
        'state': 'Taizi',
        'org': '太子',
        'now': '等待太子接旨分拣',
        'updatedAt': '2026-04-15T15:34:16Z',
    }
    tasks_path = data_dir / 'tasks_source.json'
    tasks_path.write_text(json.dumps([task], ensure_ascii=False), encoding='utf-8')
    (data_dir / 'agent_config.json').write_text('{}', encoding='utf-8')

    monkeypatch.setattr(srv, 'DATA', data_dir)
    monkeypatch.setattr(srv, '_ACTIVE_TASK_DATA_DIR', data_dir)
    monkeypatch.setattr(srv, '_trigger_refresh', lambda: None)
    monkeypatch.setenv('EDICT_AUTO_DISPATCH', '0')

    srv.dispatch_for_state(task_id, task, 'Taizi', trigger='test-safe-mode')

    updated = json.loads(tasks_path.read_text(encoding='utf-8'))[0]
    scheduler = updated['_scheduler']
    assert scheduler['lastDispatchStatus'] == 'disabled'
    assert scheduler['lastDispatchMode'] == 'disabled'
    assert '自动派发已关闭' in scheduler['lastDispatchError']
    assert updated['now'].startswith('⏸️')
    state = srv.get_scheduler_state(task_id)
    assert state['dispatchStatus'] == 'disabled'
    assert state['dispatchStatusLabel'] == '自动派发已关闭'
    assert state['dispatchNextAction'] == 'enable-auto-dispatch'


def test_startup_recovers_idle_active_task(monkeypatch, tmp_path):
    """Startup recovery must requeue legacy idle tasks instead of abandoning them."""
    import server as srv

    data_dir = tmp_path / 'data'
    data_dir.mkdir()
    task_id = 'JJC-20260415-008'
    task = {
        'id': task_id,
        'title': '启动恢复测试',
        'state': 'Taizi',
        'org': '太子',
        'updatedAt': '2026-04-15T15:34:16Z',
        '_scheduler': {
            'lastDispatchStatus': 'idle',
            'lastProgressAt': '2026-04-15T15:34:16Z',
        },
    }
    tasks_path = data_dir / 'tasks_source.json'
    tasks_path.write_text(json.dumps([task], ensure_ascii=False), encoding='utf-8')

    monkeypatch.setattr(srv, 'DATA', data_dir)
    monkeypatch.setattr(srv, '_ACTIVE_TASK_DATA_DIR', data_dir)
    monkeypatch.setattr(srv, '_trigger_refresh', lambda: None)
    monkeypatch.setenv('EDICT_AUTO_DISPATCH', '1')
    recovered = []
    monkeypatch.setattr(
        srv,
        'dispatch_for_state',
        lambda task_id_arg, task_arg, state_arg, trigger='state-transition': recovered.append(
            (task_id_arg, state_arg, trigger)
        ),
    )

    srv._startup_recover_queued_dispatches()

    assert recovered == [(task_id, 'Taizi', 'startup-recovery')]


def test_dispatch_attempt_id_prevents_stale_target(monkeypatch, tmp_path):
    """A replaced dispatch attempt must not continue operating on the old task stage."""
    import server as srv

    data_dir = tmp_path / 'data'
    data_dir.mkdir()
    task_id = 'JJC-20260415-009'
    task = {
        'id': task_id,
        'state': 'Taizi',
        'org': '太子',
        '_scheduler': {'dispatchAttemptId': 'new-attempt'},
    }
    tasks_path = data_dir / 'tasks_source.json'
    tasks_path.write_text(json.dumps([task], ensure_ascii=False), encoding='utf-8')
    monkeypatch.setattr(srv, 'DATA', data_dir)
    monkeypatch.setattr(srv, '_ACTIVE_TASK_DATA_DIR', data_dir)
    old_record = {'attemptId': 'old-attempt', 'cancel_event': threading.Event()}
    monkeypatch.setattr(srv, '_dispatch_is_current', lambda *_args: True)

    assert srv._dispatch_target_is_active(task_id, 'Taizi', old_record) is False


@pytest.mark.parametrize('department,agent_id', [
    ('礼部', 'libu'),
    ('户部', 'hubu'),
    ('兵部', 'bingbu'),
    ('刑部', 'xingbu'),
    ('工部', 'gongbu'),
    ('吏部', 'libu_hr'),
])
def test_six_ministry_execution_routes_to_fixed_agent(monkeypatch, tmp_path, department, agent_id):
    """Entering 六部 must use the explicitly assigned ministry Agent."""
    import server as srv

    data_dir = tmp_path / 'data'
    data_dir.mkdir()
    task_id = f'JJC-20260415-{agent_id}'
    task = {
        'id': task_id,
        'title': f'{department}执行路由测试',
        'state': 'Doing',
        'org': '尚书省',
        'targetDept': department,
        'updatedAt': '2026-04-15T15:34:16Z',
    }
    tasks_path = data_dir / 'tasks_source.json'
    tasks_path.write_text(json.dumps([task], ensure_ascii=False), encoding='utf-8')
    (data_dir / 'agent_config.json').write_text('{}', encoding='utf-8')
    source_path = tmp_path / 'openclaw.json'
    source_path.write_text(json.dumps({
        'agents': {
            'defaults': {'model': 'test/model'},
            'list': [{'id': agent_id, 'model': 'test/model'}],
        },
        'models': {'providers': {'test': {
            'baseUrl': 'http://127.0.0.1:1/v1',
            'api': 'openai-completions',
            'apiKey': {'source': 'env', 'provider': 'default', 'id': 'EDICT_PROVIDER_TEST_API_KEY'},
            'models': [{'id': 'model', 'name': 'Model'}],
        }}},
    }), encoding='utf-8')

    monkeypatch.setattr(srv, 'DATA', data_dir)
    monkeypatch.setattr(srv, '_ACTIVE_TASK_DATA_DIR', data_dir)
    monkeypatch.setattr(srv, '_trigger_refresh', lambda: None)
    monkeypatch.setenv('EDICT_AUTO_DISPATCH', '1')
    monkeypatch.setenv('EDICT_DESKTOP', '1')
    monkeypatch.setenv('OPENCLAW_CONFIG_PATH', str(source_path))
    monkeypatch.setenv('EDICT_PROVIDER_TEST_API_KEY', 'fixture-local-secret')
    monkeypatch.setattr(srv, '_resolve_openclaw_bin', lambda: '/fixture/openclaw')

    seen = {}

    class FakeProcess:
        pid = 12345

        def __init__(self):
            self.returncode = 0

        def communicate(self, timeout=None):
            return '{}', ''

        def poll(self):
            return self.returncode

        def terminate(self):
            self.returncode = -15

        def kill(self):
            self.returncode = -9

        def wait(self, timeout=None):
            return self.returncode

    def fake_popen(command, **options):
        seen['command'] = command
        return FakeProcess()

    monkeypatch.setattr(srv.subprocess, 'Popen', fake_popen)

    class ImmediateThread:
        def __init__(self, target=None, daemon=None):
            self.target = target

        def start(self):
            if self.target:
                self.target()

    monkeypatch.setattr(srv.threading, 'Thread', ImmediateThread)
    srv.dispatch_for_state(task_id, task, 'Doing', trigger='test-six-ministry')

    assert seen['command'][seen['command'].index('--agent') + 1] == agent_id
    updated = json.loads(tasks_path.read_text(encoding='utf-8'))[0]
    assert updated['org'] == department
    assert updated['targetDept'] == department
    assert updated['_scheduler']['lastDispatchStatus'] == 'success'


def test_legacy_execution_without_assignment_gets_deterministic_ministry(monkeypatch, tmp_path):
    """Legacy records get a fixed six-ministry route before entering Doing."""
    import server as srv

    data_dir = tmp_path / 'data'
    data_dir.mkdir()
    task_id = 'JJC-20260415-unassigned'
    task = {
        'id': task_id,
        'title': '等待尚书省指定执行部门',
        'state': 'Assigned',
        'org': '尚书省',
        'updatedAt': '2026-04-15T15:34:16Z',
    }
    tasks_path = data_dir / 'tasks_source.json'
    tasks_path.write_text(json.dumps([task], ensure_ascii=False), encoding='utf-8')
    monkeypatch.setattr(srv, 'DATA', data_dir)
    monkeypatch.setattr(srv, '_ACTIVE_TASK_DATA_DIR', data_dir)
    monkeypatch.setattr(srv, '_trigger_refresh', lambda: None)
    monkeypatch.setattr(srv, 'dispatch_for_state', lambda *args, **kwargs: None)

    result = srv.handle_advance_state(task_id)

    assert result['ok'] is True
    assert '已自动派发 Agent' in result['message']
    updated = json.loads(tasks_path.read_text(encoding='utf-8'))[0]
    assert updated['state'] == 'Doing'
    assert updated['org'] == '兵部'
    assert updated['targetDept'] == '兵部'


def test_stale_doing_task_resolves_to_fixed_agent_without_shangshu_guessing(monkeypatch, tmp_path):
    """Legacy org=太子 records resolve by title to a fixed ministry Agent."""
    import server as srv

    data_dir = tmp_path / 'data'
    data_dir.mkdir()
    task_id = 'JJC-20260415-stale-doing'
    task = {
        'id': task_id,
        'title': '修复历史错误执行路由',
        'state': 'Doing',
        'org': '太子',
        'updatedAt': '2026-04-15T15:34:16Z',
    }
    tasks_path = data_dir / 'tasks_source.json'
    tasks_path.write_text(json.dumps([task], ensure_ascii=False), encoding='utf-8')
    monkeypatch.setattr(srv, 'DATA', data_dir)
    monkeypatch.setattr(srv, '_ACTIVE_TASK_DATA_DIR', data_dir)
    monkeypatch.setattr(srv, '_trigger_refresh', lambda: None)
    department, agent_id = srv._resolve_execution_assignment(task)

    assert department == '兵部'
    assert agent_id == 'bingbu'


def test_activity_reader_ignores_non_object_jsonl_records(monkeypatch, tmp_path):
    """A malformed/legacy JSONL record must not hide the usable activity."""
    import server as srv

    sessions = tmp_path / 'agents' / 'taizi' / 'sessions'
    sessions.mkdir(parents=True)
    (sessions / 'session.jsonl').write_text(
        '"legacy string record"\n'
        + json.dumps({'timestamp': '2026-04-15T15:34:16Z', 'message': {
            'role': 'assistant', 'content': [{'type': 'text', 'text': '活动正常'}],
        }}, ensure_ascii=False)
        + '\n',
        encoding='utf-8',
    )
    monkeypatch.setattr(srv, 'OCLAW_HOME', tmp_path)
    monkeypatch.setattr(srv, 'DATA', tmp_path / 'data')

    activity = srv.get_agent_activity('taizi')

    assert activity[-1]['text'] == '活动正常'
