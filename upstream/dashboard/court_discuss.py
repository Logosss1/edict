"""
朝堂议政引擎 — 多官员实时讨论系统

灵感来源于 nvwa 项目的 group_chat + crew_engine
将官员可视化 + 实时讨论 + 用户（皇帝）参与融合到三省六部

功能:
  - 选择官员参与议政
  - 围绕旨意/议题进行多轮群聊讨论
  - 皇帝可随时发言、下旨干预（天命降临）
  - 命运骰子：随机事件
  - 每个官员保持自己的角色性格和说话风格
"""
from __future__ import annotations

import json
import logging
import os
import time
import uuid
import base64
import pathlib
import threading
import re
from urllib.parse import urlsplit, urlunsplit

from chat_attachments import AttachmentStore
from file_lock import atomic_json_read, atomic_json_write

logger = logging.getLogger('court_discuss')
_storage = None
_attachments = None
_session_lock = threading.RLock()

# The dashboard runs in the same child process as the desktop provider
# environment.  Keep the last failure in memory so the HTTP layer can tell a
# real provider failure apart from the intentionally provider-less demo mode.
_last_llm_error = None
_last_llm_configured = False


def configure_storage(data_dir):
    global _storage, _attachments
    _storage = pathlib.Path(data_dir) / "court-discussions"
    _storage.mkdir(parents=True, exist_ok=True, mode=0o700)
    _attachments = AttachmentStore(data_dir)
    _sessions.clear()
    for path in _storage.glob("*.json"):
        if path.is_symlink():
            continue
        session = atomic_json_read(path, None)
        if isinstance(session, dict) and session.get("session_id") == path.stem and len(path.stem) == 8 and all(c in "0123456789abcdef" for c in path.stem):
            _sessions[path.stem] = session


def _persist(session):
    if _storage is not None:
        path = _storage / f"{session['session_id']}.json"
        atomic_json_write(path, session)
        path.chmod(0o600)


def delete_attachment(session_id, attachment_id):
    with _session_lock:
        session = _sessions.get(session_id)
        if not session or session['phase'] != 'discussing':
            raise ValueError('朝议不存在或已结束')
        if any(item['id'] == attachment_id for message in session['messages'] for item in message.get('attachments', [])):
            raise ValueError('已发送的附件不能删除')
        _attachments.delete(f'court-{session_id}', attachment_id)

# ── 官员角色设定 ──

OFFICIAL_PROFILES = {
    'taizi': {
        'name': '太子', 'emoji': '🤴', 'role': '储君',
        'duty': '消息分拣与需求提炼。判断事务轻重缓急，简单事直接处置，重大事务提炼需求转交中书省。代皇帝巡视各部进展。',
        'personality': '年轻有为、锐意进取，偶尔冲动但善于学习。说话干脆利落，喜欢用现代化的比喻。',
        'speaking_style': '简洁有力，经常用"本宫以为"开头，偶尔蹦出网络用语。'
    },
    'zhongshu': {
        'name': '中书令', 'emoji': '📜', 'role': '正一品·中书省',
        'duty': '方案规划与流程驱动。接收旨意后起草执行方案，提交门下省审议，通过后转尚书省执行。只规划不执行，方案需简明扼要。',
        'personality': '老成持重，擅长规划，总能提出系统性方案。话多但有条理。',
        'speaking_style': '喜欢列点论述，常说"臣以为需从三方面考量"。引经据典。'
    },
    'menxia': {
        'name': '侍中', 'emoji': '🔍', 'role': '正一品·门下省',
        'duty': '方案审议与把关。从可行性、完整性、风险、资源四维度审核方案，有权封驳退回。发现漏洞必须指出，建议必须具体。',
        'personality': '严谨挑剔，眼光犀利，善于找漏洞。是天生的审查官，但也很公正。',
        'speaking_style': '喜欢反问，"陛下容禀，此处有三点疑虑"。对不完善的方案会直言不讳。'
    },
    'shangshu': {
        'name': '尚书令', 'emoji': '📮', 'role': '正一品·尚书省',
        'duty': '任务派发与执行协调。接收准奏方案后判断归属哪个部门，分发给六部执行，汇总结果回报。相当于任务分发中心。',
        'personality': '执行力强，务实干练，关注可行性和资源分配。',
        'speaking_style': '直来直去，"臣来安排"、"交由某部办理"。重效率轻虚文。'
    },
    'libu': {
        'name': '礼部尚书', 'emoji': '📝', 'role': '正二品·礼部',
        'duty': '文档规范与对外沟通。负责撰写文档、用户指南、变更日志；制定输出规范和模板；审查UI/UX文案；草拟公告、Release Notes。',
        'personality': '文采飞扬，注重规范和形式，擅长文档和汇报。有点强迫症。',
        'speaking_style': '措辞优美，"臣斗胆建议"，喜欢用排比和对仗。'
    },
    'hubu': {
        'name': '户部尚书', 'emoji': '💰', 'role': '正二品·户部',
        'duty': '数据统计与资源管理。负责数据收集/清洗/聚合/可视化；Token用量统计、性能指标计算、成本分析；CSV/JSON报表生成；文件组织与配置管理。',
        'personality': '精打细算，对预算和资源极其敏感。总想省钱但也识大局。',
        'speaking_style': '言必及成本，"这个预算嘛……"，经常算账。'
    },
    'bingbu': {
        'name': '兵部尚书', 'emoji': '⚔️', 'role': '正二品·兵部',
        'duty': '基础设施与运维保障。负责服务器管理、进程守护、日志排查；CI/CD、容器编排、灰度发布、回滚策略；性能监控；防火墙、权限管控、漏洞扫描。',
        'personality': '雷厉风行，危机意识强，重视安全和应急。说话带军人气质。',
        'speaking_style': '干脆果断，"末将建议立即执行"、"兵贵神速"。'
    },
    'xingbu': {
        'name': '刑部尚书', 'emoji': '⚖️', 'role': '正二品·刑部',
        'duty': '质量保障与合规审计。负责代码审查（逻辑正确性、边界条件、异常处理）；编写测试、覆盖率分析；Bug定位与根因分析；权限检查、敏感信息排查。',
        'personality': '严明公正，重视规则和底线。善于质量把控和风险评估。',
        'speaking_style': '逻辑严密，"依律当如此"、"需审慎考量风险"。'
    },
    'gongbu': {
        'name': '工部尚书', 'emoji': '🔧', 'role': '正二品·工部',
        'duty': '工程实现与架构设计。负责需求分析、方案设计、代码实现、接口对接；模块划分、数据结构/API设计；代码重构、性能优化、技术债清偿；脚本与自动化工具。',
        'personality': '技术宅，动手能力强，喜欢谈实现细节。偶尔社恐但一说到技术就滔滔不绝。',
        'speaking_style': '喜欢说技术术语，"从技术角度来看"、"这个架构建议用……"。'
    },
    'libu_hr': {
        'name': '吏部尚书', 'emoji': '👔', 'role': '正二品·吏部',
        'duty': '人事管理与团队建设。负责新成员（Agent）评估接入、能力测试；Skill编写与Prompt调优、知识库维护；输出质量评分、效率分析；协作规范制定。',
        'personality': '知人善任，擅长人员安排和组织协调。八面玲珑但有原则。',
        'speaking_style': '关注人的因素，"此事需考虑各部人手"、"建议由某某负责"。'
    },
}

