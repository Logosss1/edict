#!/usr/bin/env python3
"""
同步 openclaw.json 中的 agent 配置 → data/agent_config.json
支持自动发现 agent workspace 下的 Skills 目录
"""
import json, os, pathlib, datetime, logging
from file_lock import atomic_json_write
from utils import get_openclaw_home

log = logging.getLogger('sync_agent_config')
logging.basicConfig(level=logging.INFO, format='%(asctime)s [%(name)s] %(message)s', datefmt='%H:%M:%S')

# Auto-detect project root (parent of scripts/)
BASE = pathlib.Path(__file__).parent.parent
DATA = pathlib.Path(os.environ.get('EDICT_DATA_DIR', str(BASE / 'data'))).expanduser().resolve()
OPENCLAW_HOME = get_openclaw_home()
OPENCLAW_CFG = OPENCLAW_HOME / 'openclaw.json'
_INITIAL_OPENCLAW_HOME = OPENCLAW_HOME
_INITIAL_OPENCLAW_CFG = OPENCLAW_CFG

ID_LABEL = {
    'taizi':    {'label': '太子',   'role': '太子',     'duty': '飞书消息分拣与回奏',  'emoji': '🤴'},
    'main':     {'label': '太子',   'role': '太子',     'duty': '飞书消息分拣与回奏',  'emoji': '🤴'},  # 兼容旧配置
    'zhongshu': {'label': '中书省', 'role': '中书令',   'duty': '起草任务令与优先级',  'emoji': '📜'},
    'menxia':   {'label': '门下省', 'role': '侍中',     'duty': '审议与退回机制',      'emoji': '🔍'},
    'shangshu': {'label': '尚书省', 'role': '尚书令',   'duty': '派单与升级裁决',      'emoji': '📮'},
    'libu':     {'label': '礼部',   'role': '礼部尚书', 'duty': '文档/汇报/规范',      'emoji': '📝'},
    'hubu':     {'label': '户部',   'role': '户部尚书', 'duty': '资源/预算/成本',      'emoji': '💰'},
    'bingbu':   {'label': '兵部',   'role': '兵部尚书', 'duty': '工程实现与架构设计',  'emoji': '⚔️'},
    'xingbu':   {'label': '刑部',   'role': '刑部尚书', 'duty': '合规/审计/红线',      'emoji': '⚖️'},
    'gongbu':   {'label': '工部',   'role': '工部尚书', 'duty': '基础设施与部署运维',  'emoji': '🔧'},
    'libu_hr':  {'label': '吏部',   'role': '吏部尚书', 'duty': '人事/培训/Agent管理',  'emoji': '👔'},
    'zaochao':  {'label': '钦天监', 'role': '朝报官',   'duty': '每日新闻采集与简报',  'emoji': '📰'},
}

# Model choices come only from providers configured by the user. The old
# upstream version shipped a demo catalog here, which made unusable built-in
# models appear in the desktop picker and could silently select them.
KNOWN_MODELS = []
BUILTIN_PROVIDER_IDS = {
    'anthropic',
    'openai',
    'openai-codex',
    'google',
    'copilot',
    'github-copilot',
}


def _runtime_openclaw_home(config_path=None):
    """Return the active OpenClaw home derived from the active config path.

    ``OPENCLAW_CFG`` is intentionally looked up at call time.  Desktop tests
    and custom installations can replace that path after this module imports;
    using the import-time ``OPENCLAW_HOME`` in those cases would write SOUL and
    script files into an unrelated user's real OpenClaw directory.
    """
    if config_path is not None:
        return pathlib.Path(config_path).expanduser().parent

    # A caller may replace either module-level path (desktop integration and
    # tests do this), while the legacy tests replace Path.home() after import.
    # Respect explicit replacements first, then resolve the default lazily so
    # late environment/home overrides still behave like the original script.
    active_cfg = pathlib.Path(OPENCLAW_CFG).expanduser()
    if active_cfg != pathlib.Path(_INITIAL_OPENCLAW_CFG).expanduser():
        return active_cfg.parent
    active_home = pathlib.Path(OPENCLAW_HOME).expanduser()
    if active_home != pathlib.Path(_INITIAL_OPENCLAW_HOME).expanduser():
        return active_home
    return pathlib.Path(get_openclaw_home()).expanduser()


