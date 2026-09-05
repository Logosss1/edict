/**
 * API 层 — 对接 dashboard/server.py
 * 生产环境从同源 (port 7891) 请求，开发环境可通过 VITE_API_URL 指定
 */

const API_BASE = import.meta.env.VITE_API_URL || '';

// ── 通用请求 ──

async function fetchJ<T>(url: string): Promise<T> {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(String(res.status));
  return res.json();
}

async function postJ<T>(url: string, data: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  return res.json();
}

// ── API 接口 ──

export const api = {
  // 核心数据
  liveStatus: () => fetchJ<LiveStatus>(`${API_BASE}/api/live-status`),
  agentConfig: () => fetchJ<AgentConfig>(`${API_BASE}/api/agent-config`),
  modelChangeLog: () => fetchJ<ChangeLogEntry[]>(`${API_BASE}/api/model-change-log`).catch(() => []),
  officialsStats: () => fetchJ<OfficialsData>(`${API_BASE}/api/officials-stats`),
  morningBrief: () => fetchJ<MorningBrief>(`${API_BASE}/api/morning-brief`),
  morningConfig: () => fetchJ<SubConfig>(`${API_BASE}/api/morning-config`),
  agentsStatus: () => fetchJ<AgentsStatusData>(`${API_BASE}/api/agents-status`),
  readiness: () => fetchJ<ReadinessData>(`${API_BASE}/api/readiness`),

  // 任务实时动态
  taskActivity: (id: string) =>
    fetchJ<TaskActivityData>(`${API_BASE}/api/task-activity/${encodeURIComponent(id)}`),
  schedulerState: (id: string) =>
    fetchJ<SchedulerStateData>(`${API_BASE}/api/scheduler-state/${encodeURIComponent(id)}`),

  // 技能内容
  skillContent: (agentId: string, skillName: string) =>
    fetchJ<SkillContentResult>(
      `${API_BASE}/api/skill-content/${encodeURIComponent(agentId)}/${encodeURIComponent(skillName)}`
    ),

  // 操作类
  setModel: (agentId: string, model: string) =>
    postJ<ActionResult>(`${API_BASE}/api/set-model`, { agentId, model }),
  setModelProfile: (providerId: string, modelId: string, thinkingDefault: string) =>
    postJ<ActionResult & { model?: string; thinkingDefault?: string; thinking?: string; agentCount?: number }>(
      `${API_BASE}/api/set-model-profile`, { providerId, model: modelId, thinkingDefault }
    ),
  setDispatchChannel: (channel: string) =>
    postJ<ActionResult>(`${API_BASE}/api/set-dispatch-channel`, { channel }),
  agentWake: (agentId: string) =>
    postJ<ActionResult>(`${API_BASE}/api/agent-wake`, { agentId }),
  taskAction: (taskId: string, action: string, reason: string) =>
    postJ<ActionResult>(`${API_BASE}/api/task-action`, { taskId, action, reason }),
  reviewAction: (taskId: string, action: string, comment: string) =>
    postJ<ActionResult>(`${API_BASE}/api/review-action`, { taskId, action, comment }),
  advanceState: (taskId: string, comment: string) =>
    postJ<ActionResult>(`${API_BASE}/api/advance-state`, { taskId, comment }),
  archiveTask: (taskId: string, archived: boolean) =>
    postJ<ActionResult>(`${API_BASE}/api/archive-task`, { taskId, archived }),
  deleteTask: (taskId: string) =>
    postJ<ActionResult & { taskId?: string }>(`${API_BASE}/api/delete-task`, { taskId }),
  archiveAllDone: () =>
    postJ<ActionResult & { count?: number }>(`${API_BASE}/api/archive-task`, { archiveAllDone: true }),
  schedulerScan: (thresholdSec = 180) =>
    postJ<ActionResult & { count?: number; actions?: ScanAction[]; checkedAt?: string }>(
      `${API_BASE}/api/scheduler-scan`,
      { thresholdSec }
    ),
  schedulerRetry: (taskId: string, reason: string) =>
    postJ<ActionResult>(`${API_BASE}/api/scheduler-retry`, { taskId, reason }),
  schedulerEscalate: (taskId: string, reason: string) =>
    postJ<ActionResult>(`${API_BASE}/api/scheduler-escalate`, { taskId, reason }),
  schedulerRollback: (taskId: string, reason: string) =>
    postJ<ActionResult>(`${API_BASE}/api/scheduler-rollback`, { taskId, reason }),
  refreshMorning: () =>
    postJ<ActionResult>(`${API_BASE}/api/morning-brief/refresh`, {}),
  saveMorningConfig: (config: SubConfig) =>
    postJ<ActionResult>(`${API_BASE}/api/morning-config`, config),
  addSkill: (agentId: string, skillName: string, description: string, trigger: string) =>
    postJ<ActionResult>(`${API_BASE}/api/add-skill`, { agentId, skillName, description, trigger }),

  // 远程 Skills 管理
  addRemoteSkill: (agentId: string, skillName: string, sourceUrl: string, description?: string) =>
    postJ<ActionResult & { skillName?: string; agentId?: string; source?: string; localPath?: string; size?: number; addedAt?: string }>(
      `${API_BASE}/api/add-remote-skill`, { agentId, skillName, sourceUrl, description: description || '' }
    ),
  remoteSkillsList: () =>
    fetchJ<RemoteSkillsListResult>(`${API_BASE}/api/remote-skills-list`),
  updateRemoteSkill: (agentId: string, skillName: string) =>
    postJ<ActionResult>(`${API_BASE}/api/update-remote-skill`, { agentId, skillName }),
  removeRemoteSkill: (agentId: string, skillName: string) =>
    postJ<ActionResult>(`${API_BASE}/api/remove-remote-skill`, { agentId, skillName }),

  createTask: (data: CreateTaskPayload) =>
    postJ<ActionResult & { taskId?: string }>(`${API_BASE}/api/create-task`, data),

  // ── 朝堂议政 ──
  courtDiscussStart: (topic: string, officials: string[], taskId?: string) =>
    postJ<CourtDiscussResult>(`${API_BASE}/api/court-discuss/start`, { topic, officials, taskId }),
  courtDiscussAdvance: (sessionId: string, userMessage?: string, decree?: string, attachmentIds: string[] = []) =>
    postJ<CourtDiscussResult>(`${API_BASE}/api/court-discuss/advance`, { sessionId, userMessage, decree, attachmentIds }),
  courtDiscussSessions: async () => (await fetchJ<{ sessions: Array<{ session_id: string; topic: string; phase: string }> }>(`${API_BASE}/api/court-discuss/list`)).sessions,
  courtDiscussSession: (id: string) => fetchJ<CourtDiscussResult>(`${API_BASE}/api/court-discuss/session/${encodeURIComponent(id)}`),
  courtDiscussConclude: (sessionId: string) =>
    postJ<ActionResult & { summary?: string }>(`${API_BASE}/api/court-discuss/conclude`, { sessionId }),
  courtDiscussDestroy: (sessionId: string) =>
    postJ<ActionResult>(`${API_BASE}/api/court-discuss/destroy`, { sessionId }),
  courtDiscussDelete: (sessionId: string) =>
    postJ<ActionResult & { session_id?: string }>(`${API_BASE}/api/court-discuss/delete`, { sessionId }),
  courtDiscussFate: () =>
    fetchJ<{ ok: boolean; event: string }>(`${API_BASE}/api/court-discuss/fate`),
};