# ── 命运骰子事件（古风版）──

FATE_EVENTS = [
    '八百里加急：边疆战报传来，所有人必须讨论应急方案',
    '钦天监急报：天象异常，太史公占卜后建议暂缓此事',
    '新科状元觐见，带来了意想不到的新视角',
    '匿名奏折揭露了计划中一个被忽视的重大漏洞',
    '户部清点发现国库余银比预期多一倍，可以加大投入',
    '一位告老还乡的前朝元老突然上书，分享前车之鉴',
    '民间舆论突变，百姓对此事态度出现180度转折',
    '邻国使节来访，带来了合作机遇也带来了竞争压力',
    '太后懿旨：要求优先考虑民生影响',
    '暴雨连日，多地受灾，资源需重新调配',
    '发现前朝古籍中竟有类似问题的解决方案',
    '翰林院提出了一个大胆的替代方案，令人耳目一新',
    '各部积压的旧案突然需要一起处理，人手紧张',
    '皇帝做了一个意味深长的梦，暗示了一个全新的方向',
    '突然有人拿出了竞争对手的情报，局面瞬间改变',
    '一场意外让所有人不得不在半天内拿出结论',
]

# ── Session 管理 ──

_sessions: dict[str, dict] = {}


def create_session(topic: str, official_ids: list[str], task_id: str = '') -> dict:
    """创建新的朝堂议政会话。"""
    session_id = str(uuid.uuid4())[:8]

    officials = []
    for oid in official_ids:
        profile = OFFICIAL_PROFILES.get(oid)
        if profile:
            officials.append({**profile, 'id': oid})

    if not officials:
        return {'ok': False, 'error': '至少选择一位官员'}

    session = {
        'session_id': session_id,
        'topic': topic,
        'task_id': task_id,
        'officials': officials,
        'messages': [{
            'type': 'system',
            'content': f'🏛 朝堂议政开始 —— 议题：{topic}',
            'timestamp': time.time(),
        }],
        'round': 0,
        'phase': 'discussing',  # discussing | concluded
        'created_at': time.time(),
    }

    _sessions[session_id] = session
    _persist(session)
    return _serialize(session)


def advance_discussion(session_id: str, user_message: str = None,
                       decree: str = None, attachment_ids=None) -> dict:
    # The existing engine is synchronous; serialize mutation instead of adding a queue.
    if not _session_lock.acquire(blocking=False):
        return {'ok': False, 'error': '朝议正在回奏，请稍后再发言'}
    try:
        return _advance_discussion(session_id, user_message, decree, attachment_ids)
    finally:
        _session_lock.release()


