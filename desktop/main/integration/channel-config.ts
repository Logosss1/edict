import type { OpenClawConfig, OpenClawSecretRef } from './openclaw-config.js'

export const DESKTOP_CHANNELS = [
  {
    id: 'feishu',
    label: '飞书 Feishu',
    npmSpec: '@openclaw/feishu',
    requiredFields: ['appId', 'appSecret'],
    secretFields: ['appSecret'],
    help: '需要飞书开放平台的企业自建应用 App ID 和 App Secret。默认使用 WebSocket 长连接。',
  },
  {
    id: 'telegram',
    label: 'Telegram',
    npmSpec: '@openclaw/telegram',
    requiredFields: ['botToken'],
    secretFields: ['botToken'],
    help: '需要从 BotFather 获取 Bot Token。首次私聊机器人时，OpenClaw 会按默认配对策略等待授权。',
  },
  {
    id: 'discord',
    label: 'Discord',
    npmSpec: '@openclaw/discord',
    requiredFields: ['token'],
    secretFields: ['token'],
    help: '需要 Discord Bot Token；Application ID 可选，用于补充机器人身份信息。',
  },
  {
    id: 'slack',
    label: 'Slack',
    npmSpec: '@openclaw/slack',
    requiredFields: ['botToken', 'appToken'],
    secretFields: ['botToken', 'appToken', 'signingSecret'],
    help: 'Socket Mode 需要 Slack Bot Token（xoxb-）和 App Token（xapp-）。',
  },
  {
    id: 'signal',
    label: 'Signal',
    npmSpec: '@openclaw/signal',
    requiredFields: ['account'],
    secretFields: [],
    help: '需要本机或局域网中可访问的 signal-cli REST 服务；应用负责保存连接参数，手机号注册仍需在 Signal 侧完成。',
  },
] as const

export type DesktopChannelId = (typeof DESKTOP_CHANNELS)[number]['id']
export type ChannelSecretField = (typeof DESKTOP_CHANNELS)[number]['secretFields'][number]

export interface ChannelAccountDraft {
  channel: DesktopChannelId
  accountId?: string
  name?: string
  appId?: string
  appSecret?: string
  domain?: 'feishu' | 'lark'
  botToken?: string
  applicationId?: string
  appToken?: string
  signingSecret?: string
  account?: string
  httpUrl?: string
  httpHost?: string
  httpPort?: number
}

const ACCOUNT_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/
const CHANNEL_ID_SET = new Set<string>(DESKTOP_CHANNELS.map((channel) => channel.id))

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {}
}

function normalizeOptionalText(value: unknown, maxLength = 2_000): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new Error('渠道配置字段必须是文本')
  const normalized = value.trim()
  if (!normalized) return undefined
  if (normalized.length > maxLength) throw new Error('渠道配置字段过长')
  return normalized
}

export function normalizeChannelId(value: unknown): DesktopChannelId {
  if (typeof value !== 'string' || !CHANNEL_ID_SET.has(value.trim().toLowerCase())) {
    throw new Error('暂不支持此 OpenClaw 派发渠道')
  }
  return value.trim().toLowerCase() as DesktopChannelId
}

export function normalizeChannelAccountId(value: unknown): string {
  const accountId = typeof value === 'string' && value.trim() ? value.trim().toLowerCase() : 'default'
  if (!ACCOUNT_ID_PATTERN.test(accountId)) throw new Error('账号标识只能包含字母、数字、点、下划线和短横线')
  return accountId
}

export function normalizeChannelAccountDraft(value: unknown): ChannelAccountDraft {
  if (!isRecord(value)) throw new Error('渠道配置格式无效')
  const channel = normalizeChannelId(value.channel)
  const draft: ChannelAccountDraft = {
    channel,
    accountId: normalizeChannelAccountId(value.accountId),
    ...(normalizeOptionalText(value.name, 80) ? { name: normalizeOptionalText(value.name, 80) } : {}),
  }

  for (const field of ['appId', 'appSecret', 'botToken', 'applicationId', 'appToken', 'signingSecret', 'account', 'httpUrl', 'httpHost'] as const) {
    const text = normalizeOptionalText(value[field])
    if (text) draft[field] = text
  }
  if (value.domain !== undefined) {
    if (value.domain !== 'feishu' && value.domain !== 'lark') throw new Error('飞书域名只能选择 Feishu 或 Lark')
    draft.domain = value.domain
  }
  if (value.httpPort !== undefined && value.httpPort !== null && value.httpPort !== '') {
    const port = Number(value.httpPort)
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Signal HTTP 端口无效')
    draft.httpPort = port
  }
  return draft
}

