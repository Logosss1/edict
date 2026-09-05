import importlib.util
import json
import sys
from pathlib import Path
from types import SimpleNamespace


def _load_apply_model_changes():
    root = Path(__file__).resolve().parents[1]
    script_path = root / 'scripts' / 'apply_model_changes.py'
    if str(script_path.parent) not in sys.path:
        sys.path.insert(0, str(script_path.parent))
    spec = importlib.util.spec_from_file_location('apply_model_changes', script_path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _configure_paths(module, tmp_path, config, pending=None, profile=None):
    home = tmp_path / 'openclaw'
    data = tmp_path / 'data'
    home.mkdir()
    data.mkdir()
    providers = config.setdefault('models', {}).setdefault('providers', {})
    for change in [*(pending or []), *([profile] if profile else [])]:
        if not isinstance(change, dict) or not change.get('model'):
            continue
        reference = change['model']
        if change.get('providerId') and not reference.startswith(change['providerId'] + '/'):
            reference = change['providerId'] + '/' + reference
        if '/' in reference:
            provider, model = reference.split('/', 1)
            providers.setdefault(provider, {'models': []})['models'].append({
                'id': model, 'compat': {'supportedReasoningEfforts': ['low', 'medium', 'high', 'xhigh', 'max']}})
    config_path = home / 'openclaw.json'
    config_path.write_text(json.dumps(config), encoding='utf-8')
    if pending is not None:
        (data / 'pending_model_changes.json').write_text(json.dumps(pending), encoding='utf-8')
    if profile is not None:
        (data / 'pending_model_profile.json').write_text(json.dumps(profile), encoding='utf-8')

    module.OPENCLAW_CFG = config_path
    module.DATA = data
    module.PENDING = data / 'pending_model_changes.json'
    module.PENDING_PROFILE = data / 'pending_model_profile.json'
    module.CHANGE_LOG = data / 'model_change_log.json'
    return config_path, data


def _skip_gateway_restart(monkeypatch):
    monkeypatch.setenv('EDICT_SKIP_GATEWAY_RESTART', '1')


def test_profile_sets_defaults_and_clears_agent_overrides_without_losing_other_fields(tmp_path, monkeypatch):
    apply_model_changes = _load_apply_model_changes()
    config_path, data = _configure_paths(
        apply_model_changes,
        tmp_path,
        {
            'agents': {
                'defaults': {
                    'model': {'primary': 'old-provider/default', 'fallbacks': ['old-provider/fallback']},
                    'thinkingDefault': 'low',
                },
                'list': [
                    {
                        'id': 'taizi',
                        'workspace': '/work/taizi',
                        'skills': ['review'],
                        'model': 'old-provider/taizi',
                        'thinkingDefault': 'high',
                        'subagents': {'allowAgents': ['zhongshu']},
                    },
                    {
                        'id': 'zhongshu',
                        'workspace': '/work/zhongshu',
                        'skills': ['plan'],
                        'tools': {'profile': 'coding'},
                    },
                ],
            },
            'mcp': {'servers': {'research': {'type': 'http', 'url': 'https://example.test/mcp'}}},
        },
        profile={'providerId': 'demo-provider', 'model': 'gpt-5.6-terra', 'thinkingDefault': 'xhigh'},
    )
    _skip_gateway_restart(monkeypatch)

    apply_model_changes.main()

    config = json.loads(config_path.read_text(encoding='utf-8'))
    result = json.loads((data / 'last_model_change_result.json').read_text(encoding='utf-8'))
    assert config['agents']['defaults']['model'] == {
        'primary': 'demo-provider/gpt-5.6-terra',
        'fallbacks': ['old-provider/fallback'],
    }
    assert config['agents']['defaults']['thinkingDefault'] == 'xhigh'
    assert 'model' not in config['agents']['list'][0]
    assert 'thinkingDefault' not in config['agents']['list'][0]
    assert config['agents']['list'][0]['workspace'] == '/work/taizi'
    assert config['agents']['list'][0]['skills'] == ['review']
    assert config['agents']['list'][1]['skills'] == ['plan']
    assert config['agents']['list'][1]['tools'] == {'profile': 'coding'}
    assert config['mcp']['servers']['research']['url'] == 'https://example.test/mcp'
    assert result['scope'] == 'profile'
    assert result['applied'][0]['clearedAgentOverrides'] == 1
    assert result['applied'][0]['newThinkingDefault'] == 'xhigh'
    assert not (data / 'pending_model_profile.json').exists()


def test_profile_wins_over_queued_individual_agent_changes(tmp_path, monkeypatch):
    apply_model_changes = _load_apply_model_changes()
    config_path, data = _configure_paths(
        apply_model_changes,
        tmp_path,
        {
            'agents': {
                'defaults': {'model': {'primary': 'old/default'}, 'thinkingDefault': 'medium'},
                'list': [
                    {'id': 'taizi', 'model': 'old/taizi'},
                    {'id': 'zhongshu', 'model': 'old/zhongshu'},
                ],
            },
        },
        pending=[
            {'agentId': 'taizi', 'model': 'should-not-win/one'},
            {'agentId': 'zhongshu', 'model': 'should-not-win/two'},
        ],
        profile={'providerId': 'new', 'model': 'shared-model', 'thinkingDefault': 'high'},
    )
    _skip_gateway_restart(monkeypatch)

    apply_model_changes.main()

    config = json.loads(config_path.read_text(encoding='utf-8'))
    result = json.loads((data / 'last_model_change_result.json').read_text(encoding='utf-8'))
    assert config['agents']['defaults']['model']['primary'] == 'new/shared-model'
    assert config['agents']['defaults']['thinkingDefault'] == 'high'
    assert all('model' not in agent for agent in config['agents']['list'])
    assert result['scope'] == 'profile'
    assert result['ignoredIndividualChanges'] == 2
    assert json.loads((data / 'pending_model_changes.json').read_text(encoding='utf-8')) == []
    log = json.loads((data / 'model_change_log.json').read_text(encoding='utf-8'))
    assert log[-1]['scope'] == 'profile'
    assert log[-1]['agentId'] == 'all-agents'


def test_invalid_profile_thinking_level_reports_error_without_changing_configuration(tmp_path, monkeypatch):
    apply_model_changes = _load_apply_model_changes()
    initial = {
        'agents': {
            'defaults': {'model': {'primary': 'old/default'}, 'thinkingDefault': 'medium'},
            'list': [{'id': 'taizi', 'model': 'old/taizi', 'thinkingDefault': 'high'}],
        },
    }
    config_path, data = _configure_paths(
        apply_model_changes,
        tmp_path,
        initial,
        profile={'providerId': 'new', 'model': 'shared-model', 'thinkingDefault': 'ultra'},
    )
    _skip_gateway_restart(monkeypatch)

    apply_model_changes.main()

    assert json.loads(config_path.read_text(encoding='utf-8')) == initial
    result = json.loads((data / 'last_model_change_result.json').read_text(encoding='utf-8'))
    assert result['scope'] == 'profile'
    assert result['applied'] == []
    assert 'ultra 不在可用档位中' in result['errors'][0]['error']
    assert not (data / 'pending_model_profile.json').exists()


def test_gateway_restart_failure_retains_model_configuration(tmp_path, monkeypatch):
    apply_model_changes = _load_apply_model_changes()
    config_path, data = _configure_paths(
        apply_model_changes,
        tmp_path,
        {'agents': {'list': [{'id': 'taizi', 'model': 'old-provider/old'}]}},
        pending=[{'agentId': 'taizi', 'model': 'demo-provider/gpt-5.6-terra'}],
    )
    monkeypatch.delenv('EDICT_SKIP_GATEWAY_RESTART', raising=False)
    monkeypatch.setenv('EDICT_ROLLBACK_ON_GATEWAY_RESTART_FAILURE', '0')
    monkeypatch.setattr(
        apply_model_changes.subprocess,
        'run',
        lambda *args, **kwargs: SimpleNamespace(returncode=1, stdout='', stderr='gateway unavailable'),
    )

    apply_model_changes.main()

    config = json.loads(config_path.read_text(encoding='utf-8'))
    result = json.loads((data / 'last_model_change_result.json').read_text(encoding='utf-8'))
    log = json.loads((data / 'model_change_log.json').read_text(encoding='utf-8'))
    assert config['agents']['list'][0]['model'] == 'demo-provider/gpt-5.6-terra'
    assert result['rolledBack'] is False
    assert result['configurationRetained'] is True
    assert result['gatewayRestarted'] is False
    assert result['gatewayRestartError'] == 'gateway restart failed'
    assert log[-1]['newModel'] == 'demo-provider/gpt-5.6-terra'
    assert 'rolledBack' not in log[-1]


def test_model_only_change_preserves_none_semantics_instead_of_reusing_carrier(tmp_path):
    module = _load_apply_model_changes()
    module.DATA = tmp_path
    config = {
        'models': {'providers': {'custom': {'api': 'openai-completions', 'models': [
            {'id': 'gpt-5.6-sol'},
            {'id': 'minimal-native', 'compat': {'supportedReasoningEfforts': ['minimal', 'high']}},
            {'id': 'other-none', 'api': 'anthropic-messages', 'compat': {'supportedReasoningEfforts': ['none', 'high']}},
        ]}}},
        'agents': {'defaults': {'model': 'custom/gpt-5.6-sol', 'thinkingDefault': 'minimal'},
                   'list': [{'id': 'taizi'}]},
    }
    _, applied, errors = module._apply_agent_changes(config, [{'agentId': 'taizi', 'model': 'custom/minimal-native'}])
    assert applied == []
    assert 'none' in errors[0]['error']
    updated, applied, errors = module._apply_agent_changes(config, [{'agentId': 'taizi', 'model': 'custom/other-none'}])
    assert len(applied) == 1
    assert errors == []
    assert updated['agents']['list'][0]['thinkingDefault'] == 'off'