def _advance_discussion(session_id, user_message, decree, attachment_ids):
    """推进一轮讨论，使用内置模拟或 LLM。"""
    session = _sessions.get(session_id)
    if not session:
        return {'ok': False, 'error': f'会话 {session_id} 不存在'}
    if session['phase'] != 'discussing':
        return {'ok': False, 'error': '朝议已结束，请另开议事'}
    try:
        attachments = _attachments.resolve(f"court-{session_id}", attachment_ids or []) if _attachments else []
    except ValueError as exc:
        return {'ok': False, 'error': str(exc)}
    if attachments and not user_message:
        user_message = '请分析所附文件。'
    previous_count = len(session['messages'])

    session['round'] += 1
    round_num = session['round']

    # 记录皇帝发言
    if user_message:
        session['messages'].append({
            'type': 'emperor',
            'content': user_message,
            'timestamp': time.time(),
            'attachments': attachments,
        })

    # 记录天命降临
    if decree:
        session['messages'].append({
            'type': 'decree',
            'content': decree,
            'timestamp': time.time(),
        })

    # 尝试用 LLM 生成讨论。只有完全没有可用供应商时才进入演示模拟，
    # 避免把真实模型错误伪装成正常的官员回奏。
    llm_result = _llm_discuss(session, user_message, decree)

    if llm_result:
        new_messages = llm_result.get('messages', [])
        scene_note = llm_result.get('scene_note')
    elif _last_llm_configured:
        had_attachments = any(message.get('attachments') for message in session['messages'])
        session['messages'] = session['messages'][:previous_count]
        session['round'] -= 1
        detail = _last_llm_error or '模型未返回有效回奏'
        suffix = '附件分析失败。' if had_attachments else ''
        return {
            'ok': False,
            'error': f'{suffix}模型调用失败：{detail} 未使用模拟回复，请检查供应商、模型和网络后重试。',
        }
    elif any(message.get('attachments') for message in session['messages']):
        session['messages'] = session['messages'][:previous_count]
        session['round'] -= 1
        return {'ok': False, 'error': '模型未能完成附件分析；消息和附件草稿已保留，请检查供应商后重试。未使用模拟回复。'}
    else:
        # 降级到规则模拟
        new_messages = _simulated_discuss(session, user_message, decree)
        scene_note = None

    # 添加到历史
    for msg in new_messages:
        session['messages'].append({
            'type': 'official',
            'official_id': msg.get('official_id', ''),
            'official_name': msg.get('name', ''),
            'content': msg.get('content', ''),
            'emotion': msg.get('emotion', 'neutral'),
            'action': msg.get('action'),
            'timestamp': time.time(),
        })

    if scene_note:
        session['messages'].append({
            'type': 'scene_note',
            'content': scene_note,
            'timestamp': time.time(),
        })

    _persist(session)
    return {
        'ok': True,
        'session_id': session_id,
        'round': round_num,
        'new_messages': new_messages,
        'scene_note': scene_note,
        'total_messages': len(session['messages']),
        'messages': session['messages'],
        'simulated': not bool(llm_result),
        'simulation_notice': '当前为规则模拟回复，未连接供应商。' if not llm_result else None,
    }


def get_session(session_id: str) -> dict | None:
    session = _sessions.get(session_id)
    if not session:
        return None
    return _serialize(session)


def conclude_session(session_id: str) -> dict:
    """结束议政，生成总结。"""
    session = _sessions.get(session_id)
    if not session:
        return {'ok': False, 'error': f'会话 {session_id} 不存在'}

    session['phase'] = 'concluded'

    # 尝试用 LLM 生成总结
    summary = _llm_summarize(session)
    if not summary:
        # 降级到简单统计
        official_msgs = [m for m in session['messages'] if m['type'] == 'official']
        by_name = {}
        for m in official_msgs:
            name = m.get('official_name', '?')
            by_name[name] = by_name.get(name, 0) + 1
        parts = [f"{n}发言{c}次" for n, c in by_name.items()]
        summary = f"历经{session['round']}轮讨论，{'、'.join(parts)}。议题待后续落实。"

    session['messages'].append({
        'type': 'system',
        'content': f'📋 朝堂议政结束 —— {summary}',
        'timestamp': time.time(),
    })
    session['summary'] = summary
    _persist(session)

    return {
        'ok': True,
        'session_id': session_id,
        'summary': summary,
    }


def list_sessions() -> list[dict]:
    """列出所有活跃会话。"""
    return [
        {
            'session_id': s['session_id'],
            'topic': s['topic'],
            'round': s['round'],
            'phase': s['phase'],
            'official_count': len(s['officials']),
            'message_count': len(s['messages']),
        }
        for s in _sessions.values()
    ]


def destroy_session(session_id: str):
    # Leaving the view no longer destroys the history and its attachment links.
    session = _sessions.get(session_id)
    if session:
        session['phase'] = 'concluded'
        _persist(session)


def delete_session(session_id: str) -> dict:
    """Permanently delete a concluded court discussion and its attachments."""
    clean_id = str(session_id or '').strip().lower()
    if not re.fullmatch(r'[0-9a-f]{8}', clean_id):
        return {'ok': False, 'error': '朝议会话 ID 无效'}
    with _session_lock:
        session = _sessions.get(clean_id)
        if not session:
            return {'ok': False, 'error': f'会话 {clean_id} 不存在'}
        if session.get('phase') != 'concluded':
            return {'ok': False, 'error': '朝议尚未结束，请先散朝后再删除'}
        try:
            if _storage is not None:
                (_storage / f'{clean_id}.json').unlink(missing_ok=True)
            if _attachments is not None:
                _attachments.delete_scope(f'court-{clean_id}')
        except (OSError, ValueError):
            return {'ok': False, 'error': '朝议记录删除失败，请稍后重试'}
        _sessions.pop(clean_id, None)
    return {'ok': True, 'session_id': clean_id}


def get_fate_event() -> str:
    """获取随机命运骰子事件。"""
    import random
    return random.choice(FATE_EVENTS)


# ── LLM 集成 ──

_PREFERRED_MODELS = ['gpt-4o-mini', 'claude-haiku', 'gpt-5-mini', 'gemini-3-flash', 'gemini-flash']

# GitHub Copilot 模型列表 (通过 Copilot Chat API 可用)
_COPILOT_MODELS = [
    'gpt-4o', 'gpt-4o-mini', 'claude-sonnet-4', 'claude-haiku-3.5',
    'gemini-2.0-flash', 'o3-mini',
]
_COPILOT_PREFERRED = ['gpt-4o-mini', 'claude-haiku', 'gemini-flash', 'gpt-4o']


