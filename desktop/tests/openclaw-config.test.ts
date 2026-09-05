import { describe, expect, it } from 'vitest'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  OpenClawConfigStore,
  resolveOpenClawConfigPath,
  type CommandResult,
} from '../main/openclaw-config.js'

async function tempConfig(value: unknown): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'edict-openclaw-config-'))
  const path = join(directory, 'openclaw.json')
  await writeFile(path, `${JSON.stringify(value)}\n`)
  return path
}

function successfulRunner(calls: Array<{ args: string[]; input?: string }>) {
  return async (args: string[], input?: string): Promise<CommandResult> => {
    calls.push({ args, input })
    return { code: 0, stdout: '{"ok":true}', stderr: '' }
  }
}

describe('OpenClawConfigStore', () => {
  it('probes MCP using native discovery and returns only non-secret capability fields', async () => {
    const calls: string[][] = []
    const store = new OpenClawConfigStore({
      commandRunner: async (args) => {
        calls.push(args)
        return { code: 0, stderr: '', stdout: JSON.stringify({ servers: { docs: { tools: 3, resources: true } }, diagnostics: [{ message: 'secret-not-for-renderer' }] }) }
      },
    })
    const result = await store.probeMcp('docs')
    expect(calls).toEqual([['mcp', 'probe', 'docs', '--json']])
    expect(result).toMatchObject({ connected: true, tools: 3, resources: true, prompts: false })
    expect(JSON.stringify(result)).not.toContain('secret-not-for-renderer')
  })
  it('summarizes registered agents and MCP servers without exposing secret values', async () => {
    const path = await tempConfig({
      agents: {
        defaults: {
          model: { primary: 'provider/default', fallbacks: ['provider/fallback'] },
          thinkingDefault: 'medium',
        },
        list: [
          {
            id: 'shangshu',
            workspace: '/tmp/shangshu',
            model: 'provider/shangshu',
            thinkingDefault: 'high',
            skills: ['dispatch'],
            subagents: { allowAgents: ['gongbu'] },
            tools: { profile: 'coding', allow: ['read'], deny: ['browser'] },
            sandbox: { mode: 'non-main', workspaceAccess: 'ro', scope: 'agent' },
          },
        ],
      },
      tools: { web: { search: { enabled: false }, fetch: { enabled: true } } },
      mcp: {
        servers: {
          local: {
            enabled: false,
            command: 'npx',
            args: ['-y', 'example-mcp'],
            env: { API_TOKEN: 'must-not-leak' },
            toolFilter: { include: ['search_*'] },
            codex: { agents: ['shangshu'], defaultToolsApprovalMode: 'prompt' },
          },
          remote: {
            transport: 'streamable-http',
            url: 'https://example.test/mcp',
            headers: { Authorization: 'Bearer must-not-leak' },
          },
        },
      },
    })
    const store = new OpenClawConfigStore({ configPath: path })

    const snapshot = await store.snapshot()
    expect(snapshot.defaultModel).toBe('provider/default')
    expect(snapshot.defaultFallbacks).toEqual(['provider/fallback'])
    expect(snapshot.defaultThinking).toBe('medium')
    expect(snapshot.agents).toEqual([
      expect.objectContaining({
        id: 'shangshu',
        model: 'provider/shangshu',
        thinkingDefault: 'high',
        skills: ['dispatch'],
        allowAgents: ['gongbu'],
        tools: expect.objectContaining({ profile: 'coding', allow: ['read'], deny: ['browser'] }),
        sandbox: expect.objectContaining({ mode: 'non-main', workspaceAccess: 'ro', scope: 'agent' }),
      }),
    ])
    expect(snapshot.mcpServers).toEqual([
      expect.objectContaining({
        name: 'local',
        enabled: false,
        command: 'npx',
        hasEnvironment: true,
        environmentKeys: ['API_TOKEN'],
        codexAgents: ['shangshu'],
      }),
      expect.objectContaining({
        name: 'remote',
        transport: 'streamable-http',
        hasHeaders: true,
        headerNames: ['Authorization'],
      }),
    ])
    expect(JSON.stringify(snapshot)).not.toContain('must-not-leak')
    expect(snapshot.network.search).toMatchObject({ configured: true, enabled: false })
    expect(snapshot.network.fetch).toMatchObject({ configured: true, enabled: true })
  })

  it('writes agent, global, and MCP changes through the validated OpenClaw CLI', async () => {
    const path = await tempConfig({
      agents: {
        defaults: { model: 'provider/default' },
        list: [{ id: 'shangshu', model: 'provider/old', subagents: { allowAgents: ['gongbu'] } }],
      },
    })
    const calls: Array<{ args: string[]; input?: string }> = []
    const store = new OpenClawConfigStore({ configPath: path, commandRunner: successfulRunner(calls) })

    await store.applyAgentPatch('shangshu', {
      model: 'provider/new',
      fallbacks: ['provider/fallback'],
      thinkingDefault: 'low',
      skills: ['dispatch', 'review'],
      allowAgents: ['menxia'],
      tools: { profile: 'coding', allow: ['read'], deny: ['browser'] },
      sandbox: { mode: 'non-main', workspaceAccess: 'ro', scope: 'agent' },
    })
    await store.applyGlobalPatch({
      defaultModel: 'provider/default-new',
      defaultThinking: 'medium',
      defaultToolProfile: 'minimal',
      webSearchEnabled: false,
      webFetchEnabled: true,
    })
    await store.upsertMcpServer('fetcher', {
      transport: 'streamable-http',
      url: 'https://example.test/mcp',
      enabled: true,
      toolFilter: { include: ['fetch_*'] },
    })
    await store.removeMcpServer('fetcher')

    expect(calls).toHaveLength(4)
    expect(calls.every((call) => call.args.join(' ') === 'config patch --stdin')).toBe(true)
    expect(calls[0].input).toContain('provider/new')
    expect(calls[0].input).toContain('thinkingDefault')
    expect(calls[0].input).toContain('allowAgents')
    expect(calls[1].input).toContain('tools')
    expect(calls[1].input).toContain('"search":{"enabled":false}')
    expect(calls[2].input).toContain('fetcher')
    expect(calls[3].input).toContain('"fetcher":null')
    expect(calls.map((call) => call.input).join('')).not.toContain('apiKey')
  })

  it('rejects invalid agent and MCP inputs before invoking OpenClaw', async () => {
    const path = await tempConfig({ agents: { list: [{ id: 'shangshu' }] } })
    const calls: Array<{ args: string[]; input?: string }> = []
    const store = new OpenClawConfigStore({ configPath: path, commandRunner: successfulRunner(calls) })

    await expect(store.applyAgentPatch('../shangshu', { model: 'provider/x' })).rejects.toThrow(/unsupported/i)
    await expect(store.applyAgentPatch('missing', { model: 'provider/x' })).rejects.toThrow(/不存在/)
    await expect(store.upsertMcpServer('bad name', { command: 'npx', transport: 'stdio' })).rejects.toThrow(/unsupported/i)
    await expect(store.upsertMcpServer('remote', { transport: 'sse' })).rejects.toThrow(/requires url/i)
    await expect(store.upsertMcpServer('remote', {
      transport: 'streamable-http',
      url: 'https://example.test/mcp',
      headers: { Authorization: 'Bearer inline-secret' },
    })).rejects.toThrow(/inline secrets/i)
    await expect(store.upsertMcpServer('remote', {
      transport: 'streamable-http',
      url: 'https://example.test/mcp',
      headers: { Authorization: 'Bearer ${MCP_REMOTE_TOKEN}' },
    })).resolves.toMatchObject({ code: 0 })
    expect(calls).toHaveLength(1)
  })

  it('resolves the configured OpenClaw path without reading credentials', () => {
    expect(resolveOpenClawConfigPath({ OPENCLAW_HOME: '/tmp/openclaw-test' })).toBe('/tmp/openclaw-test/openclaw.json')
    expect(resolveOpenClawConfigPath({ OPENCLAW_CONFIG_PATH: '/tmp/custom.json' })).toBe('/tmp/custom.json')
  })
})