def normalize_model(model_value, fallback='unknown'):
    if isinstance(model_value, str) and model_value:
        return model_value
    if isinstance(model_value, dict):
        return model_value.get('primary') or model_value.get('id') or fallback
    return fallback


def _model_provider(model_value):
    if not isinstance(model_value, str) or '/' not in model_value:
        return ''
    return model_value.split('/', 1)[0].strip().lower()


def _is_custom_provider(provider_id):
    return isinstance(provider_id, str) and provider_id.strip().lower() not in BUILTIN_PROVIDER_IDS


def _iter_openclaw_provider_models(cfg):
    """Yield ``(provider_id, model_id)`` pairs from supported OpenClaw layouts.

    OpenClaw has used both a legacy top-level ``providers`` catalog and the
    native ``models.providers`` catalog.  Keep the reader tolerant of either
    shape because EDICT may be opened against an existing user config during a
    migration.  Provider entries that are malformed are ignored rather than
    making the whole agent sync fail.
    """
    if not isinstance(cfg, dict):
        return

    catalogs = []
    legacy = cfg.get('providers')
    if isinstance(legacy, dict):
        catalogs.append(legacy)
    models_cfg = cfg.get('models')
    if isinstance(models_cfg, dict):
        native = models_cfg.get('providers')
        if isinstance(native, dict):
            catalogs.append(native)

    for catalog in catalogs:
        for provider_id, provider_cfg in catalog.items():
            if not isinstance(provider_id, str) or not provider_id.strip() or not isinstance(provider_cfg, dict):
                continue
            configured_models = provider_cfg.get('models')
            if isinstance(configured_models, dict):
                # Be liberal with provider catalogs that represent models as a
                # map keyed by model id instead of an array of definitions.
                entries = [
                    {'id': model_id}
                    if isinstance(model_id, str) else model_value
                    for model_id, model_value in configured_models.items()
                ]
            elif isinstance(configured_models, list):
                entries = configured_models
            else:
                continue
            for model_value in entries:
                if isinstance(model_value, str):
                    model_id = model_value.strip()
                elif isinstance(model_value, dict):
                    model_id = model_value.get('id') or model_value.get('name') or ''
                    model_id = model_id.strip() if isinstance(model_id, str) else ''
                else:
                    model_id = ''
                if model_id:
                    yield provider_id.strip(), model_id


def _custom_model_catalog(cfg):
    """Return custom provider model references and unqualified-id matches."""
    references = []
    by_id = {}
    seen = set()
    for provider_id, model_id in _iter_openclaw_provider_models(cfg):
        if not _is_custom_provider(provider_id):
            continue
        provider_id = provider_id.strip()
        reference = f'{provider_id}/{model_id}'
        if reference in seen:
            continue
        seen.add(reference)
        references.append((reference, provider_id, model_id))
        by_id.setdefault(model_id, []).append(reference)
    return references, by_id


def _custom_model_value(value, by_id=None):
    """Normalize a configured model while hiding unsupported built-ins."""
    model = normalize_model(value, 'unknown')
    if not model or model == 'unknown':
        return 'unknown'
    provider = _model_provider(model)
    if provider:
        return 'unknown' if provider in BUILTIN_PROVIDER_IDS else model
    matches = (by_id or {}).get(model, [])
    if len(matches) == 1:
        return matches[0]
    # A bare model id cannot be safely assigned without a provider.
    return 'unknown'


def get_skills(workspace: str):
    skills_dir = pathlib.Path(workspace) / 'skills'
    skills = []
    try:
        if skills_dir.exists():
            for d in sorted(skills_dir.iterdir()):
                if d.is_dir():
                    md = d / 'SKILL.md'
                    desc = ''
                    if md.exists():
                        try:
                            for line in md.read_text(encoding='utf-8', errors='ignore').splitlines():
                                line = line.strip()
                                if line and not line.startswith('#') and not line.startswith('---'):
                                    desc = line[:100]
                                    break
                        except Exception:
                            desc = '(读取失败)'
                    skills.append({'name': d.name, 'path': str(md), 'exists': md.exists(), 'description': desc})
    except PermissionError as e:
        log.warning(f'Skills 目录访问受限: {e}')
    return skills