def _pick_chat_model(models: list[dict | str]) -> str | None:
    """从 provider 的模型列表中选一个适合聊天的轻量模型。"""
    ids = []
    for model in models or []:
        model_id = model if isinstance(model, str) else model.get('id') if isinstance(model, dict) else None
        if isinstance(model_id, str) and model_id.strip():
            ids.append(model_id.strip())
    for pref in _PREFERRED_MODELS:
        for mid in ids:
            if pref in mid:
                return mid
    return ids[0] if ids else None


def _read_copilot_token() -> str | None:
    """读取 openclaw 管理的 GitHub Copilot token。"""
    token_path = os.path.expanduser('~/.openclaw/credentials/github-copilot.token.json')
    if not os.path.exists(token_path):
        return None
    try:
        with open(token_path) as f:
            cred = json.load(f)
        token = cred.get('token', '')
        expires = cred.get('expiresAt', 0)
        # 检查 token 是否过期（毫秒时间戳）
        import time
        if expires and time.time() * 1000 > expires:
            logger.warning('Copilot token expired')
            return None
        return token if token else None
    except Exception as e:
        logger.warning('Failed to read copilot token: %s', e)
        return None


_ENV_SECRET_REF_RE = re.compile(r'^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$')
_ENV_SECRET_NAME_RE = re.compile(r'^[A-Z][A-Z0-9_]{1,127}$')


def _reset_llm_status() -> None:
    global _last_llm_error, _last_llm_configured
    _last_llm_error = None
    _last_llm_configured = False


def _set_llm_error(message: str, configured: bool = True) -> None:
    global _last_llm_error, _last_llm_configured
    _last_llm_error = str(message).strip()[:500]
    _last_llm_configured = configured


def _configured_model_reference(config: dict) -> str | None:
    """Return the model selected by the desktop/OpenClaw config."""
    defaults = config.get('agents', {}).get('defaults', {})
    raw = defaults.get('model') if isinstance(defaults, dict) else None
    if isinstance(raw, dict):
        raw = raw.get('primary')
    if isinstance(raw, str) and raw.strip():
        return raw.strip()
    # Older configurations may only bind a model on an individual agent.
    for agent in config.get('agents', {}).get('list', []) if isinstance(config.get('agents', {}), dict) else []:
        if not isinstance(agent, dict):
            continue
        raw = agent.get('model')
        if isinstance(raw, dict):
            raw = raw.get('primary')
        if isinstance(raw, str) and raw.strip():
            return raw.strip()
    return None


def _resolve_provider_key(value) -> tuple[str, str | None]:
    """Resolve a provider key without ever treating a SecretRef as a key."""
    if isinstance(value, dict):
        if value.get('source') != 'env':
            return '', '供应商密钥引用类型不受支持'
        env_name = value.get('id')
        if not isinstance(env_name, str) or not env_name.strip():
            return '', '供应商密钥引用无效'
        env_name = env_name.strip()
        secret = os.environ.get(env_name, '').strip()
        if not secret:
            return '', f'供应商密钥未注入环境变量 {env_name}'
        return secret, None

    if not isinstance(value, str):
        return '', '供应商未配置 API 密钥'
    marker = value.strip()
    if not marker or marker.lower() == 'n/a':
        return '', '供应商未配置 API 密钥'
    template = _ENV_SECRET_REF_RE.fullmatch(marker)
    if template:
        env_name = template.group(1)
        secret = os.environ.get(env_name, '').strip()
        if not secret:
            return '', f'供应商密钥未注入环境变量 {env_name}'
        return secret, None
    # OpenClaw also accepts a bare environment variable name.  Never send the
    # variable name itself as a bearer token when the desktop did not inject it.
    if _ENV_SECRET_NAME_RE.fullmatch(marker) and (
        marker in os.environ or any(word in marker for word in ('KEY', 'TOKEN', 'SECRET', 'PASSWORD'))
    ):
        secret = os.environ.get(marker, '').strip()
        if not secret:
            return '', f'供应商密钥未注入环境变量 {marker}'
        return secret, None
    # Keep compatibility with older standalone configs that stored a literal
    # key.  Desktop-managed configs use SecretRef and never take this path.
    return marker, None


def _config_paths() -> list[tuple[pathlib.Path, bool]]:
    """Return config candidates in desktop-first order.

    The boolean marks an explicitly requested path.  An explicit desktop path
    must fail loudly when it disappears instead of silently switching to a
    different user's OpenClaw configuration.
    """
    explicit = os.environ.get('OPENCLAW_CONFIG_PATH', '').strip()
    if explicit:
        return [(pathlib.Path(explicit).expanduser(), True)]
    home = os.environ.get('EDICT_OPENCLAW_HOME', '').strip()
    candidates = []
    if home:
        candidates.append((pathlib.Path(home).expanduser() / 'openclaw.json', False))
    candidates.append((pathlib.Path('~/.openclaw/openclaw.json').expanduser(), False))
    seen = set()
    result = []
    for path, required in candidates:
        key = str(path)
        if key not in seen:
            seen.add(key)
            result.append((path, required))
    return result