// ── Types ──

export interface ActionResult {
  ok: boolean;
  message?: string;
  error?: string;
}

export interface FlowEntry {
  at: string;
  from: string;
  to: string;
  remark: string;
}

export interface TodoItem {
  id: string | number;
  title: string;
  status: 'not-started' | 'in-progress' | 'completed';
  detail?: string;
}

export interface Heartbeat {
  status: 'active' | 'warn' | 'stalled' | 'unknown' | 'idle';
  label: string;
}

export interface Task {
  id: string;
  title: string;
  state: string;
  org: string;
  now: string;
  eta: string;
  block: string;
  ac: string;
  output: string;
  heartbeat: Heartbeat;
  flow_log: FlowEntry[];
  todos: TodoItem[];
  review_round: number;
  archived: boolean;
  archivedAt?: string;
  updatedAt?: string;
  sourceMeta?: Record<string, unknown>;
  activity?: ActivityEntry[];
  _prev_state?: string;
}

export interface SyncStatus {
  ok: boolean;
  [key: string]: unknown;
}

export interface LiveStatus {
  tasks: Task[];
  syncStatus: SyncStatus;
}

export interface AgentInfo {
  id: string;
  label: string;
  emoji: string;
  role: string;
  model: string;
  skills: SkillInfo[];
}

