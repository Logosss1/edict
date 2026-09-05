import { beforeAll, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  buildProviderConfig,
  configureModelCatalog,
  buildProviderEnvironment,
  EDICT_PROVIDER_USER_AGENT,
  mergeAgentModelBindings,
  normalizeOpenAIBaseUrl,
  modelReference,
  readAgentsManifest,
  readOpenClawConfig,
  repairModelCapabilities,
  syncProviderToOpenClaw,
} from '../main/integration/openclaw-config.js'

beforeAll(async () => {
  configureModelCatalog(JSON.parse(await readFile(join(process.cwd(), '..', 'upstream', 'scripts', 'model_capabilities.json'), 'utf8')).models)
})

describe('EDICT/OpenClaw integration', () => {
  it('normalizes host-only OpenAI-compatible URLs and preserves explicit paths', () => {
    expect(normalizeOpenAIBaseUrl('https://api.example.com')).toBe('https://api.example.com/v1')
    expect(normalizeOpenAIBaseUrl('https://api.example.com/')).toBe('https://api.example.com/v1')
    expect(normalizeOpenAIBaseUrl('https://api.example.com/v1/')).toBe('https://api.example.com/v1')
    expect(normalizeOpenAIBaseUrl('https://gateway.example/api/v1')).toBe('https://gateway.example/api/v1')
  })

  it('writes the normalized API root into OpenClaw provider config', () => {
    expect(buildProviderConfig({ id: 'fixture', baseUrl: 'https://api.example.com', models: ['model-a'] })).toMatchObject({
      baseUrl: 'https://api.example.com/v1',
    })
  })

  it('uses the shared GPT-5.6 catalog and preserves provider restrictions', () => {
    const provider = buildProviderConfig({
      id: 'fixture', baseUrl: 'http://localhost/v1',
      models: ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt5.6'],
    })
    for (const model of provider.models.slice(0, 3)) {
      expect(model.compat?.supportedReasoningEfforts).toContain('max')
      expect(model.compat?.supportedReasoningEfforts).not.toContain('ultra')
      expect(model.compat?.reasoningEffortMap).toEqual({ minimal: 'none' })
    }
    expect(provider.models[3].compat).toBeUndefined()
    const restricted = buildProviderConfig({
      id: 'fixture', baseUrl: 'http://localhost/v1',
      models: [{ id: 'gpt-5.6-sol', reasoning: true, supportedReasoningEfforts: ['low'] }],
    }, provider)
    expect(restricted.models[0].compat?.supportedReasoningEfforts).toEqual(['low'])
  })
  it('does not reserve minimal when a provider declares minimal as a real effort', () => {
    const provider = buildProviderConfig({
      id: 'fixture', baseUrl: 'http://localhost/v1',
      models: [{ id: 'gpt-5.6-sol', supportedReasoningEfforts: ['none', 'minimal', 'high'] }],
    })
    expect(provider.models[0].compat?.reasoningEffortMap).toBeUndefined()
    provider.models[0].compat = { ...provider.models[0].compat, reasoningEffortMap: { minimal: 'low' } }
    const saved = buildProviderConfig({ id: 'fixture', baseUrl: 'http://localhost/v1', models: ['gpt-5.6-sol'] }, provider)
    expect(saved.models[0].compat?.reasoningEffortMap).toEqual({ minimal: 'low' })
  })
  it('declares GPT-5.5 reasoning on ordinary provider save without guessing unknown aliases', () => {
    const provider = buildProviderConfig({ id: 'custom', baseUrl: 'http://localhost/v1', models: ['gpt-5.5', 'model', 'gpt-5.5-pro'] })
    expect(provider.models[0]).toMatchObject({
      reasoning: true, compat: { supportsReasoningEffort: true, supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh'] },
      thinkingLevelMap: { xhigh: 'xhigh' }, input: ['text', 'image'],
    })
    expect(provider.models[1].reasoning).toBeUndefined()
    expect(provider.models[1].input).toBeUndefined()
    expect(provider.models[2].reasoning).toBeUndefined()
  })

  it('retains existing capabilities, explicit restrictions and unrelated model metadata when saving again', () => {
    const existing = buildProviderConfig({ id: 'custom', baseUrl: 'http://localhost/v1', models: ['gpt-5.5', 'other'] })
    existing.models[0] = { ...existing.models[0], input: ['text'], reasoning: false, compat: { supportsReasoningEffort: false }, maxTokens: 2000 }
    existing.models[1] = { ...existing.models[1], reasoning: true, compat: { supportedReasoningEfforts: ['medium'], reasoningEffortMap: { high: 'medium' } } }
    const result = buildProviderConfig({ id: 'custom', baseUrl: 'http://localhost/v1', models: ['gpt-5.5', 'other'] }, existing)
    expect(result.models).toEqual(existing.models)
  })

  it('repairs old metadata once without changing secrets, bindings, or explicit capabilities', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'edict-model-repair-'))
    const path = join(directory, 'openclaw.json')
    const original = {
      agents: { list: [{ id: 'taizi', model: 'custom/gpt-5.5' }] },
      models: { providers: { custom: {
        baseUrl: 'http://localhost/v1',
        apiKey: { source: 'env', provider: 'default', id: 'FIXTURE_KEY' },
        models: [{ id: 'gpt-5.5', name: 'GPT-5.5' }, { id: 'other', name: 'Other', reasoning: false }],
      } } },
    }
    await writeFile(path, JSON.stringify(original))
    expect(await repairModelCapabilities(path)).toBe(true)
    const repaired = await readOpenClawConfig(path)
    expect(repaired.agents).toEqual(original.agents)
    expect(repaired.models?.providers?.custom.apiKey).toEqual(original.models.providers.custom.apiKey)
    expect(repaired.models?.providers?.custom.models[0].reasoning).toBe(true)
    expect(repaired.models?.providers?.custom.models[0].input).toEqual(['text', 'image'])
    expect(await repairModelCapabilities(path)).toBe(false)
  })

  it('repairs a host-only OpenAI provider URL during startup migration', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'edict-url-repair-'))
    const path = join(directory, 'openclaw.json')
    await writeFile(path, JSON.stringify({
      models: { providers: { custom: {
        baseUrl: 'https://api.example.com',
        api: 'openai-completions',
        models: [{ id: 'model-a', name: 'Model A' }],
      } } },
    }))

    expect(await repairModelCapabilities(path)).toBe(true)
    const repaired = await readOpenClawConfig(path)
    expect(repaired.models?.providers?.custom.baseUrl).toBe('https://api.example.com/v1')
    expect(await repairModelCapabilities(path)).toBe(false)
  })
  it('keeps provider credentials as an environment SecretRef', () => {
    const config = buildProviderConfig({
      id: 'demo-provider-test',
      baseUrl: 'https://api.example.com/v1',
      models: ['model-a'],
      secretStored: true,
    })
    expect(config).toMatchObject({
      api: 'openai-completions',
      auth: 'api-key',
      apiKey: { source: 'env', provider: 'default', id: 'EDICT_PROVIDER_DEMO_PROVIDER_TEST_API_KEY' },
      models: [{ id: 'model-a', name: 'model-a' }],
    })
    expect(JSON.stringify(config)).not.toContain('secret')
  })

  it('overrides the OpenAI SDK user agent for gateway compatibility', () => {
    const config = buildProviderConfig({
      id: 'demo-provider-test', baseUrl: 'https://api.example.com/v1', models: ['model-a'], secretStored: true,
    }, {
      baseUrl: 'https://api.example.com/v1', api: 'openai-completions', auth: 'api-key',
      headers: { 'user-agent': 'OpenAI/JS 6.45.0', 'X-Tenant': 'fixture' }, models: [],
    })
    expect(config.headers).toEqual({ 'X-Tenant': 'fixture', 'User-Agent': EDICT_PROVIDER_USER_AGENT })
  })

  it('syncs one provider without dropping unrelated OpenClaw settings', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'edict-openclaw-integration-'))
    const path = join(directory, 'openclaw.json')
    await writeFile(path, JSON.stringify({ gateway: { mode: 'local' }, models: { providers: { other: { baseUrl: 'https://other.test' } } } }))
    await syncProviderToOpenClaw(path, { id: 'demo-provider.i-test', baseUrl: 'https://api.example.com/v1', models: ['model-a'], hasApiKey: true })
    const config = await readOpenClawConfig(path)
    expect(config.gateway).toEqual({ mode: 'local' })
    expect(Object.keys(config.models?.providers || {})).toEqual(['other', 'demo-provider-i-test'])
    expect(config.models?.providers?.['demo-provider-i-test']).toMatchObject({ baseUrl: 'https://api.example.com/v1' })
    expect(JSON.stringify(config)).not.toContain('apiKeyValue')
  })

  it('joins the source Agent manifest with persisted model bindings', async () => {
    const manifest = await readAgentsManifest(join(process.cwd(), '..', 'upstream', 'agents.json'))
    expect(manifest).toHaveLength(11)
    const bindings = mergeAgentModelBindings(manifest, {
      agents: {
        defaults: { model: { primary: 'demo-provider/default-model' } },
        list: [{ id: 'gongbu', model: 'demo-provider-test/model-a' }],
      },
    })
    expect(bindings.find((item) => item.agentId === 'gongbu')).toMatchObject({
      providerId: 'demo-provider-test',
      modelId: 'model-a',
    })
    expect(bindings.find((item) => item.agentId === 'taizi')).toMatchObject({
      model: 'demo-provider/default-model',
    })
  })

  it('builds only in-memory provider environment values', async () => {
    const environment = await buildProviderEnvironment(
      [{ id: 'demo-provider.i-test', baseUrl: 'https://api.example.com', secretStored: true }],
      async () => 'runtime-secret',
    )
    expect(environment).toEqual({ 'EDICT_PROVIDER_DEMO_PROVIDER_I_TEST_API_KEY': 'runtime-secret' })
  })

  it('keeps provider/model references stable', () => {
    expect(modelReference('demo-provider.test', 'model/with/slashes')).toBe('demo-provider-test/model/with/slashes')
  })
})