def _provider_candidate(name: str, provider, requested_model: str | None) -> dict:
    """Build a safe in-memory LLM config for one provider."""
    if not isinstance(provider, dict):
        return {'configured': True, 'configuration_error': f'供应商 {name} 配置无效'}

    api_type = provider.get('api') or provider.get('apiType') or 'openai-completions'
    base_url = provider.get('baseUrl') or provider.get('base_url') or ''
    base_url = base_url.strip() if isinstance(base_url, str) else ''
    model_id = None
    if requested_model and requested_model.startswith(f'{name}/'):
        model_id = requested_model.split('/', 1)[1].strip()
    if not model_id:
        model_id = _pick_chat_model(provider.get('models', []))

    if not base_url:
        return {'configured': True, 'provider': name, 'configuration_error': f'供应商 {name} 未配置 API 地址'}
    if not model_id:
        return {'configured': True, 'provider': name, 'base_url': base_url,
                'configuration_error': f'供应商 {name} 未配置模型'}

    send_auth = provider.get('authHeader', True) is not False
    api_key, key_error = _resolve_provider_key(provider.get('apiKey', ''))
    if send_auth and key_error and not ('localhost' in base_url or '127.0.0.1' in base_url):
        return {
            'configured': True, 'provider': name, 'base_url': base_url, 'model': model_id,
            'api_type': api_type, 'api_key': '', 'configuration_error': key_error,
        }
    logger.info('Court discuss using openclaw provider=%s model=%s api=%s', name, model_id, api_type)
    return {
        'configured': True,
        'provider': name,
        'api_key': api_key if send_auth else '',
        'base_url': base_url,
        'model': model_id,
        'api_type': api_type,
    }


def _get_llm_config() -> dict | None:
    """从桌面隔离的 OpenClaw 配置读取当前供应商和模型。

    优先级为显式兼容环境变量，其次是 ``OPENCLAW_CONFIG_PATH`` 指向的
    桌面配置。只有完全没有供应商配置时，才回退到 Copilot/旧版配置。
    密钥引用只解析当前进程环境，绝不把 SecretRef 对象当作密钥发送。
    """
    # 1. 环境变量覆盖（保留向后兼容）
    env_key = os.environ.get('OPENCLAW_LLM_API_KEY', '').strip()
    if env_key:
        return {
            'configured': True,
            'api_key': env_key,
            'base_url': os.environ.get('OPENCLAW_LLM_BASE_URL', 'https://api.openai.com/v1').strip(),
            'model': os.environ.get('OPENCLAW_LLM_MODEL', 'gpt-4o-mini').strip(),
            'api_type': os.environ.get('OPENCLAW_LLM_API_TYPE', 'openai').strip(),
        }

    explicit_path = bool(os.environ.get('OPENCLAW_CONFIG_PATH', '').strip())
    for path, required in _config_paths():
        if not path.exists():
            if required:
                return {'configured': True, 'configuration_error': f'OpenClaw 配置文件不存在：{path}'}
            continue
        try:
            with path.open(encoding='utf-8') as handle:
                cfg = json.load(handle)
        except Exception as exc:
            logger.warning('Failed to read OpenClaw config: %s', exc)
            return {'configured': True, 'configuration_error': f'OpenClaw 配置文件无法读取：{path}'}
        if not isinstance(cfg, dict):
            return {'configured': True, 'configuration_error': 'OpenClaw 配置格式无效'}

        models = cfg.get('models') if isinstance(cfg.get('models'), dict) else {}
        providers = models.get('providers') if isinstance(models.get('providers'), dict) else {}
        if providers:
            requested_model = _configured_model_reference(cfg)
            ordered = []
            requested_provider = requested_model.split('/', 1)[0] if requested_model and '/' in requested_model else None
            if requested_provider:
                if requested_provider not in providers:
                    return {'configured': True, 'configuration_error': f'模型供应商 {requested_provider} 不存在'}
                ordered.append(requested_provider)
            for preferred in ('copilot-proxy', 'anthropic'):
                if preferred in providers and preferred not in ordered:
                    ordered.append(preferred)
            ordered.extend(name for name in providers if name not in ordered)

            first_error = None
            for name in ordered:
                candidate = _provider_candidate(name, providers.get(name), requested_model)
                if candidate.get('model') and not candidate.get('configuration_error'):
                    return candidate
                first_error = first_error or candidate
                # A configured default is authoritative; do not silently use a
                # different provider when its key or model is broken.
                if name == requested_provider:
                    return candidate
            return first_error or {'configured': True, 'configuration_error': '没有可用的供应商模型'}

        # An explicit desktop config with no providers means “not configured”,
        # rather than permission to use a global Copilot token accidentally.
        if explicit_path:
            return None
        break

    # 2. Legacy Copilot fallback for standalone/non-desktop installations.
    copilot_token = _read_copilot_token()
    if copilot_token:
        logger.info('Court discuss using github-copilot token, model=gpt-4o')
        return {
            'configured': True,
            'api_key': copilot_token,
            'base_url': 'https://api.githubcopilot.com',
            'model': 'gpt-4o',
            'api_type': 'github-copilot',
        }
    return None


def _try_repair_truncated_discuss(content: str) -> dict | None:
    """尝试从被截断的 JSON 中提取已完成的 messages 条目。"""
    import re
    # 寻找 "messages" 数组中完整的 JSON 对象
    pattern = r'\{\s*"official_id"\s*:\s*"[^"]+"\s*,\s*"name"\s*:\s*"[^"]+"\s*,\s*"content"\s*:\s*"(?:[^"\\]|\\.)*"\s*,\s*"emotion"\s*:\s*"[^"]+"\s*(?:,\s*"action"\s*:\s*"(?:[^"\\]|\\.)*"\s*)?\}'
    matches = re.findall(pattern, content)
    if not matches:
        return None
    messages = []
    for m in matches:
        try:
            messages.append(json.loads(m))
        except json.JSONDecodeError:
            continue
    if not messages:
        return None
    return {'messages': messages, 'scene_note': None}


