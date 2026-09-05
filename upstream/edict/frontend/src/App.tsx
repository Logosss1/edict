import { useEffect, useState } from 'react';
import { api, type ReadinessData } from './api';
import { useStore, TAB_DEFS, startPolling, stopPolling, isEdict, isArchived } from './store';
import EdictBoard from './components/EdictBoard';
import MonitorPanel from './components/MonitorPanel';
import OfficialPanel from './components/OfficialPanel';
import ModelConfig from './components/ModelConfig';
import SkillsConfig from './components/SkillsConfig';
import SessionsPanel from './components/SessionsPanel';
import MemorialPanel from './components/MemorialPanel';
import TemplatePanel from './components/TemplatePanel';
import MorningPanel from './components/MorningPanel';
import TaskModal from './components/TaskModal';
// ConfirmDialog is used inside TaskModal as needed
import Toaster from './components/Toaster';
import CourtCeremony from './components/CourtCeremony';
import CourtDiscussion from './components/CourtDiscussion';
import Yushufang from './components/Yushufang';

export default function App() {
  const activeTab = useStore((s) => s.activeTab);
  const setActiveTab = useStore((s) => s.setActiveTab);
  const liveStatus = useStore((s) => s.liveStatus);
  const countdown = useStore((s) => s.countdown);
  const loadAll = useStore((s) => s.loadAll);
  const [readiness, setReadiness] = useState<ReadinessData | null>(null);

  useEffect(() => {
    startPolling();
    return () => stopPolling();
  }, []);

  useEffect(() => {
    const bridge = (window as Window & { edictDesktop?: { onModelSettings?: (callback: () => void) => () => void } }).edictDesktop;
    return bridge?.onModelSettings?.(() => setActiveTab('models'));
  }, [setActiveTab]);

  useEffect(() => {
    let mounted = true;
    const refresh = async () => {
      try {
        const result = await api.readiness();
        if (mounted) setReadiness(result);
      } catch {
        // The existing sync chip remains the source of truth when the
        // readiness endpoint is not reachable yet.
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 6000);
    return () => {
      mounted = false;
      window.clearInterval(timer);
    };
  }, []);

  // Compute header chips
  const tasks = liveStatus?.tasks || [];
  const edicts = tasks.filter(isEdict);
  const activeEdicts = edicts.filter((t) => !isArchived(t));
  const sync = liveStatus?.syncStatus;
  const syncOk = sync?.ok;

  // Tab badge counts
  const tabBadge = (key: string): string => {
    if (key === 'edicts') return String(activeEdicts.length);
    if (key === 'sessions') return String(tasks.filter((t) => !isEdict(t)).length);
    if (key === 'memorials') return String(edicts.filter((t) => ['Done', 'Cancelled'].includes(t.state)).length);
    if (key === 'monitor') {
      const activeDepts = tasks.filter((t) => isEdict(t) && t.state === 'Doing').length;
      return activeDepts + '活跃';
    }
    return '';
  };

  return (
    <div className="wrap">
      {/* ── Header ── */}
      <div className="hdr">
        <div>
          <div className="logo">Edict_InnerCourt</div>
          <div className="sub-text">三省六部 · 总控台</div>
        </div>
        <div className="hdr-r">
          <span className={`chip ${syncOk ? 'ok' : syncOk === false ? 'err' : ''}`}>
            {syncOk ? '✅ 同步正常' : syncOk === false ? '❌ 服务器未启动' : '⏳ 连接中…'}
          </span>
          <span className="chip">{activeEdicts.length} 道旨意</span>
          <button className="btn-refresh" onClick={() => loadAll()}>
            ⟳ 刷新
          </button>
          <span style={{ fontSize: 11, color: 'var(--muted)' }}>⟳ {countdown}s</span>
        </div>
      </div>

      {/* ── Tabs ── */}
      <div className="tabs" role="tablist" aria-label="总控台页面">
        {TAB_DEFS.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-label={t.label}
            aria-selected={activeTab === t.key}
            className={`tab ${activeTab === t.key ? 'active' : ''}`}
            onClick={() => setActiveTab(t.key)}
          >
            {t.icon} {t.label}
            {tabBadge(t.key) && <span className="tbadge">{tabBadge(t.key)}</span>}
          </button>
        ))}
      </div>

      {readiness && !readiness.ready && <section className="readiness-banner" role="status" aria-label="首次配置状态">
        <div className="readiness-copy">
          <strong>首次使用还差一步</strong>
          <span>{readiness.next || '请打开设置完成供应商和 Agent 模型配置。'}</span>
          {readiness.checks.filter((check) => !check.ready).length > 0 && <ul>
            {readiness.checks.filter((check) => !check.ready).map((check) => <li key={check.id}>{check.label}：{check.detail}</li>)}
          </ul>}
        </div>
        {window.edictDesktop?.openSettings && <button className="btn btn-g" type="button" onClick={() => void window.edictDesktop?.openSettings?.()}>
          打开设置完成配置
        </button>}
      </section>}

      {/* ── Panels ── */}
      {activeTab === 'edicts' && <EdictBoard />}
      {activeTab === 'court' && <CourtDiscussion />}
      {activeTab === 'yushufang' && <Yushufang />}
      {activeTab === 'monitor' && <MonitorPanel />}
      {activeTab === 'officials' && <OfficialPanel />}
      {activeTab === 'models' && <ModelConfig />}
      {activeTab === 'skills' && <SkillsConfig />}
      {activeTab === 'sessions' && <SessionsPanel />}
      {activeTab === 'memorials' && <MemorialPanel />}
      {activeTab === 'templates' && <TemplatePanel />}
      {activeTab === 'morning' && <MorningPanel />}

      {/* ── Overlays ── */}
      <TaskModal />
      <Toaster />
      <CourtCeremony />
    </div>
  );
}