def _collect_openclaw_models(cfg):
    """从自定义供应商目录收集完整的 ``provider/model`` 引用。

    不再合并上游的内置/演示模型，也不把没有供应商归属的裸模型 id
    暴露给 Agent 选择器。这样模型列表与桌面供应商设置保持同一来源。
    """
    references, by_id = _custom_model_catalog(cfg)
    models = []
    seen_ids = set()

    def add_model(value, provider_hint=''):
        model = _custom_model_value(value, by_id)
        if model == 'unknown' or model in seen_ids:
            return
        provider = _model_provider(model) or provider_hint or 'custom'
        model_id = model.split('/', 1)[1] if '/' in model else model
        models.append({'id': model, 'label': model_id, 'provider': provider})
        seen_ids.add(model)

    # Provider catalogs are authoritative and preserve models that have not
    # yet been selected by an Agent.
    for reference, provider_id, _model_id in references:
        add_model(reference, provider_id)

    agents_cfg = cfg.get('agents', {}) if isinstance(cfg, dict) else {}
    if not isinstance(agents_cfg, dict):
        agents_cfg = {}
    defaults = agents_cfg.get('defaults', {})
    if not isinstance(defaults, dict):
        defaults = {}
    raw_default = defaults.get('model', '')
    add_model(raw_default, _model_provider(normalize_model(raw_default, '')))
    defaults_models = defaults.get('models', {})
    if isinstance(defaults_models, dict):
        for model_id in defaults_models.keys():
            add_model(model_id, _model_provider(model_id))
    agent_entries = agents_cfg.get('list', [])
    if isinstance(agent_entries, list):
        for agent in agent_entries:
            if isinstance(agent, dict):
                raw_model = agent.get('model', '')
                add_model(raw_model, _model_provider(normalize_model(raw_model, '')))
    return models