def _provider_endpoint(base_url: str, endpoint: str, *, versioned: bool = False) -> str:
    """Join an OpenAI/Anthropic endpoint without duplicating ``/v1``."""
    raw = str(base_url or '').strip().rstrip('/')
    parsed = urlsplit(raw)
    path = parsed.path.rstrip('/')
    endpoint = '/' + endpoint.lstrip('/')
    if path.endswith(endpoint):
        return raw
    if versioned and not path:
        path = '/v1'
    if not path:
        path = ''
    return urlunsplit((parsed.scheme, parsed.netloc, f'{path}{endpoint}', '', ''))


def _safe_llm_error(error, api_key: str = '') -> str:
    """Bound and redact transport/provider errors before logging or returning."""
    detail = str(error or '').strip()
    if api_key:
        detail = detail.replace(api_key, '[redacted]')
    for value in (os.environ.get('OPENCLAW_LLM_API_KEY', ''),):
        if value:
            detail = detail.replace(value, '[redacted]')
    detail = re.sub(r'Bearer\s+[^\s,;]+', 'Bearer [redacted]', detail, flags=re.IGNORECASE)
    return re.sub(r'\s+', ' ', detail)[:500] or '未知错误'


def _llm_complete(system_prompt: str, user_prompt: str, max_tokens: int = 1024, images=None) -> str | None:
    """调用 LLM API（自动适配 GitHub Copilot / OpenAI / Anthropic 协议）。"""
    global _last_llm_configured
    _reset_llm_status()
    config = _get_llm_config()
    if not config:
        return None
    if config.get('configured', True):
        _last_llm_configured = True
    if config.get('configuration_error'):
        _set_llm_error(config['configuration_error'])
        return None
    if not config.get('base_url') or not config.get('model'):
        _set_llm_error('供应商 API 地址或模型未配置')
        return None

    import urllib.request
    import urllib.error

    api_type = config.get('api_type', 'openai-completions')

    if api_type == 'anthropic-messages':
        content = [{'type': 'text', 'text': user_prompt}]
        content.extend({'type': 'image', 'source': {'type': 'base64', 'media_type': mime, 'data': data}} for mime, data in (images or []))
        # Anthropic Messages API
        url = _provider_endpoint(config['base_url'], '/messages', versioned=True)
        headers = {
            'Content-Type': 'application/json',
            'x-api-key': config['api_key'],
            'anthropic-version': '2023-06-01',
        }
        payload = json.dumps({
            'model': config['model'],
            'system': system_prompt,
            'messages': [{'role': 'user', 'content': content if images else user_prompt}],
            'max_tokens': max_tokens,
            'temperature': 0.9,
        }).encode()
        try:
            req = urllib.request.Request(url, data=payload, headers=headers, method='POST')
            with urllib.request.urlopen(req, timeout=60) as resp:
                data = json.loads(resp.read().decode())
                return data['content'][0]['text']
        except urllib.error.HTTPError as exc:
            body = exc.read().decode('utf-8', errors='replace') if hasattr(exc, 'read') else ''
            detail = f'HTTP {exc.code}' + (f': {body}' if body else '')
            _set_llm_error(_safe_llm_error(detail, config.get('api_key', '')))
            logger.warning('Anthropic LLM call failed: %s', _last_llm_error)
            return None
        except Exception as e:
            _set_llm_error(_safe_llm_error(e, config.get('api_key', '')))
            logger.warning('Anthropic LLM call failed: %s', _last_llm_error)
            return None
    else:
        content = [{'type': 'text', 'text': user_prompt}]
        content.extend({'type': 'image_url', 'image_url': {'url': f'data:{mime};base64,{data}'}} for mime, data in (images or []))
        # OpenAI-compatible API (也适用于 github-copilot)
        if api_type == 'github-copilot':
            url = _provider_endpoint(config['base_url'], '/chat/completions')
            headers = {
                'Content-Type': 'application/json',
                'Authorization': f"Bearer {config['api_key']}",
                'Editor-Version': 'vscode/1.96.0',
                'Copilot-Integration-Id': 'vscode-chat',
            }
        else:
            url = _provider_endpoint(config['base_url'], '/chat/completions', versioned=True)
            headers = {'Content-Type': 'application/json'}
            if config.get('api_key'):
                headers['Authorization'] = f"Bearer {config['api_key']}"
        payload = json.dumps({
            'model': config['model'],
            'messages': [
                {'role': 'system', 'content': system_prompt},
                {'role': 'user', 'content': content if images else user_prompt},
            ],
            'max_tokens': max_tokens,
            'temperature': 0.9,
        }).encode()
        try:
            req = urllib.request.Request(url, data=payload, headers=headers, method='POST')
            with urllib.request.urlopen(req, timeout=60) as resp:
                data = json.loads(resp.read().decode())
                return data['choices'][0]['message']['content']
        except urllib.error.HTTPError as exc:
            body = exc.read().decode('utf-8', errors='replace') if hasattr(exc, 'read') else ''
            detail = f'HTTP {exc.code}' + (f': {body}' if body else '')
            _set_llm_error(_safe_llm_error(detail, config.get('api_key', '')))
            logger.warning('LLM call failed: %s', _last_llm_error)
            return None
        except Exception as e:
            _set_llm_error(_safe_llm_error(e, config.get('api_key', '')))
            logger.warning('LLM call failed: %s', _last_llm_error)
            return None


