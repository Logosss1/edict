import { CheckCircle2, Info, LoaderCircle, Settings2, ShieldCheck, UsersRound } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useStore } from '../store';
import { api } from '../api';
import ProviderModelManager, { type ManagedProvider } from './ProviderModelManager';
import ThinkingControl, { CapabilityTools, useModelCapabilities } from './ThinkingControl';

const CHANNELS = [
  { id: 'feishu', label: '飞书 Feishu' },
  { id: 'telegram', label: 'Telegram' },
  { id: 'wecom', label: '企业微信 WeCom' },
  { id: 'discord', label: 'Discord' },
  { id: 'slack', label: 'Slack' },
  { id: 'signal', label: 'Signal' },
  { id: 'tui', label: 'TUI (终端)' },
];

function openClawProviderId(value: string): string {
  let id = value.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!id) id = 'provider';
  if (!/^[a-z]/.test(id)) id = 'edict-' + id;
  return id.slice(0, 63).replace(/[-_]+$/g, '');
}

export default function ModelConfig() {
  const agentConfig = useStore((s) => s.agentConfig);
  const changeLog = useStore((s) => s.changeLog);
  const loadAgentConfig = useStore((s) => s.loadAgentConfig);
  const toast = useStore((s) => s.toast);

  const [selMap, setSelMap] = useState<Record<string, string>>({});
  const [statusMap, setStatusMap] = useState<Record<string, { cls: string; text: string }>>({});
  const [channelSel, setChannelSel] = useState('feishu');
  const [channelStatus, setChannelStatus] = useState('');
  const [managedProviders, setManagedProviders] = useState<ManagedProvider[]>([]);
  const [profileProviderId, setProfileProviderId] = useState('');
  const [profileModel, setProfileModel] = useState('');
  const [profileThinking, setProfileThinking] = useState('default');
  const capabilities = useModelCapabilities();
  const [profileConfirmed, setProfileConfirmed] = useState(false);
  const [profileStatus, setProfileStatus] = useState<{
    cls: 'ok' | 'err' | 'pending';
    text: string;
  } | null>(null);

  useEffect(() => {
    loadAgentConfig();
  }, [loadAgentConfig]);

  useEffect(() => { void capabilities.reload(); }, [managedProviders, capabilities.reload]);

  useEffect(() => {
    if (agentConfig?.agents) {
      const m: Record<string, string> = {};
      agentConfig.agents.forEach((ag) => {
        // Advanced overrides start empty so legacy or built-in models never become selectable options.
        m[ag.id] = '';
      });
      setSelMap(m);
    }
    if (agentConfig?.dispatchChannel) {
      setChannelSel(agentConfig.dispatchChannel);
    }
  }, [agentConfig]);

  useEffect(() => {
    if (!managedProviders.length) {
      setProfileProviderId('');
      setProfileModel('');
      return;
    }

    const selected = managedProviders.find((provider) => provider.id === profileProviderId) || managedProviders[0];
    if (selected.id !== profileProviderId) setProfileProviderId(selected.id);
    setProfileModel((current) => {
      if (selected.models.includes(current)) return current;
      if (selected.defaultModel && selected.models.includes(selected.defaultModel)) return selected.defaultModel;
      return selected.models[0] || '';
    });
  }, [managedProviders, profileProviderId]);

  if (!agentConfig?.agents) {
    return (
      <div>
        <ProviderModelManager onProvidersChange={setManagedProviders} />
        <div className="empty" style={{ gridColumn: '1/-1' }}>⚠️ 请先启动本地服务器</div>
      </div>
    );
  }

  const managedModels = managedProviders.flatMap((provider) => provider.models.map((model) => ({
    id: openClawProviderId(provider.id) + '/' + model,
    l: model,
    p: provider.name || provider.id,
  })));
  const modelById = new Map(managedModels.map((model) => [model.id, model]));
  const models = [...modelById.values()];
  const selectedProfileProvider = managedProviders.find((provider) => provider.id === profileProviderId);
  const registeredAgentCount = agentConfig.agents.length;
  const profileCapability = capabilities.data?.models.find(item => item.model === `${openClawProviderId(profileProviderId)}/${profileModel}`);
  const thinkingValid = !capabilities.loading && !capabilities.error && Boolean(profileCapability?.levels.includes(profileThinking));

  const handleSelect = (agentId: string, val: string) => {
    setSelMap((p) => ({ ...p, [agentId]: val }));
  };

  const resetMC = (agentId: string) => {
    setSelMap((p) => ({ ...p, [agentId]: '' }));
  };

  const applyModel = async (agentId: string) => {
    const model = selMap[agentId];
    if (!model) return;
    setStatusMap((p) => ({ ...p, [agentId]: { cls: 'pending', text: '⟳ 提交中…' } }));
    try {
      const r = await api.setModel(agentId, model);
      if (r.ok) {
        setStatusMap((p) => ({ ...p, [agentId]: { cls: 'ok', text: '✅ 已提交，原 EDICT 调度器正在应用' } }));
        toast(agentId + ' 模型已更改', 'ok');
        setTimeout(() => loadAgentConfig(), 5500);
      } else {
        setStatusMap((p) => ({ ...p, [agentId]: { cls: 'err', text: '❌ ' + (r.error || '错误') } }));
      }
    } catch {
      setStatusMap((p) => ({ ...p, [agentId]: { cls: 'err', text: '❌ 无法连接服务器' } }));
    }
  };

  const applyModelProfile = async () => {
    if (!profileProviderId || !profileModel || !profileConfirmed || !registeredAgentCount || !thinkingValid) return;

    setProfileStatus({ cls: 'pending', text: `正在为 ${registeredAgentCount} 个实际注册 Agent 应用统一配置…` });
    try {
      const result = await api.setModelProfile(profileProviderId, profileModel, profileThinking);
      if (result.ok) {
        const count = result.agentCount ?? registeredAgentCount;
        const model = result.model || `${profileProviderId}/${profileModel}`;
        const thinking = result.thinking || profileThinking;
        setProfileStatus({ cls: 'ok', text: `已提交 ${count} 个 Agent 的统一配置：${model} · ${thinking}。原 EDICT 正在应用，请以当前配置和变更日志为准。` });
        setProfileConfirmed(false);
        toast(`已提交 ${count} 个 Agent 的统一配置`, 'ok');
        setTimeout(() => loadAgentConfig(), 1200);
      } else {
        setProfileStatus({ cls: 'err', text: result.error || result.message || '批量配置失败' });
      }
    } catch {
      setProfileStatus({ cls: 'err', text: '无法连接服务器，统一配置未应用。' });
    }
  };

  return (
    <div>
      <section className="mc-profile" aria-labelledby="mc-profile-title">
        <div className="mc-profile-head">
          <div>
            <div className="mc-profile-kicker">统一模型配置</div>
            <h2 id="mc-profile-title">一次应用到全部 Agent</h2>
            <p>选择已保存的自定义供应商、模型和思考深度，统一覆盖当前实际注册的 Agent。</p>
          </div>
          <div className="mc-profile-count">
            <UsersRound size={17} />
            <strong>{registeredAgentCount}</strong>
            <span>个 Agent</span>
          </div>
        </div>

        <div className="mc-profile-grid">
          <label className="mc-profile-field">
            <span>供应商</span>
            <select
              className="msel"
              value={profileProviderId}
              onChange={(event) => {
                const nextProviderId = event.target.value;
                const provider = managedProviders.find((item) => item.id === nextProviderId);
                setProfileProviderId(nextProviderId);
                setProfileModel(provider?.defaultModel && provider.models.includes(provider.defaultModel) ? provider.defaultModel : provider?.models[0] || '');
                setProfileConfirmed(false);
                setProfileStatus(null);
              }}
              disabled={!managedProviders.length}
            >
              {!managedProviders.length && <option value="">请先配置供应商</option>}
              {managedProviders.map((provider) => (
                <option key={provider.id} value={provider.id}>
                  {provider.name || provider.id} · {provider.models.length} 个模型
                </option>
              ))}
            </select>
          </label>

          <label className="mc-profile-field">
            <span>默认模型</span>
            <select
              className="msel"
              value={profileModel}
              onChange={(event) => {
                setProfileModel(event.target.value);
                setProfileConfirmed(false);
                setProfileStatus(null);
              }}
              disabled={!selectedProfileProvider?.models.length}
            >
              {!selectedProfileProvider?.models.length && <option value="">暂无可用模型</option>}
              {selectedProfileProvider?.models.map((model) => (
                <option key={model} value={model}>{model}</option>
              ))}
            </select>
          </label>
        </div>

        <ThinkingControl levels={profileCapability?.levels || []} value={profileThinking}
          onChange={value => { setProfileThinking(value); setProfileConfirmed(false); setProfileStatus(null); }}
          loading={capabilities.loading} error={capabilities.error} onRetry={() => void capabilities.reload()} />
        {profileCapability && <CapabilityTools key={profileCapability.model} capability={profileCapability} onChanged={capabilities.reload} />}

        <div className="mc-profile-summary">
          <span><ShieldCheck size={14} /> 仅使用已配置的自定义供应商模型</span>
          <span><Info size={14} /> 应用后清除逐 Agent 的模型与思考深度覆盖</span>
        </div>

        {!managedProviders.length ? (
          <div className="mc-profile-empty">请先在下方“供应商与模型目录”保存供应商，并自动发现或手动添加模型。</div>
        ) : (
          <>
            <label className="mc-profile-confirm">
              <input
                type="checkbox"
                checked={profileConfirmed}
                onChange={(event) => setProfileConfirmed(event.target.checked)}
              />
              <span>我确认将此配置应用到全部 {registeredAgentCount} 个实际注册 Agent。</span>
            </label>
            <div className="mc-profile-actions">
              <button
                className="btn mc-profile-submit"
                type="button"
                disabled={!profileProviderId || !profileModel || !profileConfirmed || !registeredAgentCount || !thinkingValid || profileStatus?.cls === 'pending'}
                onClick={() => void applyModelProfile()}
              >
                {profileStatus?.cls === 'pending' ? <LoaderCircle size={15} className="spin" /> : <CheckCircle2 size={15} />}
                确认应用到全部 Agent
              </button>
            </div>
          </>
        )}
        {profileStatus && <div className={`mc-profile-status ${profileStatus.cls}`}>{profileStatus.text}</div>}
      </section>

      <ProviderModelManager onProvidersChange={setManagedProviders} />
      <details className="mc-advanced">
        <summary className="mc-advanced-summary">
          <span><Settings2 size={15} /> 高级：单个 Agent 模型覆盖</span>
          <small>仅用于例外配置，统一配置仍是默认入口</small>
        </summary>
        <div className="mc-advanced-body">
          <p className="mc-advanced-note">这里保留原 EDICT 的逐 Agent 模型接口。思考深度以统一配置为准，批量应用后会清除这些模型覆盖。</p>
          <div className="model-grid">
            {agentConfig.agents.map((ag) => {
              const currentModel = ag.model !== 'unknown' ? ag.model : '';
              const sel = selMap[ag.id] ?? '';
              const changed = Boolean(sel) && sel !== currentModel;
              const st = statusMap[ag.id];
              return (
                <div className="mc-card" key={ag.id}>
                  <div className="mc-top">
                    <span className="mc-emoji">{ag.emoji || '🏛️'}</span>
                    <div>
                      <div className="mc-name">
                        {ag.label}{' '}
                        <span style={{ fontSize: 11, color: 'var(--muted)' }}>{ag.id}</span>
                      </div>
                      <div className="mc-role">{ag.role}</div>
                    </div>
                  </div>
                  <div className="mc-cur">
                    当前: <b>{currentModel || '未配置'}</b>
                  </div>
                  <select className="msel" value={sel} onChange={(e) => handleSelect(ag.id, e.target.value)}>
                    {!sel && <option value="">{models.length ? '选择自定义模型' : '暂无自定义模型，请先保存供应商'}</option>}
                    {models.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.l} ({m.p})
                      </option>
                    ))}
                  </select>
                  <div className="mc-btns">
                    <button className="btn btn-p" type="button" disabled={!changed} onClick={() => void applyModel(ag.id)}>
                      应用
                    </button>
                    <button className="btn btn-g" type="button" onClick={() => resetMC(ag.id)}>
                      重置
                    </button>
                  </div>
                  {st && <div className={`mc-st ${st.cls}`}>{st.text}</div>}
                </div>
              );
            })}
          </div>
        </div>
      </details>

      {/* Dispatch Channel 配置 */}
      <div style={{ marginTop: 24, marginBottom: 8 }}>
        <div className="sec-title">派发渠道</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 0' }}>
          <select className="msel" value={channelSel} onChange={(e) => setChannelSel(e.target.value)}
            style={{ maxWidth: 220 }}>
            {CHANNELS.map((ch) => (
              <option key={ch.id} value={ch.id}>{ch.label}</option>
            ))}
          </select>
          <button className="btn btn-p" disabled={channelSel === (agentConfig?.dispatchChannel || 'feishu')}
            onClick={async () => {
              try {
                const r = await api.setDispatchChannel(channelSel);
                if (r.ok) { setChannelStatus('✅ 已保存'); toast('派发渠道已切换', 'ok'); loadAgentConfig(); }
                else setChannelStatus('❌ ' + (r.error || '失败'));
              } catch { setChannelStatus('❌ 无法连接'); }
              setTimeout(() => setChannelStatus(''), 3000);
            }}>应用</button>
          {channelStatus && <span style={{ fontSize: 12, color: channelStatus.startsWith('✅') ? 'var(--success)' : 'var(--danger)' }}>{channelStatus}</span>}
        </div>
        <div style={{ fontSize: 11, color: 'var(--muted)' }}>自动派发时使用的 OpenClaw 通知渠道（需已在 openclaw.json 中配置对应 channel）</div>
      </div>

      {/* Change Log */}
      <div style={{ marginTop: 24 }}>
        <div className="sec-title">变更日志</div>
        <div className="cl-list">
          {!changeLog?.length ? (
            <div style={{ fontSize: 12, color: 'var(--muted)', padding: '8px 0' }}>暂无变更</div>
          ) : (
            [...changeLog]
              .reverse()
              .slice(0, 15)
              .map((e, i) => (
                <div className="cl-row" key={i}>
                  <span className="cl-t">{(e.at || '').substring(0, 16).replace('T', ' ')}</span>
                  <span className="cl-a">{e.agentId}</span>
                  <span className="cl-c">
                    <b>{e.oldModel}</b> → <b>{e.newModel}</b>
                    {e.rolledBack && (
                      <span
                        style={{
                          color: 'var(--danger)',
                          fontSize: 10,
                          border: '1px solid #ff527044',
                          padding: '1px 5px',
                          borderRadius: 3,
                          marginLeft: 4,
                        }}
                      >
                        ⚠ 已回滚
                      </span>
                    )}
                  </span>
                </div>
              ))
          )}
        </div>
      </div>
    </div>
  );
}