export interface SkillInfo {
  name: string;
  description: string;
  path: string;
}

export interface KnownModel {
  id: string;
  label: string;
  provider: string;
}

export interface AgentConfig {
  agents: AgentInfo[];
  knownModels?: KnownModel[];
  dispatchChannel?: string;
}

export interface ChangeLogEntry {
  at: string;
  agentId: string;
  oldModel: string;
  newModel: string;
  rolledBack?: boolean;
}

export interface OfficialInfo {
  id: string;
  label: string;
  emoji: string;
  role: string;
  rank: string;
  model: string;
  model_short: string;
  tokens_in: number;
  tokens_out: number;
  cache_read: number;
  cache_write: number;
  cost_cny: number;
  cost_usd: number;
  sessions: number;
  messages: number;
  tasks_done: number;
  tasks_active: number;
  flow_participations: number;
  merit_score: number;
  merit_rank: number;
  last_active: string;
  heartbeat: Heartbeat;
  participated_edicts: { id: string; title: string; state: string }[];
}

export interface OfficialsData {
  officials: OfficialInfo[];
  totals: { tasks_done: number; cost_cny: number };
  top_official: string;
}

export interface AgentStatusInfo {
  id: string;
  label: string;
  emoji: string;
  role: string;
  status: 'running' | 'idle' | 'offline' | 'unconfigured';
  statusLabel: string;
  lastActive?: string;
}

export interface GatewayStatus {
  alive: boolean;
  probe: boolean;
  status: string;
}

export interface AgentsStatusData {
  ok: boolean;
  gateway: GatewayStatus;
  agents: AgentStatusInfo[];
  checkedAt: string;
}

export interface ReadinessCheck {
  id: string;
  label: string;
  ready: boolean;
  detail: string;
}

export interface ReadinessData {
  ok: boolean;
  ready: boolean;
  checks: ReadinessCheck[];
  next?: string;
  checkedAt?: string;
  error?: string;
}

export interface MorningNewsItem {
  title: string;
  summary?: string;
  desc?: string;
  link: string;
  source: string;
  image?: string;
  pub_date?: string;
}

export interface MorningBrief {
  date?: string;
  generated_at?: string;
  categories: Record<string, MorningNewsItem[]>;
}

export interface SubCategoryConfig {
  name: string;
  enabled: boolean;
}

export interface CustomFeed {
  name: string;
  url: string;
  category: string;
}

export interface SubConfig {
  categories: SubCategoryConfig[];
  keywords: string[];
  custom_feeds: CustomFeed[];
  feishu_webhook: string;
}

export interface ActivityEntry {
  kind: string;
  at?: number | string;
  text?: string;
  thinking?: string;
  agent?: string;
  from?: string;
  to?: string;
  remark?: string;
  tools?: { name: string; input_preview?: string }[];
  tool?: string;
  output?: string;
  exitCode?: number | null;
  items?: TodoItem[];
  diff?: {
    changed?: { id: string; from: string; to: string }[];
    added?: { id: string; title: string }[];
    removed?: { id: string; title: string }[];
  };
}

export interface PhaseDuration {
  phase: string;
  durationSec: number;
  durationText: string;
  ongoing?: boolean;
}

export interface TodosSummary {
  total: number;
  completed: number;
  inProgress: number;
  notStarted: number;
  percent: number;
}

export interface ResourceSummary {
  totalTokens?: number;
  totalCost?: number;
  totalElapsedSec?: number;
}

export interface TaskActivityData {
  ok: boolean;
  message?: string;
  error?: string;
  activity?: ActivityEntry[];
  relatedAgents?: string[];
  agentLabel?: string;
  lastActive?: string;
  phaseDurations?: PhaseDuration[];
  totalDuration?: string;
  todosSummary?: TodosSummary;
  resourceSummary?: ResourceSummary;
}

export interface SchedulerInfo {
  retryCount?: number;
  escalationLevel?: number;
  lastDispatchStatus?: string;
  stallThresholdSec?: number;
  enabled?: boolean;
  lastProgressAt?: string;
  lastDispatchAt?: string;
  lastDispatchAgent?: string;
  autoRollback?: boolean;
}

export interface SchedulerStateData {
  ok: boolean;
  error?: string;
  scheduler?: SchedulerInfo;
  stalledSec?: number;
}

export interface SkillContentResult {
  ok: boolean;
  name?: string;
  agent?: string;
  content?: string;
  path?: string;
  error?: string;
}