def main():
    runtime_home = _runtime_openclaw_home()
    cfg = {}
    try:
        cfg = json.loads(OPENCLAW_CFG.read_text(encoding='utf-8'))
    except Exception as e:
        log.warning(f'cannot read openclaw.json: {e}')
        return

    agents_cfg = cfg.get('agents', {})
    if not isinstance(agents_cfg, dict):
        agents_cfg = {}
    defaults_cfg = agents_cfg.get('defaults', {})
    if not isinstance(defaults_cfg, dict):
        defaults_cfg = {}
    _custom_refs, custom_by_id = _custom_model_catalog(cfg)
    default_model = _custom_model_value(defaults_cfg.get('model', {}), custom_by_id)
    # An explicitly present agents.list is the runtime registration source of
    # truth.  Older EDICT installations omitted the field entirely and still
    # need the compatibility entries below, but adding those entries to a
    # configured list makes agent_config.json disagree with OpenClaw itself.
    has_explicit_agent_list = 'list' in agents_cfg
    agents_list = agents_cfg.get('list', [])
    if not isinstance(agents_list, list):
        agents_list = []
    merged_models = _collect_openclaw_models(cfg)

    result = []
    seen_ids = set()
    for ag in agents_list:
        if not isinstance(ag, dict):
            continue
        ag_id = ag.get('id', '')
        if ag_id not in ID_LABEL:
            continue
        meta = ID_LABEL[ag_id]
        workspace = ag.get('workspace') or str(runtime_home / f'workspace-{ag_id}')
        if 'allowAgents' in ag:
            allow_agents = ag.get('allowAgents', []) or []
        else:
            subagents = ag.get('subagents', {})
            allow_agents = subagents.get('allowAgents', []) if isinstance(subagents, dict) else []
        if not isinstance(allow_agents, list):
            allow_agents = []
        raw_agent_model = ag.get('model')
        if raw_agent_model is None or raw_agent_model == '' or raw_agent_model == {}:
            agent_model = default_model
        else:
            agent_model = _custom_model_value(raw_agent_model, custom_by_id)
        result.append({
            'id': ag_id,
            'label': meta['label'], 'role': meta['role'], 'duty': meta['duty'], 'emoji': meta['emoji'],
            'model': agent_model,
            'defaultModel': default_model,
            'workspace': workspace,
            'skills': get_skills(workspace),
            'allowAgents': allow_agents,
        })
        seen_ids.add(ag_id)

    # 仅对没有 agents.list 的旧版配置补充兼容 Agent；明确配置的名单不扩展。
    EXTRA_AGENTS = {
        'taizi':   {'model': default_model, 'workspace': str(runtime_home / 'workspace-taizi'),
                    'allowAgents': ['zhongshu']},
        'main':    {'model': default_model, 'workspace': str(runtime_home / 'workspace-main'),
                    'allowAgents': ['zhongshu','menxia','shangshu','hubu','libu','bingbu','xingbu','gongbu','libu_hr']},
        'zaochao': {'model': default_model, 'workspace': str(runtime_home / 'workspace-zaochao'),
                    'allowAgents': []},
        'libu_hr': {'model': default_model, 'workspace': str(runtime_home / 'workspace-libu_hr'),
                    'allowAgents': ['shangshu']},
    }
    if not has_explicit_agent_list:
        for ag_id, extra in EXTRA_AGENTS.items():
            if ag_id in seen_ids or ag_id not in ID_LABEL:
                continue
            meta = ID_LABEL[ag_id]
            result.append({
                'id': ag_id,
                'label': meta['label'], 'role': meta['role'], 'duty': meta['duty'], 'emoji': meta['emoji'],
                'model': extra['model'],
                'defaultModel': default_model,
                'workspace': extra['workspace'],
                'skills': get_skills(extra['workspace']),
                'allowAgents': extra['allowAgents'],
                'isDefaultModel': True,
            })

    # 保留已有的 dispatchChannel 配置 (Fix #139)
    existing_cfg = {}
    cfg_path = DATA / 'agent_config.json'
    if cfg_path.exists():
        try:
            existing_cfg = json.loads(cfg_path.read_text(encoding='utf-8'))
        except Exception:
            pass

    payload = {
        'generatedAt': datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S'),
        'defaultModel': default_model,
        'knownModels': merged_models,
        'dispatchChannel': existing_cfg.get('dispatchChannel') or os.getenv('DEFAULT_DISPATCH_CHANNEL', ''),
        'agents': result,
    }
    DATA.mkdir(exist_ok=True)
    atomic_json_write(DATA / 'agent_config.json', payload)
    log.info(f'{len(result)} agents synced')

    # 自动部署 SOUL.md 到 workspace（如果项目里有更新）
    deploy_soul_files(runtime_home)
    # 同步 scripts/ 到各 workspace（保持 kanban_update.py 等最新）
    sync_scripts_to_workspaces(runtime_home)


# 项目 agents/ 目录名 → 运行时 agent_id 映射
_SOUL_DEPLOY_MAP = {
    'taizi': 'taizi',
    'zhongshu': 'zhongshu',
    'menxia': 'menxia',
    'shangshu': 'shangshu',
    'libu': 'libu',
    'hubu': 'hubu',
    'bingbu': 'bingbu',
    'xingbu': 'xingbu',
    'gongbu': 'gongbu',
    'libu_hr': 'libu_hr',
    'zaochao': 'zaochao',
}

def _sync_script_symlink(src_file: pathlib.Path, dst_file: pathlib.Path) -> bool:
    """Create a symlink dst_file → src_file (resolved).

    Using symlinks instead of physical copies ensures that ``__file__`` in
    each script always resolves back to the project ``scripts/`` directory,
    so relative-path computations like ``Path(__file__).resolve().parent.parent``
    point to the correct project root regardless of which workspace runs the
    script.  (Fixes #56 — kanban data-path split)

    Returns True if the link was (re-)created, False if already up-to-date.
    """
    src_resolved = src_file.resolve()
    # Guard: skip if dst resolves to the same real path as src.
    # This happens when ws_scripts is itself a directory-level symlink pointing
    # to the project scripts/ dir (created by install.sh link_resources).
    # Without this check the function would unlink the real source file and
    # then create a self-referential symlink (foo.py -> foo.py).
    try:
        dst_resolved = dst_file.resolve()
    except OSError:
        dst_resolved = None
    if dst_resolved == src_resolved:
        return False
    # Already a correct symlink?
    if dst_file.is_symlink() and dst_resolved == src_resolved:
        return False
    # Remove stale file / old physical copy / broken symlink
    if dst_file.exists() or dst_file.is_symlink():
        dst_file.unlink()
    os.symlink(src_resolved, dst_file)
    return True


