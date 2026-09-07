import { useEffect, useMemo, useState } from 'react';
import { CheckCircle2, LoaderCircle, MessageSquare, Send, ShieldCheck } from 'lucide-react';
import { api, type CommandCenterData, type CommandPlan } from '../api';
import { useStore } from '../store';

const modeOptions = [
  { value: '', label: '自动分拣', hint: '交给太子判断' },
  { value: 'chat', label: '实时问询', hint: '不建立任务' },
  { value: 'small', label: '小任务', hint: '调用一个空闲六部 Agent' },
  { value: 'standard', label: '正式任务', hint: '完整三省六部' },
  { value: 'complex', label: '复杂任务', hint: '多步骤/跨部门' },
] as const;

function PlanPreview({ plan }: { plan: CommandPlan }) {
  return <div className="command-plan" aria-label="太子分拣计划">
    <div className="command-plan-head"><strong>{plan.modeLabel}</strong><span>{plan.reason}</span></div>
    <div className="command-plan-grid">
      <div><small>目标 Agent</small><span>{plan.suggestedAgents.join(' → ')}</span></div>
      <div><small>下一步</small><span>{plan.nextStep}</span></div>
    </div>
    <p><ShieldCheck size={12} />{plan.permissionScope}</p>
  </div>;
}

export default function CommandCenterPanel() {
  const toast = useStore((state) => state.toast);
  const setActiveTab = useStore((state) => state.setActiveTab);
  const setModalTaskId = useStore((state) => state.setModalTaskId);
  const [data, setData] = useState<CommandCenterData | null>(null);
  const [text, setText] = useState('');
  const [mode, setMode] = useState<typeof modeOptions[number]['value']>('');
  const [permissionMode, setPermissionMode] = useState<'ask' | 'auto' | 'full'>('full');
  const [sending, setSending] = useState(false);

  const refresh = async () => {
    try { setData(await api.commandCenter()); } catch { /* dashboard startup may still be loading */ }
  };

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 4000);
    return () => window.clearInterval(timer);
  }, []);

  const lastPlan = useMemo(() => {
    const messages = data?.messages || [];
    return [...messages].reverse().find((message) => message.plan)?.plan || null;
  }, [data]);

  const send = async () => {
    const value = text.trim();
    if (!value || sending) return;
    setSending(true);
    try {
      const result = await api.commandCenterMessage({ text: value, mode, permissionMode });
      setData(result);
      if (result.ok && !result.requiresApproval) {
        setText('');
        if (result.taskId) toast(`📜 ${result.taskId} 已进入执行队列`);
      } else if (!result.ok) {
        toast(result.error || '太子分拣失败', 'err');
      }
    } catch (reason) {
      toast(reason instanceof Error ? reason.message : '总控台连接失败', 'err');
    } finally {
      setSending(false);
    }
  };

  const approve = async () => {
    if (sending) return;
    setSending(true);
    try {
      const result = await api.commandCenterApprove();
      setData(result);
      if (result.ok) {
        setText('');
        if (result.taskId) toast(`📜 ${result.taskId} 已确认并进入执行队列`);
      } else toast(result.error || '确认失败', 'err');
    } catch (reason) {
      toast(reason instanceof Error ? reason.message : '确认请求失败', 'err');
    } finally {
      setSending(false);
    }
  };

  const messages = (data?.messages || []).slice(-8);
  const pending = data?.pendingPlan;
  const plan = pending?.plan || lastPlan;

  return <section className="command-center" aria-labelledby="command-center-title">
    <div className="command-center-head">
      <div>
        <div className="command-center-kicker"><MessageSquare size={14} />皇上 · 总控台</div>
        <h2 id="command-center-title">向太子下旨</h2>
        <p>所有桌面指令先经过太子分拣：实时问询不占正式任务；小任务调用空闲六部 Agent；正式任务保持完整三省六部链。</p>
      </div>
      <div className="command-permission" title="Codex 完全访问的工作区边界：在选定项目内读写和执行，工作区外及系统敏感操作另行确认">
        <ShieldCheck size={15} />
        <span>完全访问 · 当前工作区</span>
      </div>
    </div>

    <div className="command-mode-row" aria-label="任务模式">
      {modeOptions.map((item) => <button key={item.value || 'auto'} type="button" className={mode === item.value ? 'active' : ''} onClick={() => setMode(item.value)}>
        <strong>{item.label}</strong><small>{item.hint}</small>
      </button>)}
    </div>

    <form className="command-composer" onSubmit={(event) => { event.preventDefault(); void send(); }}>
      <textarea aria-label="交给太子的指令" value={text} onChange={(event) => setText(event.target.value)} disabled={sending} rows={3} maxLength={12000} placeholder="例如：检查当前项目的测试失败原因；或：开发一个网页并完成测试…" />
      <div className="command-composer-footer">
        <div className="command-permission-options" aria-label="复杂任务授权方式">
          <span>复杂任务：</span>
          {([['full', '完全访问'], ['auto', '自动批准'], ['ask', '执行前询问']] as const).map(([value, label]) => <label key={value}><input type="radio" name="command-permission" checked={permissionMode === value} onChange={() => setPermissionMode(value)} />{label}</label>)}
        </div>
        <button className="btn btn-p" type="submit" disabled={sending || !text.trim()}>{sending ? <LoaderCircle className="guard-spin" size={14} /> : <Send size={14} />}{sending ? '分拣中…' : '交给太子'}</button>
      </div>
    </form>

    {plan && <PlanPreview plan={plan} />}
    {pending && <div className="command-approval" role="status"><div><strong>复杂任务等待确认</strong><span>确认后才会建立唯一的正式任务并调用三省六部。</span></div><button className="btn btn-p" type="button" onClick={() => void approve()} disabled={sending}><CheckCircle2 size={14} />确认执行</button></div>}

    {messages.length > 0 && <div className="command-history" aria-label="总控台对话记录">
      {messages.map((message) => <div className={`command-message ${message.role}`} key={message.id}><span>{message.role === 'emperor' ? '皇上' : '太子'}</span><p>{message.text}</p>{message.action === 'open-yushufang' && <button className="command-link" type="button" onClick={() => setActiveTab('yushufang')}>打开御书房实时问询</button>}{message.taskId && <button className="command-link" type="button" onClick={() => setModalTaskId(message.taskId || null)}>查看任务详情</button>}</div>)}
    </div>}
  </section>;
}