export interface ScanAction {
  taskId: string;
  action: string;
  to?: string;
  toState?: string;
  stalledSec?: number;
}

export interface CreateTaskPayload {
  title: string;
  org: string;
  targetDept?: string;
  priority?: string;
  templateId?: string;
  params?: Record<string, string>;
}

export interface RemoteSkillItem {
  skillName: string;
  agentId: string;
  sourceUrl: string;
  description: string;
  localPath: string;
  addedAt: string;
  lastUpdated: string;
  status: 'valid' | 'not-found' | string;
}

export interface RemoteSkillsListResult {
  ok: boolean;
  remoteSkills?: RemoteSkillItem[];
  count?: number;
  listedAt?: string;
  error?: string;
}

// ── 朝堂议政 ──

export interface CourtDiscussResult {
  ok: boolean;
  session_id?: string;
  topic?: string;
  round?: number;
  new_messages?: Array<{
    official_id: string;
    name: string;
    content: string;
    emotion?: string;
    action?: string;
  }>;
  scene_note?: string;
  total_messages?: number;
  error?: string;
  simulated?: boolean;
  messages?: Array<{ type: string; content: string; attachments?: ChatAttachment[]; official_id?: string; official_name?: string; timestamp?: number }>;
}

export interface YushufangOfficial {
  id: string;
  name: string;
  label?: string;
  emoji?: string;
  role?: string;
  duty?: string;
  model?: string;
}

export interface YushufangMessage {
  id?: string;
  type: 'system' | 'emperor' | 'official' | 'progress' | 'error' | 'scene' | 'approval' | string;
  content: string;
  attachments?: ChatAttachment[];
  officialId?: string;
  officialName?: string;
  runId?: string;
  status?: string;
  createdAt?: string;
  proposedActions?: Array<{ id: string; title: string; detail?: string; requiresApproval?: boolean }>;
}

export interface YushufangRoom {
  roomId: string;
  audience?: 'prince' | 'ministers';
  topic: string;
  phase: 'idle' | 'running' | 'waiting' | 'concluded' | 'cancelled' | 'interrupted' | 'archived' | string;
  sessionMode?: 'shared' | 'isolated' | string;
  sharedMemory?: boolean;
  participants: YushufangOfficial[];
  messages: YushufangMessage[];
  agentContexts?: Record<string, YushufangAgentContext>;
  progressRequests?: YushufangProgressRequest[];
  queue?: string[];
  failedAgentIds?: string[];
  pendingMessages?: Array<{ id: string; content: string; attachments?: ChatAttachment[] }>;
  toolActivity?: Array<{ agentId: string; tool: string; state: string; at: string }>;
  capabilities?: Record<string, {
    model: string;
    skills: string[];
    mcpServers: string[];
    webSearch: boolean;
    webFetch: boolean;
    resolvedModel?: string;
    requestedThinking?: string;
    effectiveThinking?: string;
  }>;
  currentAgentId?: string | null;
  thinkingDefault?: string;
  proposedActions?: Array<{
    id: string;
    title: string;
    detail?: string;
    requiresApproval?: boolean;
    approved?: boolean;
    status?: 'pending_approval' | 'approved' | 'rejected' | string;
    executionState?: string;
    taskId?: string;
    decidedAt?: string;
  }>;
  createdAt?: string;
  updatedAt?: string;
}

export interface YushufangAgentContext {
  agentId: string;
  status: 'working' | 'idle' | string;
  busy: boolean;
  lastActiveAt?: string | null;
  ageMs?: number | null;
  progress: string;
  lastUserRequest?: string;
  sourceTaskId?: string | null;
  source?: string;
  sessionKey?: string;
  memoryScope?: string;
}