def _llm_discuss(session: dict, user_message: str = None, decree: str = None) -> dict | None:
    """使用 LLM 生成多官员讨论。"""
    # Tests and integrations may replace _llm_complete; reset status here as
    # well so a previous round can never make a later failure look successful.
    _reset_llm_status()
    officials = session['officials']
    names = '、'.join(o['name'] for o in officials)
    attached = {}
    for message in session['messages'][-20:]:
        for item in message.get('attachments', []):
            attached[item['id']] = item
    files = list(attached.values())[-8:]
    scope = f"court-{session['session_id']}"
    attachment_context = _attachments.context(scope, files) if files and _attachments else ''
    images = []
    for item in files:
        if item['kind'] == 'image':
            meta, data = _attachments.read(scope, item['id'])
            images.append((meta['mime'], base64.b64encode(data).decode('ascii')))

    profiles = ''
    for o in officials:
        profiles += f"\n### {o['name']}（{o['role']}）\n"
        profiles += f"职责范围：{o.get('duty', '综合事务')}\n"
        profiles += f"性格：{o['personality']}\n"
        profiles += f"说话风格：{o['speaking_style']}\n"

    # 构建最近的对话历史
    history = ''
    for msg in session['messages'][-20:]:
        if msg['type'] == 'system':
            history += f"\n【系统】{msg['content']}\n"
        elif msg['type'] == 'emperor':
            history += f"\n皇帝：{msg['content']}\n"
        elif msg['type'] == 'decree':
            history += f"\n【天命降临】{msg['content']}\n"
        elif msg['type'] == 'official':
            history += f"\n{msg.get('official_name', '?')}：{msg['content']}\n"
        elif msg['type'] == 'scene_note':
            history += f"\n（{msg['content']}）\n"

    decree_section = ''
    if decree:
        decree_section = '\n请根据天命降临事件改变讨论走向，所有官员都必须对此做出反应。\n'

    prompt = f"""你是一个古代朝堂多角色群聊模拟器。模拟多位官员在朝堂上围绕议题的讨论。

## 参与官员
{names}

## 角色设定（每位官员都有明确的职责领域，必须从自身专业角度出发讨论）
{profiles}

## 当前议题
{session['topic']}

## 对话记录
{history if history else '（讨论刚刚开始）'}
{attachment_context}
{decree_section}
## 任务
生成每位官员的下一条发言。要求：
1. 每位官员说1-3句话，像真实朝堂讨论一样
2. **每位官员必须从自己的职责领域出发发言**——户部谈成本和数据、兵部谈安全和运维、工部谈技术实现、刑部谈质量和合规、礼部谈文档和规范、吏部谈人员安排、中书谈规划方案、门下谈审查风险、尚书谈执行调度、太子谈创新和大局，每个人关注的焦点不同
3. 官员之间要有互动——回应、反驳、支持、补充，尤其是不同部门的视角碰撞
4. 保持每位官员独特的说话风格和人格特征
5. 讨论要围绕议题推进、有实质性观点，不要泛泛而谈
6. 如果皇帝发言了，官员要恰当回应（但不要阿谀）
7. 可包含动作描写用*号*包裹（如 *拱手施礼*）

输出JSON格式：
{{
  "messages": [
    {{"official_id": "zhongshu", "name": "中书令", "content": "发言内容", "emotion": "neutral|confident|worried|angry|thinking|amused", "action": "可选动作描写"}},
    ...
  ],
  "scene_note": "可选的朝堂氛围变化（如：朝堂一片哗然|群臣窃窃私语），没有则为null"
}}

只输出JSON，不要其他内容。"""

    # 根据参与官员数量动态调整 max_tokens，避免响应被截断 (#265)
    token_budget = 300 * len(officials) + 200
    try:
        content = _llm_complete(
            '你是一个古代朝堂群聊模拟器，严格输出JSON格式。',
            prompt,
            max_tokens=max(token_budget, 1500),
            images=images,
        )
    except Exception as exc:
        # A provider adapter or test double must not be able to turn a model
        # failure into a successful-looking simulated round.
        _set_llm_error(_safe_llm_error(exc), configured=True)
        return None

    if not content:
        # A monkeypatched/custom completion function may not update the
        # status maintained by _llm_complete.  Re-check configuration so a
        # configured provider still cannot fall through to simulated replies.
        config = _get_llm_config()
        if config and not _last_llm_error:
            _set_llm_error(config.get('configuration_error') or '模型未返回内容')
        return None

    # 解析 JSON
    if '```json' in content:
        content = content.split('```json')[1].split('```')[0].strip()
    elif '```' in content:
        content = content.split('```')[1].split('```')[0].strip()

    try:
        result = json.loads(content)
    except json.JSONDecodeError:
        # 尝试修复被截断的 JSON：提取已完成的 messages 条目
        repaired = _try_repair_truncated_discuss(content)
        if repaired:
            logger.info('Repaired truncated LLM response, recovered %d messages', len(repaired.get('messages', [])))
            result = repaired
        else:
            logger.warning('Failed to parse LLM response')
            _set_llm_error('模型返回内容不是有效 JSON', configured=_last_llm_configured or bool(_get_llm_config()))
            return None
    if not isinstance(result, dict) or not isinstance(result.get('messages'), list):
        _set_llm_error('模型返回格式无效，缺少 messages 数组', configured=_last_llm_configured or bool(_get_llm_config()))
        return None
    official_ids = {official['id'] for official in officials}
    messages = [
        item for item in result['messages']
        if isinstance(item, dict) and item.get('official_id') in official_ids
        and isinstance(item.get('content'), str) and item['content'].strip()
    ]
    if not messages:
        _set_llm_error('模型没有返回参与官员的有效发言', configured=_last_llm_configured or bool(_get_llm_config()))
        return None
    return {'messages': messages, 'scene_note': result.get('scene_note') if isinstance(result.get('scene_note'), str) else None}


