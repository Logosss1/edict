import { useState } from 'react';
import { useStore, isEdict, isArchived, getPipeStatus, stateLabel, deptColor, PIPE } from '../store';
import { api, type Task } from '../api';
import { waitForTaskOperation } from '../async-actions';
import ConfirmDialog from './ConfirmDialog';
import CommandCenterPanel from './CommandCenterPanel';

type ActionDialog = {
  title: string;
  message: string;
  okLabel: string;
  okClass?: string;
  onOk: (reason: string) => void;
};

const DISPATCH_LABELS: Record<string, string> = {
  idle: '未开始派发', queued: '已排队', dispatching: '派发中', waiting_gateway: '等待 Gateway',
  running: 'Agent 处理中', success: '已派发', retrying: '重试中', disabled: '自动派发已暂停',
  cancelled: '已停止', awaiting_assignment: '等待尚书省指定六部', not_needed: '无需派发', 'gateway-offline': 'Gateway 不可用',
  'openclaw-missing': '运行时缺失', timeout: '派发超时', failed: '派发失败', error: '派发异常',
};

function dispatchInfo(task: Task) {
  const scheduler = task._scheduler;
  const status = scheduler?.lastDispatchStatus || 'idle';
  const label = status === 'success' && scheduler?.stateTransitionObserved === false
    ? 'Agent已返回，等待阶段更新'
    : DISPATCH_LABELS[status] || status;
  const detail = scheduler?.lastDispatchError || scheduler?.lastEvent || '';
  const tone = ['gateway-offline', 'openclaw-missing', 'timeout', 'failed', 'error'].includes(status)
    ? 'error'
    : ['queued', 'dispatching', 'waiting_gateway', 'running', 'retrying'].includes(status)
      ? 'active'
      : ['disabled', 'awaiting_assignment'].includes(status) ? 'paused' : 'neutral';
  return { status, label, detail, tone };
}

// 排序权重
const STATE_ORDER: Record<string, number> = {
  Doing: 0, Review: 1, Assigned: 2, Menxia: 3, Zhongshu: 4,
  Taizi: 5, Inbox: 6, Blocked: 7, Next: 8, Done: 9, Cancelled: 10,
};

function MiniPipe({ task }: { task: Task }) {
  const stages = getPipeStatus(task);
  return (
    <div className="ec-pipe">
      {stages.map((s, i) => (
        <span key={s.key} style={{ display: 'contents' }}>
          <div className={`ep-node ${s.status}`}>
            <div className="ep-icon">{s.icon}</div>
            <div className="ep-name">{s.dept}</div>
          </div>
          {i < stages.length - 1 && <div className="ep-arrow">›</div>}
        </span>
      ))}
    </div>
  );
}

