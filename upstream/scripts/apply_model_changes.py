#!/usr/bin/env python3
"""Apply queued EDICT model changes to OpenClaw and restart the Gateway safely."""
import copy
import datetime
import glob
import json
import logging
import os
import pathlib
import shutil
import subprocess
import tempfile
from contextlib import contextmanager

from file_lock import _lock_exclusive, _lock_path, _unlock, atomic_json_write
from utils import get_openclaw_home
from model_capabilities import LEVELS, apply_definitions, model_thinking, validate

log = logging.getLogger('model_change')
logging.basicConfig(level=logging.INFO, format='%(asctime)s [%(name)s] %(message)s', datefmt='%H:%M:%S')

BASE = pathlib.Path(__file__).parent.parent
DATA = pathlib.Path(os.environ.get('EDICT_DATA_DIR', str(BASE / 'data'))).expanduser().resolve()
OPENCLAW_HOME = get_openclaw_home()
OPENCLAW_CFG = OPENCLAW_HOME / 'openclaw.json'
PENDING = DATA / 'pending_model_changes.json'
PENDING_PROFILE = DATA / 'pending_model_profile.json'
CHANGE_LOG = DATA / 'model_change_log.json'
MAX_BACKUPS = 10
THINKING_LEVELS = set(LEVELS) | {'off'}


def env_flag(name, default=False):
    value = os.environ.get(name)
    if value is None:
        return default
    return value.strip().lower() in {'1', 'true', 'yes', 'on'}


def rj(path, default):
    try:
        return json.loads(path.read_text(encoding='utf-8'))
    except Exception:
        return default


def _read_queued_json(path, default):
    """Read an already queue-locked JSON file without surfacing raw input."""
    if not path.exists():
        return default, None, False
    try:
        return json.loads(path.read_text(encoding='utf-8')), None, True
    except Exception:
        return default, 'invalid JSON', True


