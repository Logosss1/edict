import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type Server } from 'node:http'

import {
  EncryptedFileSecretStore,
  MemorySecretStore,
  type SecretCipher,
} from '../main/providers/secret-store.js'
import {
  ProviderStore,
  testProviderConnection,
} from '../main/providers/provider-store.js'

const temporaryDirectories: string[] = []
const mockServers: Server[] = []

afterEach(async () => {
  await Promise.all(mockServers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'edict-provider-store-'))
  temporaryDirectories.push(directory)
  return directory
}

class TestCipher implements SecretCipher {
  encrypt(value: string): string {
    return `ciphertext:${Buffer.from(value, 'utf8').toString('base64')}`
  }

  decrypt(value: string): string {
    if (!value.startsWith('ciphertext:')) throw new Error('unexpected ciphertext')
    return Buffer.from(value.slice('ciphertext:'.length), 'base64').toString('utf8')
  }
}

describe('ProviderStore', () => {
  it('preserves safe discovery capabilities on save and drops them when the endpoint changes', async () => {
    const directory = await temporaryDirectory()
    const store = new ProviderStore({ metadataPath: join(directory, 'providers.json'), secretStore: new MemorySecretStore() })
    const discovered = await testProviderConnection({ name: 'Fixture', baseUrl: 'http://localhost/v1' }, 'fixture-key', {
      fetch: async () => new Response(JSON.stringify({ data: [
        { id: 'custom', reasoning: true, supportedReasoningEfforts: ['low', 'high'], secret: 'never-copy' },
      ] })),
    })
    const saved = await store.upsert({ name: 'Fixture', baseUrl: 'http://localhost/v1', models: discovered.modelDefinitions })
    await store.upsert({ ...saved, models: [{ id: 'custom' }] })
    expect((await store.list())[0].models[0].supportedReasoningEfforts).toEqual(['low', 'high'])
    expect(JSON.stringify(await store.list())).not.toContain('never-copy')
    const summary = (await store.list())[0]
    summary.models[0].supportedReasoningEfforts!.push('ultra')
    expect((await store.list())[0].models[0].supportedReasoningEfforts).toEqual(['low', 'high'])
    await store.upsert({ ...saved, baseUrl: 'http://other.test/v1', models: [{ id: 'custom' }] })
    expect((await store.list())[0].models[0].supportedReasoningEfforts).toBeUndefined()
  })

  it('persists provider metadata without the API key and restores encrypted credentials', async () => {
    const directory = await temporaryDirectory()
    const metadataPath = join(directory, 'providers.json')
    const credentialPath = join(directory, 'credentials.json')
    const cipher = new TestCipher()
    const firstStore = new ProviderStore({
      metadataPath,
      secretStore: new EncryptedFileSecretStore(credentialPath, cipher),
      clock: () => new Date('2026-09-04T12:00:00.000Z'),
    })

    const saved = await firstStore.upsert({
      id: 'demo-provider-test',
      name: '示例供应商 测试',
      kind: 'openai-compatible',
      baseUrl: 'https://api.example.com/v1/',
      models: [{ id: 'test-model', label: 'Test Model' }],
      defaultModelId: 'test-model',
      apiKey: 'test-secret-123',
    })

    expect(saved).toMatchObject({
      id: 'demo-provider-test',
      baseUrl: 'https://api.example.com/v1',
      defaultModelId: 'test-model',
      hasApiKey: true,
    })
    expect(saved).not.toHaveProperty('credentialRef')
    expect(saved).not.toHaveProperty('apiKey')

    const metadata = await readFile(metadataPath, 'utf8')
    const credentials = await readFile(credentialPath, 'utf8')
    expect(metadata).not.toContain('test-secret-123')
    expect(metadata).not.toContain('apiKey')
    expect(credentials).not.toContain('test-secret-123')
    expect(credentials).toContain('ciphertext:')

    const reopenedStore = new ProviderStore({
      metadataPath,
      secretStore: new EncryptedFileSecretStore(credentialPath, cipher),
    })
    expect(await reopenedStore.getApiKey('demo-provider-test')).toBe('test-secret-123')
    expect((await reopenedStore.list())[0]).toMatchObject({ id: 'demo-provider-test', hasApiKey: true })
  })

  it('updates and clears credentials without exposing them in summaries', async () => {
    const directory = await temporaryDirectory()
    const store = new ProviderStore({
      metadataPath: join(directory, 'providers.json'),
      secretStore: new MemorySecretStore(),
    })
    await store.upsert({ name: 'Local', baseUrl: 'http://127.0.0.1:7891', apiKey: 'first-secret' })
    const provider = (await store.list())[0]
    expect(provider.hasApiKey).toBe(true)

    await store.upsert({ ...provider, apiKey: 'second-secret' })
    expect(await store.getApiKey(provider.id)).toBe('second-secret')
    expect(await store.upsert({ ...provider, apiKey: null })).toMatchObject({ hasApiKey: false })
    expect(await store.getApiKey(provider.id)).toBeUndefined()
  })

  it('rejects invalid URLs and defaults New API channel types to OpenAI compatible', async () => {
    const directory = await temporaryDirectory()
    const store = new ProviderStore({
      metadataPath: join(directory, 'providers.json'),
      secretStore: new MemorySecretStore(),
    })
    await expect(store.upsert({ name: 'Bad', baseUrl: 'file:///tmp/provider' })).rejects.toMatchObject({ code: 'INVALID_URL' })
    const provider = await store.upsert({
      name: 'New API',
      _type: 'newapi_channel_conn',
      url: 'https://example.com',
    })
    expect(provider.kind).toBe('openai-compatible')
  })

  it('uses restrictive permissions for metadata and encrypted credential files', async () => {
    if (process.platform === 'win32') return
    const directory = await temporaryDirectory()
    const metadataPath = join(directory, 'providers.json')
    const credentialPath = join(directory, 'credentials.json')
    const store = new ProviderStore({
      metadataPath,
      secretStore: new EncryptedFileSecretStore(credentialPath, new TestCipher()),
    })
    await store.upsert({ name: 'Permissions', baseUrl: 'https://example.com', apiKey: 'permission-secret' })
    expect((await stat(metadataPath)).mode & 0o777).toBe(0o600)
    expect((await stat(credentialPath)).mode & 0o777).toBe(0o600)
    expect((await stat(directory)).mode & 0o777).toBe(0o700)
  })
})