function EdictCard({ task }: { task: Task }) {
  const setModalTaskId = useStore((s) => s.setModalTaskId);
  const toast = useStore((s) => s.toast);
  const loadAll = useStore((s) => s.loadAll);
  const [actionBusy, setActionBusy] = useState(false);
  const [actionLabel, setActionLabel] = useState('');
  const [actionDialog, setActionDialog] = useState<ActionDialog | null>(null);

  const hb = task.heartbeat || { status: 'unknown', label: '⚪' };
  const stCls = 'st-' + (task.state || '');
  const deptCls = 'dt-' + (task.org || '').replace(/\s/g, '');
  const curStage = PIPE.find((_, i) => getPipeStatus(task)[i].status === 'active');
  const todos = task.todos || [];
  const todoDone = todos.filter((x) => x.status === 'completed').length;
  const todoTotal = todos.length;
  const canStop = !['Done', 'Blocked', 'Cancelled'].includes(task.state);
  const canCancel = !['Done', 'Cancelled'].includes(task.state);
  const canResume = ['Blocked', 'Cancelled'].includes(task.state);
  const canDelete = ['Done', 'Cancelled'].includes(task.state);
  const archived = isArchived(task);
  const isBlocked = task.block && task.block !== '无' && task.block !== '-';
  const dispatch = dispatchInfo(task);
  const canRetryDispatch = !['Done', 'Cancelled', 'Blocked'].includes(task.state)
    && ['idle', 'failed', 'gateway-offline', 'openclaw-missing', 'timeout', 'error'].includes(dispatch.status);

  const submitAction = async (action: string, reason: string) => {
    setActionBusy(true);
    setActionLabel(action === 'resume' ? '正在恢复，并等待调度器确认…' : action === 'stop' ? '正在叫停，并等待进程退出…' : '正在取消，并等待状态落盘…');
    try {
      const r = await api.taskAction(task.id, action, reason);
      if (!r.ok) {
        toast(r.error || '操作失败', 'err');
        return;
      }
      const waited = await waitForTaskOperation(task.id, action as 'stop' | 'cancel' | 'resume', r.state);
      await loadAll();
      if (waited.status === 'confirmed') toast(r.message || (action === 'resume' ? '已恢复，调度器已接手' : '操作已确认'));
      else if (waited.status === 'failed') toast(waited.detail || '调度器未能完成操作', 'err');
      else toast('操作已提交，后台仍在处理；请稍后查看任务状态。');
    } catch { toast('服务器连接失败', 'err'); }
    finally { setActionLabel(''); setActionBusy(false); }
  };

  const handleAction = (action: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (actionBusy) return;
    if (action === 'resume') {
      void submitAction(action, '恢复执行');
      return;
    }
    setActionDialog({
      title: action === 'stop' ? '叫停任务' : '取消任务',
      message: action === 'stop'
        ? '确认叫停 ' + task.id + '？\n\n当前执行会被停止，任务保留为阻塞状态，之后可以恢复。'
        : '确认取消 ' + task.id + '？\n\n任务会停止并标记为已取消，之后仍可选择恢复。',
      okLabel: action === 'stop' ? '确认叫停' : '确认取消',
      okClass: action === 'stop' ? 'btn-stop' : 'btn-cancel',
      onOk: (reason) => { setActionDialog(null); void submitAction(action, reason); },
    });
  };

  const handleArchive = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (actionBusy) return;
    setActionBusy(true);
    setActionLabel(task.archived ? '正在取消归档…' : '正在归档记录…');
    try {
      const r = await api.archiveTask(task.id, !task.archived);
      if (r.ok) { toast(r.message || '操作成功'); loadAll(); }
      else toast(r.error || '操作失败', 'err');
    } catch { toast('服务器连接失败', 'err'); }
    finally { setActionLabel(''); setActionBusy(false); }
  };

  const retryDispatch = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (actionBusy) return;
    setActionBusy(true);
    setActionLabel('正在重新派发，并等待调度器确认…');
    try {
      const r = await api.schedulerRetry(task.id, '看板发现任务尚未完成派发，皇上手动重试');
      if (!r.ok) {
        toast(r.error || '重试派发失败', 'err');
        return;
      }
      const waited = await waitForTaskOperation(task.id, 'dispatch');
      await loadAll();
      if (waited.status === 'confirmed') toast(r.message || '已重新派发');
      else if (waited.status === 'failed') toast(waited.detail || '重试派发失败', 'err');
      else toast('重试已提交，后台仍在处理；请稍后查看任务状态。');
    } catch { toast('服务器连接失败', 'err'); }
    finally { setActionLabel(''); setActionBusy(false); }
  };

  const deleteTask = async () => {
    setActionBusy(true);
    setActionLabel('正在删除记录…');
    try {
      const r = await api.deleteTask(task.id);
      if (r.ok) { toast(r.message || '任务记录已删除'); loadAll(); }
      else toast(r.error || '删除失败', 'err');
    } catch { toast('服务器连接失败', 'err'); }
    finally { setActionLabel(''); setActionBusy(false); }
  };

  const handleDelete = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (actionBusy || !canDelete) return;
    setActionDialog({
      title: '永久删除任务记录',
      message: '确认删除 ' + task.id + '？' + (task.title ? '\n\n' + task.title : '') + '\n\n任务记录会从旨意看板、奏折阁和相关任务页面一并移除，且无法恢复。',
      okLabel: '永久删除',
      okClass: 'btn-cancel',
      onOk: () => { setActionDialog(null); void deleteTask(); },
    });
  };

  return (
    <div
      className={`edict-card${archived ? ' archived' : ''}`}
      onClick={() => setModalTaskId(task.id)}
    >
      <MiniPipe task={task} />
      <div className="ec-id">{task.id}</div>
      <div className="ec-title">{task.title || '(无标题)'}</div>
      <div className="ec-meta">
        <span className={`tag ${stCls}`}>{stateLabel(task)}</span>
        {task.org && <span className={`tag ${deptCls}`}>{task.org}</span>}
        {curStage && (
          <span style={{ fontSize: 11, color: 'var(--muted)' }}>
            当前: <b style={{ color: deptColor(curStage.dept) }}>{curStage.dept} · {curStage.action}</b>
          </span>
        )}
      </div>
      {task.now && task.now !== '-' && (
        <div style={{ fontSize: 11, color: 'var(--muted)', lineHeight: 1.5, marginBottom: 6 }}>
          {task.now.substring(0, 80)}
        </div>
      )}
      <div className={`ec-dispatch-status ${dispatch.tone}`} title={dispatch.detail || undefined}>
        <span>🧭 派发：{dispatch.label}</span>
        {dispatch.detail && <span className="ec-dispatch-detail">{dispatch.detail.substring(0, 100)}</span>}
      </div>
      {(task.review_round || 0) > 0 && (
        <div style={{ fontSize: 11, marginBottom: 6 }}>
          {Array.from({ length: task.review_round || 0 }, (_, i) => (
            <span
              key={i}
              style={{
                display: 'inline-block', width: 14, height: 14, borderRadius: '50%',
                background: i < (task.review_round || 0) - 1 ? '#1a3a6a22' : 'var(--acc)22',
                border: `1px solid ${i < (task.review_round || 0) - 1 ? '#2a4a8a' : 'var(--acc)'}`,
                fontSize: 9, textAlign: 'center', lineHeight: '13px', marginRight: 2,
                color: i < (task.review_round || 0) - 1 ? '#4a6aaa' : 'var(--acc)',
              }}
            >
              {i + 1}
            </span>
          ))}
          <span style={{ color: 'var(--muted)', fontSize: 10 }}>第 {task.review_round} 轮磋商</span>
        </div>
      )}
      {todoTotal > 0 && (
        <div className="ec-todo-bar">
          <span>📋 {todoDone}/{todoTotal}</span>
          <div className="ec-todo-track">
            <div className="ec-todo-fill" style={{ width: `${Math.round((todoDone / todoTotal) * 100)}%` }} />
          </div>
          <span>{todoDone === todoTotal ? '✅ 全部完成' : '🔄 进行中'}</span>
        </div>
      )}
      <div className="ec-footer">
        <span className={`hb ${hb.status}`}>{hb.label}</span>
        {isBlocked && (
          <span className="tag" style={{ borderColor: '#ff527044', color: 'var(--danger)', background: '#200a10' }}>
            🚫 {task.block}
          </span>
        )}
        {task.eta && task.eta !== '-' && (
          <span style={{ fontSize: 11, color: 'var(--muted)' }}>📅 {task.eta}</span>
        )}
      </div>
      {isBlocked && <div className="ec-error" role="alert" title={task.block}>
        <span>派发未完成</span><strong>{task.block}</strong>
      </div>}
      <div className="ec-actions" onClick={(e) => e.stopPropagation()}>
        {actionBusy && <span className="async-action-status" role="status" aria-live="polite">⟳ {actionLabel || '正在处理…'}</span>}
        {canStop && (
          <>
            <button className="mini-act" onClick={(e) => void handleAction('stop', e)} disabled={actionBusy}>⏸ 叫停</button>
            <button className="mini-act danger" onClick={(e) => void handleAction('cancel', e)} disabled={actionBusy}>🚫 取消</button>
          </>
        )}
        {!canStop && canCancel && (
          <button className="mini-act danger" onClick={(e) => void handleAction('cancel', e)} disabled={actionBusy}>🚫 取消</button>
        )}
        {canResume && (
          <button className="mini-act" onClick={(e) => void handleAction('resume', e)} disabled={actionBusy}>▶ 恢复</button>
        )}
        {!archived && (
          <button className="mini-act" onClick={handleArchive} disabled={actionBusy}>📦 归档</button>
        )}
        {archived && (
          <button className="mini-act" onClick={handleArchive} disabled={actionBusy}>📤 取消归档</button>
        )}
        {canDelete && (
          <button className="mini-act danger" onClick={handleDelete} disabled={actionBusy}>🗑 删除记录</button>
        )}
        {canRetryDispatch && (
          <button className="mini-act" onClick={retryDispatch} disabled={actionBusy}>🔁 立即重试派发</button>
        )}
      </div>
      {actionDialog && <ConfirmDialog {...actionDialog} onCancel={() => setActionDialog(null)} />}
    </div>
  );
}