def _write_locked_json(path, value):
    """Atomically replace a JSON file while its companion lock is held."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(dir=str(path.parent), suffix='.tmp', prefix=path.stem + '_')
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as handle:
            json.dump(value, handle, ensure_ascii=False, indent=2)
        os.replace(tmp_name, str(path))
    except Exception:
        try:
            os.unlink(tmp_name)
        except OSError:
            pass
        raise


@contextmanager
def _queue_transaction_lock():
    """Serialize applicators and queue producers for the whole read/apply/clear cycle."""
    lock_paths = sorted({_lock_path(PENDING), _lock_path(PENDING_PROFILE)}, key=lambda path: str(path))
    fds = []
    try:
        for lock_path in lock_paths:
            lock_path.parent.mkdir(parents=True, exist_ok=True)
            fd = os.open(str(lock_path), os.O_CREAT | os.O_RDWR)
            _lock_exclusive(fd)
            fds.append(fd)
        yield
    finally:
        for fd in reversed(fds):
            _unlock(fd)
            os.close(fd)


def _text(value):
    return value.strip() if isinstance(value, str) else ''


def _primary_model(value):
    if isinstance(value, dict):
        return _text(value.get('primary'))
    return _text(value)


def _profile_model(provider_id, model):
    """Accept either a model ID plus provider or an already-qualified model reference."""
    if provider_id and not model.startswith(provider_id + '/'):
        return f'{provider_id}/{model}'
    return model


def _profile_from_pending(raw):
    """Validate the narrow model-profile schema without echoing the input back."""
    if not isinstance(raw, dict):
        return None, 'pending model profile must be a JSON object'

    provider_id = raw.get('providerId')
    if provider_id is not None and not isinstance(provider_id, str):
        return None, 'providerId must be a string when provided'
    provider_id = _text(provider_id)

    model = _text(raw.get('model'))
    if not model:
        return None, 'model is required'
    if len(model) > 500:
        return None, 'model is too long'

    thinking_default = _text(raw.get('thinkingDefault')).lower()
    if thinking_default not in THINKING_LEVELS:
        return None, 'thinkingDefault is not a recognized reasoning level'

    return {
        'providerId': provider_id or None,
        'model': _profile_model(provider_id, model),
        'thinkingDefault': thinking_default,
    }, None


def _agents_config(cfg):
    agents = cfg.get('agents') if isinstance(cfg, dict) else None
    return agents if isinstance(agents, dict) else {}


def _agents_list(agents_cfg):
    value = agents_cfg.get('list')
    return copy.deepcopy(value) if isinstance(value, list) else []


def _defaults_config(agents_cfg):
    value = agents_cfg.get('defaults')
    return copy.deepcopy(value) if isinstance(value, dict) else {}


def _with_agents_config(cfg, agents_cfg, agents_list, defaults_cfg):
    next_cfg = copy.deepcopy(cfg) if isinstance(cfg, dict) else {}
    next_agents = copy.deepcopy(agents_cfg)
    next_agents['list'] = agents_list
    next_agents['defaults'] = defaults_cfg
    next_cfg['agents'] = next_agents
    return next_cfg


def _apply_profile(cfg, profile):
    thinking = validate(cfg, DATA, profile['thinkingDefault'], model=profile['model'])
    cfg = apply_definitions(cfg, DATA)
    agents_cfg = _agents_config(cfg)
    agents_list = _agents_list(agents_cfg)
    defaults_cfg = _defaults_config(agents_cfg)
    old_model = _primary_model(defaults_cfg.get('model'))
    old_thinking = _text(defaults_cfg.get('thinkingDefault')) or None

    model_cfg = defaults_cfg.get('model')
    model_cfg = copy.deepcopy(model_cfg) if isinstance(model_cfg, dict) else {}
    model_cfg['primary'] = profile['model']
    defaults_cfg['model'] = model_cfg
    if thinking == 'default':
        defaults_cfg.pop('thinkingDefault', None)
    else:
        defaults_cfg['thinkingDefault'] = thinking

    cleared = 0
    for agent in agents_list:
        if not isinstance(agent, dict):
            continue
        had_override = 'model' in agent or 'thinkingDefault' in agent
        agent.pop('model', None)
        agent.pop('thinkingDefault', None)
        if had_override:
            cleared += 1

    record = {
        'at': datetime.datetime.now().isoformat(),
        'scope': 'profile',
        'agentId': 'all-agents',
        'oldModel': old_model,
        'newModel': profile['model'],
        'oldThinkingDefault': old_thinking,
        'newThinkingDefault': profile['thinkingDefault'],
        'clearedAgentOverrides': cleared,
    }
    return _with_agents_config(cfg, agents_cfg, agents_list, defaults_cfg), record


def _apply_agent_changes(cfg, pending):
    agents_cfg = _agents_config(cfg)
    agents_list = _agents_list(agents_cfg)
    defaults_cfg = _defaults_config(agents_cfg)
    default_model = _primary_model(defaults_cfg.get('model'))
    applied, errors = [], []

    for change in pending:
        if not isinstance(change, dict):
            errors.append({'scope': 'agent', 'error': 'queued model change must be an object'})
            continue
        agent_id = _text(change.get('agentId'))
        new_model = _text(change.get('model'))
        if not agent_id or not new_model:
            errors.append({'scope': 'agent', 'agentId': agent_id or None, 'error': 'agentId and model are required'})
            continue

        for agent in agents_list:
            if not isinstance(agent, dict) or agent.get('id') != agent_id:
                continue
            old_model = _primary_model(agent.get('model')) or default_model
            try:
                old_thinking = agent.get('thinkingDefault', defaults_cfg.get('thinkingDefault', 'default'))
                requested_thinking = model_thinking(cfg, DATA, old_model, old_thinking)
                new_thinking = validate(cfg, DATA, requested_thinking, model=new_model)
            except ValueError as exc:
                errors.append({'scope': 'agent', 'agentId': agent_id, 'error': str(exc)})
                break
            if new_model == default_model:
                agent.pop('model', None)
            else:
                agent['model'] = new_model
            if new_thinking != old_thinking:
                if new_thinking == 'default':
                    agent.pop('thinkingDefault', None)
                else:
                    agent['thinkingDefault'] = new_thinking
            applied.append({
                'at': datetime.datetime.now().isoformat(),
                'scope': 'agent',
                'agentId': agent_id,
                'oldModel': old_model,
                'newModel': new_model,
            })
            break
        else:
            errors.append({'scope': 'agent', 'agentId': agent_id, 'error': 'agent not found'})

    return apply_definitions(_with_agents_config(cfg, agents_cfg, agents_list, defaults_cfg), DATA), applied, errors


def cleanup_backups():
    """Keep only the most recent model-change backups."""
    pattern = str(OPENCLAW_CFG.parent / 'openclaw.json.bak.model-*')
    backups = sorted(glob.glob(pattern))
    for old in backups[:-MAX_BACKUPS]:
        try:
            pathlib.Path(old).unlink()
        except OSError:
            pass


def _write_config_with_backup(cfg, changed):
    if not changed:
        return None
    backup_path = None
    if OPENCLAW_CFG.exists():
        backup_path = OPENCLAW_CFG.parent / (
            f'openclaw.json.bak.model-{datetime.datetime.now().strftime("%Y%m%d-%H%M%S-%f")}'
        )
        shutil.copy2(OPENCLAW_CFG, backup_path)
        cleanup_backups()
    atomic_json_write(OPENCLAW_CFG, cfg)
    return backup_path


def _restart_gateway(backup_path, applied, changed):
    """Preserve the existing rollback/retention behavior without logging command output."""
    result = {
        'gatewayRestarted': False,
        'gatewayRestartSkipped': False,
        'rolledBack': False,
        'rollbackOnGatewayRestartFailure': env_flag('EDICT_ROLLBACK_ON_GATEWAY_RESTART_FAILURE', True),
        'configurationRetained': not changed,
    }
    if not changed:
        return result

    restart_skipped = env_flag('EDICT_SKIP_GATEWAY_RESTART')
    result['gatewayRestartSkipped'] = restart_skipped
    if restart_skipped:
        log.info('scope=model-change gateway restart skipped by EDICT_SKIP_GATEWAY_RESTART')
        result['configurationRetained'] = True
        return result

    try:
        from openclaw_runtime import resolve_openclaw_bin, runtime_environment
        openclaw_bin = resolve_openclaw_bin()
        if not openclaw_bin:
            raise RuntimeError('OpenClaw 未找到，请在设置中检查运行依赖')
        run = subprocess.run([openclaw_bin, 'gateway', 'restart'], capture_output=True, text=True, timeout=30, env=runtime_environment())
        result['gatewayRestarted'] = run.returncode == 0
        log.info('scope=model-change gateway restart rc=%s', run.returncode)
        failed = run.returncode != 0
    except Exception as exc:
        failed = True
        log.error('scope=model-change gateway restart invocation failed (%s)', type(exc).__name__)

    if not failed:
        return result

    result['gatewayRestartError'] = 'gateway restart failed'
    if result['rollbackOnGatewayRestartFailure'] and backup_path:
        shutil.copy2(backup_path, OPENCLAW_CFG)
        log.warning('scope=model-change gateway restart failed; rolled back openclaw.json from backup')
        result['rolledBack'] = True
        for entry in applied:
            entry['rolledBack'] = True
    else:
        log.warning('scope=model-change gateway restart failed; retaining the model configuration')
        result['configurationRetained'] = True
    return result


def _append_change_log(applied):
    if not applied:
        return
    log_data = rj(CHANGE_LOG, [])
    if not isinstance(log_data, list):
        log_data = []
    log_data.extend(applied)
    atomic_json_write(CHANGE_LOG, log_data[-200:])
    for entry in applied:
        log.info(
            'scope=%s agent=%s model changed',
            entry.get('scope', 'agent'),
            entry.get('agentId', 'unknown'),
        )


def _write_result(scope, applied, errors, **extra):
    for error in errors:
        log.warning('scope=%s error=%s', error.get('scope', scope), error.get('error', 'unknown error'))
    result = {
        'at': datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S'),
        'scope': scope,
        'applied': applied,
        'errors': errors,
        **extra,
    }
    atomic_json_write(DATA / 'last_model_change_result.json', result)
    return result


def _clear_consumed_queues(clear_agents=False, clear_profile=False):
    if clear_agents:
        _write_locked_json(PENDING, [])
    if clear_profile and PENDING_PROFILE.exists():
        PENDING_PROFILE.unlink()


def main():
    """Apply a queued global profile or the existing queued per-agent changes."""
    with _queue_transaction_lock():
        raw_pending, pending_read_error, pending_exists = _read_queued_json(PENDING, [])
        raw_profile, profile_read_error, profile_exists = _read_queued_json(PENDING_PROFILE, None)
        if not pending_exists and not profile_exists:
            return None

        errors = []
        pending = []
        if pending_exists:
            if pending_read_error:
                errors.append({'scope': 'agent', 'error': 'pending model changes contain invalid JSON'})
            elif not isinstance(raw_pending, list):
                errors.append({'scope': 'agent', 'error': 'pending model changes must be a list'})
            else:
                pending = raw_pending

        profile = None
        profile_invalid = False
        if profile_exists:
            if profile_read_error:
                errors.append({'scope': 'profile', 'error': 'pending model profile contains invalid JSON'})
                profile_invalid = True
            else:
                profile, profile_error = _profile_from_pending(raw_profile)
                if profile_error:
                    errors.append({'scope': 'profile', 'error': profile_error})
                    profile_invalid = True
                elif profile is not None:
                    try:
                        validate(rj(OPENCLAW_CFG, {}), DATA, profile['thinkingDefault'], model=profile['model'])
                    except ValueError as exc:
                        errors.append({'scope': 'profile', 'error': str(exc)})
                        profile, profile_invalid = None, True

        # A valid all-Agent profile intentionally discards the older individual queue.
        if profile is not None:
            cfg = rj(OPENCLAW_CFG, {})
            cfg = cfg if isinstance(cfg, dict) else {}
            try:
                next_cfg, profile_record = _apply_profile(cfg, profile)
            except ValueError as exc:
                _clear_consumed_queues(clear_profile=True)
                return _write_result('profile', [], [{'scope': 'profile', 'error': str(exc)}], configurationRetained=True)
            changed = json.dumps(cfg, ensure_ascii=False, sort_keys=True) != json.dumps(next_cfg, ensure_ascii=False, sort_keys=True)
            try:
                backup_path = _write_config_with_backup(next_cfg, changed)
            except Exception as exc:
                errors.append({'scope': 'profile', 'error': 'failed to write OpenClaw configuration'})
                log.error('scope=profile configuration write failed (%s)', type(exc).__name__)
                return _write_result('profile', [], errors, configurationRetained=False)

            restart = _restart_gateway(backup_path, [profile_record], changed)
            _append_change_log([profile_record])
            _clear_consumed_queues(clear_agents=pending_exists, clear_profile=True)
            return _write_result(
                'profile',
                [profile_record],
                errors,
                ignoredIndividualChanges=len(pending),
                **restart,
            )

        # Invalid profile input is consumed, but it does not prevent an unrelated valid
        # per-Agent change from being applied in the same invocation.
        if pending:
            cfg = rj(OPENCLAW_CFG, {})
            cfg = cfg if isinstance(cfg, dict) else {}
            next_cfg, applied, agent_errors = _apply_agent_changes(cfg, pending)
            errors.extend(agent_errors)
            if applied:
                changed = json.dumps(cfg, ensure_ascii=False, sort_keys=True) != json.dumps(next_cfg, ensure_ascii=False, sort_keys=True)
                try:
                    backup_path = _write_config_with_backup(next_cfg, changed)
                except Exception as exc:
                    errors.append({'scope': 'agent', 'error': 'failed to write OpenClaw configuration'})
                    log.error('scope=agent configuration write failed (%s)', type(exc).__name__)
                    if profile_invalid:
                        _clear_consumed_queues(clear_profile=True)
                    return _write_result('agent', [], errors, configurationRetained=False)

                restart = _restart_gateway(backup_path, applied, changed)
                _append_change_log(applied)
                _clear_consumed_queues(clear_agents=True, clear_profile=profile_invalid)
                return _write_result('agent', applied, errors, **restart)

        # Nothing could be applied. Consume malformed/empty queues so they cannot trap
        # future changes behind a permanent parse error.
        # Every consumed queue is cleared once it has been classified.  In
        # particular, a non-empty queue containing only malformed/unknown
        # changes must not be retried forever on every applicator run.
        clear_agents = pending_exists
        _clear_consumed_queues(clear_agents=clear_agents, clear_profile=profile_invalid)
        scope = 'profile' if profile_exists else 'agent'
        return _write_result(scope, [], errors, configurationRetained=True)


if __name__ == '__main__':
    main()