export function getChannelSpec(channel: DesktopChannelId) {
  return DESKTOP_CHANNELS.find((entry) => entry.id === channel) ?? DESKTOP_CHANNELS[0]
}

export function channelSecretRef(channel: DesktopChannelId, accountId: string, field: string): string {
  return `channel/${channel}/${normalizeChannelAccountId(accountId)}/${field}`
}

export function channelSecretEnvVar(channel: DesktopChannelId, accountId: string, field: string): string {
  const readableField = field.replace(/([a-z])([A-Z])/g, '$1_$2')
  return `EDICT_CHANNEL_${channel}_${normalizeChannelAccountId(accountId)}_${readableField}`.replace(/[^A-Za-z0-9]+/g, '_').toUpperCase()
}

export function makeChannelSecretRef(channel: DesktopChannelId, accountId: string, field: string): OpenClawSecretRef {
  return {
    source: 'env',
    provider: 'default',
    id: channelSecretEnvVar(channel, accountId, field),
  }
}

export function getChannelSection(config: OpenClawConfig, channel: DesktopChannelId): Record<string, unknown> {
  return asRecord(asRecord(config.channels)[channel])
}

/** Resolve account-level fields while retaining OpenClaw's top-level inheritance. */
export function getChannelAccountConfig(
  config: OpenClawConfig,
  channel: DesktopChannelId,
  accountId: string,
): Record<string, unknown> {
  const section = getChannelSection(config, channel)
  if (accountId === 'default') return section
  return {
    ...section,
    ...asRecord(asRecord(section.accounts)[accountId]),
  }
}

function setAccountSection(
  config: OpenClawConfig,
  channel: DesktopChannelId,
  accountId: string,
  accountPatch: Record<string, unknown>,
): OpenClawConfig {
  const next = structuredClone(config) as OpenClawConfig
  const channels = { ...asRecord(next.channels) }
  const section = getChannelSection(next, channel)
  if (accountId === 'default') {
    channels[channel] = { ...section, ...accountPatch, enabled: true }
  } else {
    const accounts = { ...asRecord(section.accounts) }
    accounts[accountId] = { ...asRecord(accounts[accountId]), ...accountPatch, enabled: true }
    channels[channel] = { ...section, accounts, defaultAccount: accountId, enabled: true }
  }
  next.channels = channels
  return next
}

export interface ChannelSecretRefs {
  [field: string]: OpenClawSecretRef
}