export interface YushufangProgressRequest {
  id: string;
  agentId: string;
  question: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'interrupted' | string;
  mode: 'read-only' | string;
  sessionKey?: string;
  snapshot?: YushufangAgentContext;
  response?: string;
  error?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface YushufangResult {
  ok: boolean;
  room?: YushufangRoom;
  rooms?: YushufangRoom[];
  officials?: YushufangOfficial[];
  agents?: YushufangOfficial[];
  queued?: boolean;
  duplicate?: boolean;
  requestId?: string;
  request?: YushufangProgressRequest;
  message?: string;
  error?: string;
}

export const yushufangApi = {
  runtime: () => fetchJ<{ ok: boolean; errors: string[] }>(`${API_BASE}/api/yushufang/runtime`),
  officials: () => fetchJ<YushufangResult>(`${API_BASE}/api/yushufang/officials`),
  rooms: () => fetchJ<YushufangResult>(`${API_BASE}/api/yushufang/rooms`),
  open: (topic: string, officials: string[], thinkingDefault?: string, audience: 'prince' | 'ministers' = 'ministers') =>
    postJ<YushufangResult>(`${API_BASE}/api/yushufang/open`, { topic, officials, thinkingDefault, audience }),
  invite: (roomId: string, officials: string[], joinPrince = false) =>
    postJ<YushufangResult>(`${API_BASE}/api/yushufang/invite`, { roomId, officials, joinPrince }),
  removeQueued: (roomId: string, messageId: string) =>
    postJ<YushufangResult>(`${API_BASE}/api/yushufang/remove-queued`, { roomId, messageId }),
  speak: (roomId: string, message: string, attachmentIds: string[] = [], thinkingDefault?: string) =>
    postJ<YushufangResult>(`${API_BASE}/api/yushufang/speak`, { roomId, message, attachmentIds, thinkingDefault }),
  askProgress: (roomId: string, agentId: string, question?: string) =>
    postJ<YushufangResult>(`${API_BASE}/api/yushufang/ask-progress`, { roomId, agentId, question }),
  removeParticipant: (roomId: string, agentId: string) =>
    postJ<YushufangResult>(`${API_BASE}/api/yushufang/remove-participant`, { roomId, agentId }),
  cancel: (roomId: string) => postJ<YushufangResult>(`${API_BASE}/api/yushufang/cancel`, { roomId }),
  disband: (roomId: string) => postJ<YushufangResult>(`${API_BASE}/api/yushufang/disband`, { roomId }),
  resume: (roomId: string, thinkingDefault?: string) => postJ<YushufangResult>(`${API_BASE}/api/yushufang/resume`, { roomId, thinkingDefault }),
  conclude: (roomId: string) => postJ<YushufangResult>(`${API_BASE}/api/yushufang/conclude`, { roomId }),
  approve: (roomId: string, actionId: string, approved: boolean) =>
    postJ<YushufangResult>(`${API_BASE}/api/yushufang/approve`, { roomId, actionId, approved }),
  execute: (roomId: string, actionId: string) =>
    postJ<YushufangResult>(`${API_BASE}/api/yushufang/execute-approved`, { roomId, actionId, confirmed: true }),
  archive: (roomId: string) => postJ<YushufangResult>(`${API_BASE}/api/yushufang/archive`, { roomId }),
  delete: (roomId: string) => postJ<YushufangResult>(`${API_BASE}/api/yushufang/delete`, { roomId }),
};

export interface ChatAttachment {
  id: string;
  name: string;
  size: number;
  mime: string;
  kind: 'text' | 'image';
  warning?: string;
}

export const attachmentApi = {
  url: (scope: string, id: string) => `${API_BASE}/api/chat-attachments?${new URLSearchParams({ scope, id })}`,
  remove: (scope: string, id: string) => postJ<ActionResult>(`${API_BASE}/api/chat-attachments/remove`, { scope, id }),
  upload: (scope: string, file: File, onProgress: (progress: number) => void, signal: AbortSignal) =>
    new Promise<ChatAttachment>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      const abort = () => xhr.abort();
      xhr.open('POST', `${API_BASE}/api/chat-attachments?${new URLSearchParams({ scope, name: file.name })}`);
      xhr.setRequestHeader('Content-Type', 'application/octet-stream');
      xhr.timeout = 120000;
      xhr.upload.onprogress = (event) => { if (event.lengthComputable) onProgress(Math.round(event.loaded / event.total * 100)); };
      xhr.onload = () => {
        try {
          const result = JSON.parse(xhr.responseText);
          if (xhr.status >= 400 || !result.ok) throw new Error(result.error || '上传失败');
          resolve(result.attachment);
        } catch (error) { reject(error); }
      };
      xhr.onerror = () => reject(new Error('上传连接中断，请重试'));
      xhr.ontimeout = () => reject(new Error('上传超时，请重试'));
      xhr.onabort = () => reject(new Error('上传已取消'));
      xhr.onloadend = () => signal.removeEventListener('abort', abort);
      if (signal.aborted) { reject(new Error('上传已取消')); return; }
      signal.addEventListener('abort', abort, { once: true });
      xhr.send(file);
    }),
};
