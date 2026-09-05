import { CheckCircle2, CircleAlert, LoaderCircle, PlugZap, RefreshCw, ShieldCheck, Trash2, Wifi } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';

type ChannelId = 'feishu' | 'telegram' | 'discord' | 'slack' | 'signal';
type ChannelForm = Record<string, string>;

const CHANNELS: Array<{ id: ChannelId; label: string; help: string }> = [
  { id: 'feishu', label: '飞书 Feishu', help: '飞书企业自建应用，默认使用 WebSocket 长连接。' },
  { id: 'telegram', label: 'Telegram', help: '使用 BotFather 创建的机器人 Token。' },
  { id: 'discord', label: 'Discord', help: '使用 Discord Bot Token，可选填 Application ID。' },
  { id: 'slack', label: 'Slack', help: 'Socket Mode 需要 Bot Token 和 App Token。' },
  { id: 'signal', label: 'Signal', help: '连接已有的 signal-cli REST 服务。' },
];

function bridge() {
  return window.edictDesktop;
}

function initialForm(channel: ChannelId, summary?: EdictDesktopChannelSummary): ChannelForm {
  return {
    name: summary?.name || '',
    appId: summary?.appId || '',
    domain: summary?.domain === 'lark' ? 'lark' : 'feishu',
    appSecret: '',
    botToken: '',
    applicationId: '',
    appToken: '',
    signingSecret: '',
    account: '',
    httpUrl: 'http://127.0.0.1:8080',
    httpHost: '127.0.0.1',
    httpPort: '8080',
    ...(channel === 'signal' ? { account: '' } : {}),
  };
}

function isConfiguredSecret(summary: EdictDesktopChannelSummary | undefined, field: string): boolean {
  return Boolean(summary?.secretFields?.[field]);
}