/** Build a config mutation without ever placing secret values in OpenClaw JSON. */
export function applyChannelAccountConfig(
  config: OpenClawConfig,
  draft: ChannelAccountDraft,
  secretRefs: ChannelSecretRefs,
): OpenClawConfig {
  const channel = normalizeChannelId(draft.channel)
  const accountId = normalizeChannelAccountId(draft.accountId)
  const section = getChannelSection(config, channel)
  const current = accountId === 'default' ? section : asRecord(asRecord(section.accounts)[accountId])
  const patch: Record<string, unknown> = {}

  if (draft.name) patch.name = draft.name
  if (channel === 'feishu') {
    if (draft.appId) patch.appId = draft.appId
    if (draft.domain) patch.domain = draft.domain
    patch.connectionMode = 'websocket'
    if (secretRefs.appSecret) patch.appSecret = secretRefs.appSecret
  } else if (channel === 'telegram') {
    if (secretRefs.botToken) patch.botToken = secretRefs.botToken
  } else if (channel === 'discord') {
    if (draft.applicationId) patch.applicationId = draft.applicationId
    if (secretRefs.token) patch.token = secretRefs.token
  } else if (channel === 'slack') {
    patch.mode = 'socket'
    if (secretRefs.botToken) patch.botToken = secretRefs.botToken
    if (secretRefs.appToken) patch.appToken = secretRefs.appToken
    if (secretRefs.signingSecret) patch.signingSecret = secretRefs.signingSecret
  } else if (channel === 'signal') {
    if (draft.account) patch.account = draft.account
    if (draft.httpUrl) patch.httpUrl = draft.httpUrl
    if (draft.httpHost) patch.httpHost = draft.httpHost
    if (draft.httpPort) patch.httpPort = draft.httpPort
  }

  // Keep existing non-sensitive channel settings, but ensure a stale inline
  // secret is never copied into a new desktop-managed account.
  for (const field of getChannelSpec(channel).secretFields) {
    const configField = channel === 'discord' && field === 'token' ? 'token' : field
    if (!(configField in patch) && current[configField] !== undefined) {
      const existing = current[configField]
      if (isRecord(existing) && existing.source === 'env') patch[configField] = existing
    }
  }

  const next = setAccountSection(config, channel, accountId, patch)
  const plugins = { ...asRecord(next.plugins) }
  const entries = { ...asRecord(plugins.entries) }
  entries[channel] = { ...asRecord(entries[channel]), enabled: true }
  next.plugins = { ...plugins, entries }
  return next
}

export function removeChannelAccountConfig(
  config: OpenClawConfig,
  channel: DesktopChannelId,
  accountId: string,
): OpenClawConfig {
  const normalizedChannel = normalizeChannelId(channel)
  const normalizedAccount = normalizeChannelAccountId(accountId)
  const next = structuredClone(config) as OpenClawConfig
  const channels = { ...asRecord(next.channels) }
  const section = getChannelSection(next, normalizedChannel)
  if (normalizedAccount === 'default') {
    const accounts = asRecord(section.accounts)
    if (Object.keys(accounts).length > 0) {
      const cleaned = { ...section }
      for (const field of getChannelSpec(normalizedChannel).secretFields) delete cleaned[field]
      delete cleaned.appId
      delete cleaned.applicationId
      delete cleaned.account
      delete cleaned.enabled
      channels[normalizedChannel] = cleaned
    } else {
      delete channels[normalizedChannel]
    }
  } else {
    const accounts = { ...asRecord(section.accounts) }
    delete accounts[normalizedAccount]
    if (Object.keys(accounts).length > 0) {
      const nextSection: Record<string, unknown> = { ...section, accounts }
      if (nextSection.defaultAccount === normalizedAccount) {
        nextSection.defaultAccount = Object.keys(accounts).sort()[0]
      }
      channels[normalizedChannel] = nextSection
    } else delete channels[normalizedChannel]
  }
  next.channels = channels
  return next
}

export function secretInput(config: Record<string, unknown>, field: string): unknown {
  return config[field]
}

export function secretRefId(value: unknown): string | undefined {
  if (!isRecord(value) || value.source !== 'env' || value.provider !== 'default' || typeof value.id !== 'string') return undefined
  return value.id
}

export function validateRequiredChannelFields(
  draft: ChannelAccountDraft,
  accountConfig: Record<string, unknown>,
  storedSecrets: Record<string, boolean>,
): void {
  const spec = getChannelSpec(draft.channel)
  for (const field of spec.requiredFields) {
    const draftValue = field === 'token' ? draft.botToken : draft[field as keyof ChannelAccountDraft]
    const existingValue = accountConfig[field]
    const hasSecret = spec.secretFields.includes(field as never)
      ? Boolean(storedSecrets[field] || (typeof existingValue === 'string' && existingValue.trim()))
      : Boolean(draftValue || (typeof existingValue === 'string' && existingValue.trim()))
    if (!hasSecret) throw new Error(`${spec.label} 缺少必填项：${field === 'appId' ? 'App ID' : field === 'appSecret' ? 'App Secret' : field === 'botToken' ? 'Bot Token' : field === 'token' ? 'Bot Token' : field === 'appToken' ? 'App Token' : field}`)
  }
}