describe('testProviderConnection', () => {
  it('performs one redacted OpenAI-compatible models request', async () => {
    const requests: Array<{ url: string; authorization?: string }> = []
    const result = await testProviderConnection(
      { name: '示例供应商', baseUrl: 'https://api.example.com', kind: 'openai-compatible' },
      'test-secret-456',
      {
        fetch: async (input, init) => {
          requests.push({
            url: String(input),
            authorization: new Headers(init?.headers).get('authorization') ?? undefined,
          })
          return new Response(JSON.stringify({ data: [{ id: 'model-a' }, { id: 'model-b' }] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        },
      },
    )
    expect(result).toMatchObject({ ok: true, endpoint: 'https://api.example.com/v1/models', status: 200, modelCount: 2 })
    expect(result.latencyMs).toEqual(expect.any(Number))
    expect(result.latencyMs).toEqual(expect.any(Number))
    expect(requests).toEqual([{ url: 'https://api.example.com/v1/models', authorization: 'Bearer test-secret-456' }])
  })

  it('returns a safe error for unsupported protocols without making a request', async () => {
    let called = false
    const result = await testProviderConnection(
      { name: 'Invalid', baseUrl: 'file:///tmp/provider' },
      undefined,
      { fetch: async () => { called = true; return new Response() } },
    )
    expect(result.ok).toBe(false)
    expect(result.error).toContain('HTTP or HTTPS')
    expect(called).toBe(false)
  })

  it('discovers models through a local HTTP mock and reports provider auth errors', async () => {
    const server = createServer((request, response) => {
      if (request.url === '/v1/models' && request.headers.authorization === 'Bearer mock-key') {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ data: [{ id: 'mock-alpha' }, { id: 'mock-beta' }] }))
        return
      }
      response.writeHead(401, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { message: 'invalid key' } }))
    })
    mockServers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Mock server did not expose a port')
    const baseUrl = `http://127.0.0.1:${address.port}`

    const success = await testProviderConnection(
      { name: 'Local Mock', baseUrl, kind: 'openai-compatible' },
      'mock-key',
    )
    expect(success).toMatchObject({ ok: true, endpoint: `${baseUrl}/v1/models`, status: 200, models: ['mock-alpha', 'mock-beta'] })

    const failure = await testProviderConnection(
      { name: 'Local Mock', baseUrl },
      'wrong-key',
    )
    expect(failure).toMatchObject({ ok: false, endpoint: `${baseUrl}/v1/models`, status: 401 })
    expect(failure.error).toContain('HTTP 401')
    expect(failure.error).not.toContain('wrong-key')
  })

  it('accepts a base URL that already contains /v1', async () => {
    const requests: string[] = []
    const result = await testProviderConnection(
      { name: 'Versioned Mock', baseUrl: 'http://mock.test/v1/', kind: 'openai-compatible' },
      'mock-key',
      {
        fetch: async (input) => {
          requests.push(String(input))
          return new Response(JSON.stringify({ data: [{ id: 'versioned-model' }] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        },
      },
    )
    expect(result).toMatchObject({ ok: true, endpoint: 'http://mock.test/v1/models', models: ['versioned-model'] })
    expect(requests).toEqual(['http://mock.test/v1/models'])
  })

  it('reports invalid JSON from a successful model endpoint without exposing credentials', async () => {
    const secret = 'invalid-json-secret'
    const result = await testProviderConnection(
      { name: 'Invalid JSON Mock', baseUrl: 'http://mock.test', kind: 'openai-compatible' },
      secret,
      {
        fetch: async () => new Response('{not-json', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      },
    )
    expect(result.ok).toBe(false)
    expect(result.error).toContain('有效 JSON')
    expect(JSON.stringify(result)).not.toContain(secret)
  })

  it('treats an empty model catalog as a successful, observable response', async () => {
    const result = await testProviderConnection(
      { name: 'Empty Mock', baseUrl: 'http://mock.test', kind: 'openai-compatible' },
      'mock-key',
      {
        fetch: async () => new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      },
    )
    expect(result).toMatchObject({ ok: true, models: [], modelCount: 0 })
  })

  it('redacts the API key if a transport error echoes request details', async () => {
    const secret = 'transport-secret'
    const result = await testProviderConnection(
      { name: 'Error Mock', baseUrl: 'http://mock.test', kind: 'openai-compatible' },
      secret,
      {
        fetch: async () => { throw new Error(`request failed: Authorization Bearer ${secret}`) },
      },
    )
    expect(result.ok).toBe(false)
    expect(result.error).not.toContain(secret)
    expect(result.error).toContain('[redacted]')
  })

  it('reports a timeout even when the fallback model endpoint is unavailable', async () => {
    const result = await testProviderConnection(
      { name: 'Slow Mock', baseUrl: 'http://127.0.0.1:9999/v1' },
      'mock-key',
      {
        timeoutMs: 10,
        fetch: async (_input, init) => await new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal
          signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
        }),
      },
    )
    expect(result.ok).toBe(false)
    expect(result.error).toContain('超时')
  })
})