def sync_scripts_to_workspaces(openclaw_home=None):
    """将项目 scripts/ 目录同步到各 agent workspace（保持 kanban_update.py 等最新）

    Uses symlinks so that ``__file__`` in workspace copies resolves to the
    project ``scripts/`` directory, keeping path-derived constants like
    ``TASKS_FILE`` pointing to the canonical ``data/`` folder.
    """
    scripts_src = BASE / 'scripts'
    if not scripts_src.is_dir():
        return
    runtime_home = _runtime_openclaw_home() if openclaw_home is None else pathlib.Path(openclaw_home).expanduser()
    synced = 0
    for proj_name, runtime_id in _SOUL_DEPLOY_MAP.items():
        ws_scripts = runtime_home / f'workspace-{runtime_id}' / 'scripts'
        ws_scripts.mkdir(parents=True, exist_ok=True)
        for src_file in scripts_src.iterdir():
            if src_file.suffix not in ('.py', '.sh') or src_file.stem.startswith('__'):
                continue
            dst_file = ws_scripts / src_file.name
            try:
                if _sync_script_symlink(src_file, dst_file):
                    synced += 1
            except Exception:
                continue
    # also sync to workspace-main for legacy compatibility
    ws_main_scripts = runtime_home / 'workspace-main' / 'scripts'
    ws_main_scripts.mkdir(parents=True, exist_ok=True)
    for src_file in scripts_src.iterdir():
        if src_file.suffix not in ('.py', '.sh') or src_file.stem.startswith('__'):
            continue
        dst_file = ws_main_scripts / src_file.name
        try:
            if _sync_script_symlink(src_file, dst_file):
                synced += 1
        except Exception:
            pass
    if synced:
        log.info(f'{synced} script symlinks synced to workspaces')


def deploy_soul_files(openclaw_home=None):
    """Deploy project SOUL files below the active OpenClaw home directory."""
    agents_dir = BASE / 'agents'
    runtime_home = _runtime_openclaw_home() if openclaw_home is None else pathlib.Path(openclaw_home).expanduser()
    deployed = 0
    for proj_name, runtime_id in _SOUL_DEPLOY_MAP.items():
        src = agents_dir / proj_name / 'SOUL.md'
        if not src.exists():
            continue
        ws_dst = runtime_home / f'workspace-{runtime_id}' / 'SOUL.md'
        ws_dst.parent.mkdir(parents=True, exist_ok=True)
        # 只在内容不同时更新（避免不必要的写入）
        src_text = src.read_text(encoding='utf-8', errors='ignore')
        try:
            dst_text = ws_dst.read_text(encoding='utf-8', errors='ignore')
        except FileNotFoundError:
            dst_text = ''
        if src_text != dst_text:
            ws_dst.write_text(src_text, encoding='utf-8')
            deployed += 1
        # 太子兼容：同步一份到 legacy main agent 目录
        if runtime_id == 'taizi':
            ag_dst = runtime_home / 'agents' / 'main' / 'SOUL.md'
            ag_dst.parent.mkdir(parents=True, exist_ok=True)
            try:
                ag_text = ag_dst.read_text(encoding='utf-8', errors='ignore')
            except FileNotFoundError:
                ag_text = ''
            if src_text != ag_text:
                ag_dst.write_text(src_text, encoding='utf-8')
        # 确保 sessions 目录存在
        sess_dir = runtime_home / 'agents' / runtime_id / 'sessions'
        sess_dir.mkdir(parents=True, exist_ok=True)
    if deployed:
        log.info(f'{deployed} SOUL.md files deployed')


if __name__ == '__main__':
    main()