export default function EdictBoard() {
  const liveStatus = useStore((s) => s.liveStatus);
  const edictFilter = useStore((s) => s.edictFilter);
  const setEdictFilter = useStore((s) => s.setEdictFilter);
  const toast = useStore((s) => s.toast);
  const loadAll = useStore((s) => s.loadAll);
  const [archiveAllDialog, setArchiveAllDialog] = useState<ActionDialog | null>(null);

  const tasks = liveStatus?.tasks || [];
  const allEdicts = tasks.filter(isEdict);
  const activeEdicts = allEdicts.filter((t) => !isArchived(t));
  const archivedEdicts = allEdicts.filter((t) => isArchived(t));

  let edicts: Task[];
  if (edictFilter === 'active') edicts = activeEdicts;
  else if (edictFilter === 'archived') edicts = archivedEdicts;
  else edicts = allEdicts;

  edicts.sort((a, b) => (STATE_ORDER[a.state] ?? 9) - (STATE_ORDER[b.state] ?? 9));

  const unArchivedDone = allEdicts.filter((t) => !t.archived && ['Done', 'Cancelled'].includes(t.state));

  const archiveAllDone = async () => {
    try {
      const r = await api.archiveAllDone();
      if (r.ok) { toast(`📦 ${r.count || 0} 道旨意已归档`); loadAll(); }
      else toast(r.error || '批量归档失败', 'err');
    } catch { toast('服务器连接失败', 'err'); }
  };

  const handleArchiveAll = () => {
    setArchiveAllDialog({
      title: '批量归档旨意',
      message: '将所有已完成或已取消的旨意移入归档？原记录仍可在存档页面查看。',
      okLabel: '确认归档',
      okClass: 'btn-resume',
      onOk: () => { setArchiveAllDialog(null); void archiveAllDone(); },
    });
  };

  const handleScan = async () => {
    try {
      const r = await api.schedulerScan();
      if (r.ok) toast(`🧭 太子巡检完成：${r.count || 0} 个动作`);
      else toast(r.error || '巡检失败', 'err');
      loadAll();
    } catch { toast('服务器连接失败', 'err'); }
  };

  return (
    <div>
      <CommandCenterPanel />
      {/* Archive Bar */}
        <div className="archive-bar">
        <span className="ab-label">筛选:</span>
        {(['active', 'archived', 'all'] as const).map((f) => (
          <button
            key={f}
            className={`ab-btn ${edictFilter === f ? 'active' : ''}`}
            onClick={() => setEdictFilter(f)}
          >
            {f === 'active' ? '活跃' : f === 'archived' ? '归档' : '全部'}
          </button>
        ))}
        {unArchivedDone.length > 0 && (
          <button className="ab-btn" onClick={handleArchiveAll}>📦 一键归档</button>
        )}
        <span className="ab-count">
          活跃 {activeEdicts.length} · 归档 {archivedEdicts.length} · 共 {allEdicts.length}
        </span>
        <button className="ab-scan" onClick={handleScan}>🧭 太子巡检</button>
      </div>

      {/* Grid */}
      <div className="edict-grid">
        {edicts.length === 0 ? (
          <div className="empty" style={{ gridColumn: '1/-1' }}>
            暂无旨意<br />
            <small style={{ fontSize: 11, marginTop: 6, display: 'block', color: 'var(--muted)' }}>
              默认由桌面内置本地派发；已验证外部渠道时按派发设置发送，太子分拣后转中书省处理
            </small>
          </div>
        ) : (
          edicts.map((t) => <EdictCard key={t.id} task={t} />)
        )}
      </div>
      {archiveAllDialog && <ConfirmDialog {...archiveAllDialog} onCancel={() => setArchiveAllDialog(null)} />}
    </div>
  );
}