def _llm_summarize(session: dict) -> str | None:
    """用 LLM 总结讨论结果。"""
    official_msgs = [m for m in session['messages'] if m['type'] == 'official']
    topic = session['topic']

    if not official_msgs:
        return None

    dialogue = '\n'.join(
        f"{m.get('official_name', '?')}：{m['content']}"
        for m in official_msgs[-30:]
    )

    prompt = f"""以下是朝堂官员围绕「{topic}」的讨论记录：

{dialogue}

请用2-3句话总结讨论结果、达成的共识和待决事项。用古风但简明的风格。"""

    return _llm_complete('你是朝堂记录官，负责总结朝议结果。', prompt, max_tokens=300)


# ── 规则模拟（无 LLM 时的降级方案）──

_SIMULATED_RESPONSES = {
    'zhongshu': [
        '臣以为此事需从全局着眼，分三步推进：先调研、再制定方案、最后交六部执行。',
        '参考前朝经验，臣建议先出一个详细的规划文档，提交门下省审阅后再定。',
        '*展开手中卷轴* 臣已拟好初步方案，待侍中审议、尚书省分派执行。',
    ],
    'menxia': [
        '臣有几点疑虑：方案的风险评估似乎还不够充分，可行性存疑。',
        '容臣直言，此方案完整性不足，遗漏了一个关键环节——资源保障。',
        '*皱眉审视* 这个时间线恐怕过于乐观，臣建议审慎评估后再行准奏。',
    ],
    'shangshu': [
        '若方案通过，臣立刻安排各部分头执行——工部负责实现，兵部保障运维。',
        '臣来说说执行层面的分工：此事当由工部主导，户部配合数据支撑。',
        '交由臣来协调！臣会根据各部职责逐一派发子任务。',
    ],
    'taizi': [
        '父皇，儿臣认为这是个创新的好机会，不妨大胆一些，先做最小可行方案验证。',
        '本宫觉得各位大臣争论的焦点是执行节奏，不如先抓核心、小步快跑。',
        '这个方向太对了！但请各部先各自评估本部门的落地难点再汇总。',
    ],
    'hubu': [
        '臣先算算账……按当前Token用量和资源消耗，这个预算恐怕需要重新评估。',
        '从成本数据来看，臣建议分期投入——先做MVP验证效果，再追加资源。',
        '*翻看账本* 臣统计了近期各项开支指标，目前可支撑，但需严格控制在预算范围内。',
    ],
    'bingbu': [
        '末将认为安全和回滚方案必须先行，万一出问题能快速止损回退。',
        '运维保障方面，部署流程、容器编排、日志监控必须到位再上线。',
        '兵贵神速！但安全底线不能破——权限管控和漏洞扫描须同步进行。',
    ],
    'xingbu': [
        '依规矩，此事需确保合规——代码审查、测试覆盖率、敏感信息排查缺一不可。',
        '臣建议增加测试验收环节，质量是底线，不能因赶工而降低标准。',
        '*正色道* 风险评估不可敷衍：边界条件、异常处理、日志规范都需审计过关。',
    ],
    'gongbu': [
        '从技术架构来看，这个方案是可行的，但需考虑扩展性和模块化设计。',
        '臣可以先搭个原型出来，快速验证技术可行性，再迭代完善。',
        '*整了整官帽* 技术实现方面臣有建议——API设计和数据结构需要先理清……',
    ],
    'libu': [
        '臣建议先拟一份正式文档，明确各方职责、验收标准和输出规范。',
        '此事当载入记录，臣来负责撰写方案文档和对外公告，确保规范统一。',
        '*提笔拟文* 已记录在案，臣稍后整理成正式Release Notes呈上御览。',
    ],
    'libu_hr': [
        '此事关键在于人员调配——需评估各部目前的工作量和能力基线再做安排。',
        '各部当前负荷不等，臣建议调整协作规范，确保关键岗位有人盯进度。',
        '臣可以协调人员轮岗并安排能力培训，保障团队高效协作。',
    ],
}

import random


def _simulated_discuss(session: dict, user_message: str = None, decree: str = None) -> list[dict]:
    """无 LLM 时的规则生成讨论内容。"""
    officials = session['officials']
    messages = []
    subject = re.sub(r'\s+', ' ', str(user_message or session.get('topic') or '').strip())
    if len(subject) > 120:
        subject = subject[:117] + '...'

    for o in officials:
        oid = o['id']
        pool = _SIMULATED_RESPONSES.get(oid, [])
        if isinstance(pool, set):
            pool = list(pool)
        if not pool:
            pool = ['臣附议。', '臣有不同看法。', '臣需要再想想。']

        content = random.choice(pool)
        emotions = ['neutral', 'confident', 'thinking', 'amused', 'worried']

        # 如果皇帝发言了或有天命降临，调整回应
        if decree:
            content = f'*面露惊色* 天命如此，针对“{subject}”，{content}'
        elif user_message:
            content = f'回禀陛下，针对“{subject}”，{content}'

        messages.append({
            'official_id': oid,
            'name': o['name'],
            'content': content,
            'emotion': random.choice(emotions),
            'action': None,
        })

    return messages


def _serialize(session: dict) -> dict:
    return {
        'ok': True,
        'session_id': session['session_id'],
        'topic': session['topic'],
        'task_id': session.get('task_id', ''),
        'officials': session['officials'],
        'messages': session['messages'],
        'round': session['round'],
        'phase': session['phase'],
    }
