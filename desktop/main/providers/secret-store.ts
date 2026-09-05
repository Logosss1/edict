import { randomUUID } from 'node:crypto'
import {
  chmod,
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { dirname } from 'node:path'

const SECRET_DOCUMENT_VERSION = 1
const SECRET_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,159}$/

export interface SecretStore {
  get(ref: string): Promise<string | undefined>
  set(ref: string, value: string): Promise<void>
  delete(ref: string): Promise<void>
}

export interface SecretCipher {
  encrypt(value: string): string
  decrypt(value: string): string
}

/** The small part of Electron safeStorage used by the main process. */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean
  encryptString(value: string): Buffer
  decryptString(value: Buffer): string
}

export class SecretStoreError extends Error {
  readonly code: string

  constructor(message: string, code = 'SECRET_STORE_ERROR') {
    super(message)
    this.name = 'SecretStoreError'
    this.code = code
  }
}

/**
 * Encrypts values with Electron's OS-backed safeStorage implementation.
 * The encrypted value is base64 encoded so it can be written to JSON.
 */
export class ElectronSafeStorageCipher implements SecretCipher {
  constructor(private readonly safeStorage: SafeStorageLike) {}

  encrypt(value: string): string {
    this.assertAvailable()
    try {
      const encrypted = this.safeStorage.encryptString(value)
      if (!Buffer.isBuffer(encrypted)) {
        throw new Error('safeStorage returned a non-buffer value')
      }
      return encrypted.toString('base64')
    } catch {
      throw new SecretStoreError('Unable to encrypt credential with OS secure storage', 'ENCRYPT_FAILED')
    }
  }

  decrypt(value: string): string {
    this.assertAvailable()
    try {
      return this.safeStorage.decryptString(Buffer.from(value, 'base64'))
    } catch {
      throw new SecretStoreError('Unable to decrypt credential from OS secure storage', 'DECRYPT_FAILED')
    }
  }

  private assertAvailable(): void {
    let available = false
    try {
      available = this.safeStorage.isEncryptionAvailable()
    } catch {
      available = false
    }
    if (!available) {
      throw new SecretStoreError(
        'OS secure storage is unavailable; credentials were not stored',
        'SECURE_STORAGE_UNAVAILABLE',
      )
    }
  }
}

type SecretDocument = {
  version: typeof SECRET_DOCUMENT_VERSION
  secrets: Record<string, string>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNodeErrorWithCode(value: unknown, code: string): boolean {
  return isRecord(value) && value.code === code
}

function assertSecretRef(ref: string): void {
  if (!SECRET_REF_PATTERN.test(ref)) {
    throw new SecretStoreError('Invalid credential reference', 'INVALID_REFERENCE')
  }
}

async function secureDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 })
  try {
    await chmod(path, 0o700)
  } catch {
    throw new SecretStoreError('Unable to secure credential storage directory', 'PERMISSIONS_FAILED')
  }
}

/**
 * Stores encrypted secrets in a separate file from provider metadata.
 * The file is replaced with a same-directory rename so interrupted writes do
 * not leave a partially written JSON document behind.
 */
export class EncryptedFileSecretStore implements SecretStore {
  private document: SecretDocument | undefined
  private loading: Promise<void> | undefined
  private queue: Promise<void> = Promise.resolve()

  constructor(
    private readonly filePath: string,
    private readonly cipher: SecretCipher,
  ) {}

  get(ref: string): Promise<string | undefined> {
    assertSecretRef(ref)
    return this.runExclusive(async () => {
      await this.ensureLoaded()
      const encrypted = this.document?.secrets[ref]
      return encrypted === undefined ? undefined : this.decrypt(encrypted)
    })
  }

  set(ref: string, value: string): Promise<void> {
    assertSecretRef(ref)
    if (!value.trim()) {
      throw new SecretStoreError('Credential cannot be empty', 'EMPTY_SECRET')
    }
    return this.runExclusive(async () => {
      await this.ensureLoaded()
      this.document!.secrets[ref] = this.encrypt(value)
      await this.persist()
    })
  }

