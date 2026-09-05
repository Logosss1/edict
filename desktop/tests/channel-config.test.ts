import { describe, expect, it } from 'vitest'

import {
  applyChannelAccountConfig,
  channelSecretEnvVar,
  channelSecretRef,
  makeChannelSecretRef,
  normalizeChannelAccountDraft,
  normalizeChannelAccountId,
  removeChannelAccountConfig,
  validateRequiredChannelFields,
} from '../main/integration/channel-config.js'
import type { OpenClawConfig } from '../main/integration/openclaw-config.js'

describe('OpenClaw desktop channel configuration', () => {
  it('normalizes account ids and creates stable environment-backed secret refs', () => {
    expect(normalizeChannelAccountId(' Team_Bot ')).toBe('team_bot')
  })

  it('rejects account ids that cannot be represented safely', () => {
    expect(() => normalizeChannelAccountId('bad/account')).toThrow('账号标识')
    expect(() => normalizeChannelAccountDraft({ channel: 'unknown' })).toThrow('不支持')
  })

  it('writes Feishu credentials as secret refs and enables its plugin without plaintext', () => {
    const appSecret = makeChannelSecretRef('feishu', 'default', 'appSecret')
    const next = applyChannelAccountConfig(
      { agents: { list: [] } } as OpenClawConfig,
      { channel: 'feishu', accountId: 'default', appId: 'cli_fixture', domain: 'feishu' },
      { appSecret },
    )

    const channels = next.channels as Record<string, Record<string, unknown>>
    const plugins = next.plugins as Record<string, Record<string, Record<string, unknown>>>
    expect(channels.feishu).toMatchObject({
      enabled: true,
      appId: 'cli_fixture',
      appSecret,
      connectionMode: 'websocket',
    })
    expect(plugins.entries.feishu).toMatchObject({ enabled: true })
    expect(JSON.stringify(next)).not.toContain('fixture-secret')
    expect(channelSecretEnvVar('feishu', 'default', 'appSecret')).toBe('EDICT_CHANNEL_FEISHU_DEFAULT_APP_SECRET')
    expect(channelSecretRef('feishu', 'default', 'appSecret')).toBe('channel/feishu/default/appSecret')
  })

  it('keeps named accounts independent and removes only the requested account', () => {
    const base = applyChannelAccountConfig(
      {} as OpenClawConfig,
      { channel: 'telegram', accountId: 'first' },
      { botToken: makeChannelSecretRef('telegram', 'first', 'botToken') },
    )
    const withSecond = applyChannelAccountConfig(
      base,
      { channel: 'telegram', accountId: 'second' },
      { botToken: makeChannelSecretRef('telegram', 'second', 'botToken') },
    )
    const removed = removeChannelAccountConfig(withSecond, 'telegram', 'first')

    const removedChannels = removed.channels as Record<string, Record<string, unknown>>
    const accounts = (removedChannels.telegram.accounts || {}) as Record<string, unknown>
    expect(accounts).not.toHaveProperty('first')
    expect(accounts).toHaveProperty('second')
  })

  it('moves the channel default when the selected named account is removed', () => {
    const first = applyChannelAccountConfig(
      {} as OpenClawConfig,
      { channel: 'telegram', accountId: 'first' },
      { botToken: makeChannelSecretRef('telegram', 'first', 'botToken') },
    )
    const second = applyChannelAccountConfig(
      first,
      { channel: 'telegram', accountId: 'second' },
      { botToken: makeChannelSecretRef('telegram', 'second', 'botToken') },
    )
    const removed = removeChannelAccountConfig(second, 'telegram', 'second')

    const section = (removed.channels as Record<string, Record<string, unknown>>).telegram
    expect(section.defaultAccount).toBe('first')
    expect(section.accounts).toEqual({ first: expect.any(Object) })
  })

  it('requires credentials unless a new value or an encrypted value is available', () => {
    const draft = { channel: 'telegram' as const, accountId: 'default' }
    expect(() => validateRequiredChannelFields(draft, {}, {})).toThrow('Bot Token')
    expect(() => validateRequiredChannelFields(draft, {}, { botToken: true })).not.toThrow()
  })
})