export default function ChannelConfig({
  initialChannel,
  onDispatchSaved,
  toast,
}: {
  initialChannel?: string;
  onDispatchSaved?: () => void;
  toast: (message: string, type?: 'ok' | 'err') => void;
}) {
  const normalizedInitial = CHANNELS.some((channel) => channel.id === initialChannel) ? initialChannel as ChannelId : 'feishu';
  const [selectedChannel, setSelectedChannel] = useState<ChannelId>(normalizedInitial);
  const [accountId, setAccountId] = useState('default');
  const [accounts, setAccounts] = useState<EdictDesktopChannelSummary[]>([]);
  const [form, setForm] = useState<ChannelForm>(() => initialForm(normalizedInitial));
  const [status, setStatus] = useState<{ kind: 'ok' | 'err' | 'pending'; text: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);

  const selectedMeta = CHANNELS.find((channel) => channel.id === selectedChannel) || CHANNELS[0];
  const channelAccounts = useMemo(
    () => accounts.filter((account) => account.channel === selectedChannel),
    [accounts, selectedChannel],
  );
  // Keep a newly typed account independent from the default account. This
  // prevents the remove action and secret placeholders from accidentally
  // targeting the default account while creating a named account.
  const selectedSummary = channelAccounts.find((account) => account.accountId === accountId);
  const needsReload = Boolean(status?.text.includes('重载看板'));

  const loadAccounts = async (selectExisting = false) => {
    const currentBridge = bridge();
    if (!currentBridge?.listChannelAccounts) {
      setLoading(false);
      setStatus({ kind: 'err', text: '当前页面不是桌面版运行环境，无法在这里安全保存渠道密钥。' });
      return;
    }
    setLoading(true);
    try {
      const result = await currentBridge.listChannelAccounts();
      setAccounts(result.channels || []);
      if (selectExisting) {
        const existing = (result.channels || []).find((account) => account.channel === selectedChannel && account.configured)
          || (result.channels || []).find((account) => account.channel === selectedChannel);
        if (existing) setAccountId(existing.accountId);
      }
    } catch (error) {
      setStatus({ kind: 'err', text: error instanceof Error ? error.message : '无法读取渠道配置。' });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void loadAccounts(true); }, []);

  useEffect(() => {
    const existing = channelAccounts.find((account) => account.accountId === accountId)
      || channelAccounts.find((account) => account.accountId === 'default');
    setForm(initialForm(selectedChannel, existing));
  }, [selectedChannel, accountId, accounts]);

  useEffect(() => {
    if (initialChannel && CHANNELS.some((channel) => channel.id === initialChannel)) {
      setSelectedChannel(initialChannel as ChannelId);
    }
  }, [initialChannel]);

  const update = (field: string, value: string) => setForm((previous) => ({ ...previous, [field]: value }));

  const save = async () => {
    const currentBridge = bridge();
    if (!currentBridge?.saveChannelAccount) return;
    setWorking(true);
    setStatus({ kind: 'pending', text: '正在安装渠道组件并保存安全配置…' });
    try {
      const payload: Record<string, unknown> = { channel: selectedChannel, accountId };
      for (const [field, value] of Object.entries(form)) {
        if (value.trim()) payload[field] = value.trim();
      }
      const result = await currentBridge.saveChannelAccount(payload);
      if (!result.ok) throw new Error(result.error || '渠道配置保存失败。');
      const dispatch = await api.setDispatchChannel(selectedChannel);
      if (!dispatch.ok) throw new Error(dispatch.error || '渠道账号已保存，但派发渠道未能切换。');
      setStatus({ kind: 'ok', text: '渠道已保存并设为自动派发渠道；请重载看板后让正在运行的进程读取新密钥。' });
      toast(`${selectedMeta.label} 已配置`, 'ok');
      onDispatchSaved?.();
      await loadAccounts();
    } catch (error) {
      setStatus({ kind: 'err', text: error instanceof Error ? error.message : '渠道配置保存失败。' });
      toast('渠道配置未保存', 'err');
    } finally {
      setWorking(false);
    }
  };

  const probe = async () => {
    const currentBridge = bridge();
    if (!currentBridge?.probeChannelAccount) return;
    setWorking(true);
    setStatus({ kind: 'pending', text: '正在请求 OpenClaw 检测渠道连接…' });
    try {
      const result = await currentBridge.probeChannelAccount({ channel: selectedChannel, accountId });
      setStatus({ kind: result.ok ? 'ok' : 'err', text: result.message });
    } catch (error) {
      setStatus({ kind: 'err', text: error instanceof Error ? error.message : '渠道检测失败。' });
    } finally {
      setWorking(false);
    }
  };

  const remove = async () => {
    const currentBridge = bridge();
    if (!currentBridge?.removeChannelAccount) return;
    if (!window.confirm(`确定移除 ${selectedMeta.label} 的「${accountId}」配置吗？这会删除本机保存的渠道密钥。`)) return;
    setWorking(true);
    setStatus({ kind: 'pending', text: '正在移除渠道配置…' });
    try {
      await currentBridge.removeChannelAccount({ channel: selectedChannel, accountId });
      setForm(initialForm(selectedChannel));
      setStatus({ kind: 'ok', text: '渠道配置已移除；请重载看板后生效。' });
      toast('渠道配置已移除', 'ok');
      await loadAccounts();
    } catch (error) {
      setStatus({ kind: 'err', text: error instanceof Error ? error.message : '渠道配置移除失败。' });
    } finally {
      setWorking(false);
    }
  };

  const reload = async () => {
    const currentBridge = bridge();
    if (!currentBridge?.reloadDashboard) return;
    setWorking(true);
    setStatus({ kind: 'pending', text: '正在重载看板，读取最新渠道配置…' });
    try {
      await currentBridge.reloadDashboard();
      setStatus({ kind: 'ok', text: '看板已重载，新的渠道配置已生效。' });
      toast('看板已重载', 'ok');
    } catch (error) {
      setStatus({ kind: 'err', text: error instanceof Error ? error.message : '看板重载失败。' });
    } finally {
      setWorking(false);
    }
  };

  const secretPlaceholder = (field: string) => isConfiguredSecret(selectedSummary, field) ? '已安全保存，留空保持不变' : '请输入，不会写入项目文件';

  return (
    <section className="mc-channel" aria-labelledby="mc-channel-title">
      <div className="mc-channel-head">
        <div>
          <div className="mc-profile-kicker">运行时连接</div>
          <h2 id="mc-channel-title">派发渠道</h2>
          <p>把原本需要在终端执行的 OpenClaw 渠道配置收进软件；密钥只保存在本机加密凭据库。</p>
        </div>
        <div className={`mc-channel-badge ${selectedSummary?.configured && selectedSummary.enabled ? 'ready' : 'muted'}`}>
          {selectedSummary?.configured && selectedSummary.enabled ? <CheckCircle2 size={15} /> : <CircleAlert size={15} />}
          {selectedSummary?.configured && selectedSummary.enabled ? '已配置' : '待配置'}
        </div>
      </div>

      <div className="mc-channel-toolbar">
        <label className="mc-profile-field">
          <span>自动派发使用</span>
          <select
            className="msel"
            aria-label="派发渠道"
            value={selectedChannel}
            onChange={(event) => {
              setSelectedChannel(event.target.value as ChannelId);
              setAccountId('default');
              setStatus(null);
            }}
          >
            {CHANNELS.map((channel) => <option key={channel.id} value={channel.id}>{channel.label}</option>)}
          </select>
        </label>
        <div className="mc-channel-toolbar-actions">
          <span className={`mc-channel-plugin ${selectedSummary?.pluginInstalled ? 'installed' : ''}`}>
            <PlugZap size={14} />
            {selectedSummary?.pluginInstalled ? '组件已安装' : '保存时自动安装组件'}
          </span>
          <button className="btn btn-g" type="button" disabled={working || loading} onClick={() => void probe()}>
            {working ? <LoaderCircle size={14} className="spin" /> : <Wifi size={14} />}
            检测连接
          </button>
        </div>
      </div>

      <div className="mc-channel-form">
        <label className="mc-profile-field">
          <span>账号标识</span>
          <input
            className="mtext"
            value={accountId}
            list={`channel-accounts-${selectedChannel}`}
            onChange={(event) => setAccountId(event.target.value.toLowerCase())}
            placeholder="default"
            autoComplete="off"
          />
          <datalist id={`channel-accounts-${selectedChannel}`}>
            {channelAccounts.map((account) => <option key={account.accountId} value={account.accountId} />)}
          </datalist>
        </label>

        <label className="mc-profile-field">
          <span>显示名称（可选）</span>
          <input className="mtext" value={form.name || ''} onChange={(event) => update('name', event.target.value)} placeholder={selectedMeta.label} />
        </label>

        {selectedChannel === 'feishu' && <>
          <label className="mc-profile-field"><span>App ID</span><input className="mtext" value={form.appId || ''} onChange={(event) => update('appId', event.target.value)} placeholder="cli_xxxxxxxxxxxx" /></label>
          <label className="mc-profile-field"><span>App Secret</span><input className="mtext" type="password" value={form.appSecret || ''} onChange={(event) => update('appSecret', event.target.value)} placeholder={secretPlaceholder('appSecret')} autoComplete="new-password" /></label>
          <label className="mc-profile-field"><span>服务域名</span><select className="msel" value={form.domain || 'feishu'} onChange={(event) => update('domain', event.target.value)}><option value="feishu">中国大陆 Feishu</option><option value="lark">国际版 Lark</option></select></label>
        </>}

        {selectedChannel === 'telegram' && <label className="mc-profile-field"><span>Bot Token</span><input className="mtext" type="password" value={form.botToken || ''} onChange={(event) => update('botToken', event.target.value)} placeholder={secretPlaceholder('botToken')} autoComplete="new-password" /></label>}

        {selectedChannel === 'discord' && <>
          <label className="mc-profile-field"><span>Bot Token</span><input className="mtext" type="password" value={form.botToken || ''} onChange={(event) => update('botToken', event.target.value)} placeholder={secretPlaceholder('token')} autoComplete="new-password" /></label>
          <label className="mc-profile-field"><span>Application ID（可选）</span><input className="mtext" value={form.applicationId || ''} onChange={(event) => update('applicationId', event.target.value)} placeholder="Discord 应用 ID" /></label>
        </>}

        {selectedChannel === 'slack' && <>
          <label className="mc-profile-field"><span>Bot Token</span><input className="mtext" type="password" value={form.botToken || ''} onChange={(event) => update('botToken', event.target.value)} placeholder={secretPlaceholder('botToken')} autoComplete="new-password" /></label>
          <label className="mc-profile-field"><span>App Token</span><input className="mtext" type="password" value={form.appToken || ''} onChange={(event) => update('appToken', event.target.value)} placeholder={secretPlaceholder('appToken')} autoComplete="new-password" /></label>
          <label className="mc-profile-field"><span>Signing Secret（可选）</span><input className="mtext" type="password" value={form.signingSecret || ''} onChange={(event) => update('signingSecret', event.target.value)} placeholder={secretPlaceholder('signingSecret')} autoComplete="new-password" /></label>
        </>}

        {selectedChannel === 'signal' && <>
          <label className="mc-profile-field"><span>Signal 账号（E.164）</span><input className="mtext" value={form.account || ''} onChange={(event) => update('account', event.target.value)} placeholder="+8613800000000" /></label>
          <label className="mc-profile-field"><span>REST 服务地址</span><input className="mtext" value={form.httpUrl || ''} onChange={(event) => update('httpUrl', event.target.value)} placeholder="http://127.0.0.1:8080" /></label>
        </>}
      </div>

      <div className="mc-channel-help"><ShieldCheck size={14} />{selectedMeta.help} 密钥不会进入 Git、项目文件或界面回显。</div>
      {selectedChannel === 'feishu' && <div className="mc-channel-help secondary">飞书还需要在开放平台启用机器人，并把事件订阅方式设为 WebSocket；这些是平台侧权限，应用会在检测时告诉你缺哪一步。</div>}

      <div className="mc-channel-actions">
        <button className="btn btn-p" type="button" disabled={working || loading} onClick={() => void save()}>
          {working ? <LoaderCircle size={14} className="spin" /> : <CheckCircle2 size={14} />}
          保存并启用
        </button>
        <button className="btn btn-g" type="button" disabled={working || loading || !selectedSummary?.configured} onClick={() => void remove()}><Trash2 size={14} />移除配置</button>
        {needsReload && <button className="btn btn-g" type="button" disabled={working} onClick={() => void reload()}><RefreshCw size={14} />立即重载看板</button>}
      </div>
      {status && <div className={`mc-profile-status ${status.kind}`} role={status.kind === 'err' ? 'alert' : 'status'}>{status.kind === 'pending' && <LoaderCircle size={13} className="spin" />}{status.text}</div>}
    </section>
  );
}