  delete(ref: string): Promise<void> {
    assertSecretRef(ref)
    return this.runExclusive(async () => {
      await this.ensureLoaded()
      if (!(ref in this.document!.secrets)) return
      delete this.document!.secrets[ref]
      await this.persist()
    })
  }

  private runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation)
    this.queue = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  private async ensureLoaded(): Promise<void> {
    if (this.document) return
    if (!this.loading) {
      this.loading = this.readDocument().finally(() => {
        this.loading = undefined
      })
    }
    await this.loading
  }

  private async readDocument(): Promise<void> {
    await secureDirectory(dirname(this.filePath))

    let raw: string
    try {
      raw = await readFile(this.filePath, 'utf8')
    } catch (error) {
      if (isNodeErrorWithCode(error, 'ENOENT')) {
        this.document = { version: SECRET_DOCUMENT_VERSION, secrets: {} }
        return
      }
      throw new SecretStoreError('Unable to read credential storage', 'READ_FAILED')
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw new SecretStoreError('Credential storage is not valid JSON', 'INVALID_DOCUMENT')
    }
    if (!isRecord(parsed) || parsed.version !== SECRET_DOCUMENT_VERSION || !isRecord(parsed.secrets)) {
      throw new SecretStoreError('Credential storage has an unsupported format', 'INVALID_DOCUMENT')
    }

    const secrets: Record<string, string> = {}
    for (const [ref, value] of Object.entries(parsed.secrets)) {
      assertSecretRef(ref)
      if (typeof value !== 'string' || !value) {
        throw new SecretStoreError('Credential storage has an invalid entry', 'INVALID_DOCUMENT')
      }
      secrets[ref] = value
    }
    this.document = { version: SECRET_DOCUMENT_VERSION, secrets }

    try {
      await chmod(this.filePath, 0o600)
    } catch {
      throw new SecretStoreError('Unable to secure credential storage file', 'PERMISSIONS_FAILED')
    }
  }

  private async persist(): Promise<void> {
    const directory = dirname(this.filePath)
    await secureDirectory(directory)
    const temporaryPath = `${this.filePath}.${randomUUID()}.tmp`
    const body = `${JSON.stringify(this.document)}\n`
    try {
      await writeFile(temporaryPath, body, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
      await chmod(temporaryPath, 0o600)
      await rename(temporaryPath, this.filePath)
      await chmod(this.filePath, 0o600)
    } catch {
      throw new SecretStoreError('Unable to persist encrypted credentials', 'WRITE_FAILED')
    } finally {
      await unlink(temporaryPath).catch(() => undefined)
    }
  }

  private encrypt(value: string): string {
    try {
      const encrypted = this.cipher.encrypt(value)
      if (!encrypted) throw new Error('empty ciphertext')
      return encrypted
    } catch (error) {
      if (error instanceof SecretStoreError) throw error
      throw new SecretStoreError('Unable to encrypt credential', 'ENCRYPT_FAILED')
    }
  }

  private decrypt(value: string): string {
    try {
      return this.cipher.decrypt(value)
    } catch (error) {
      if (error instanceof SecretStoreError) throw error
      throw new SecretStoreError('Unable to decrypt credential', 'DECRYPT_FAILED')
    }
  }
}

/** In-memory implementation for unit tests and non-persistent previews. */
export class MemorySecretStore implements SecretStore {
  private readonly secrets = new Map<string, string>()

  async get(ref: string): Promise<string | undefined> {
    assertSecretRef(ref)
    return this.secrets.get(ref)
  }

  async set(ref: string, value: string): Promise<void> {
    assertSecretRef(ref)
    if (!value.trim()) throw new SecretStoreError('Credential cannot be empty', 'EMPTY_SECRET')
    this.secrets.set(ref, value)
  }

  async delete(ref: string): Promise<void> {
    assertSecretRef(ref)
    this.secrets.delete(ref)
  }
}

