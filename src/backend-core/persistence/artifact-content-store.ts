import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { CopyObjectCommand, DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'

export interface ArtifactContentStore {
  putImmutable(key: string, content: Uint8Array, mediaType: string): Promise<void>
  get(key: string): Promise<Uint8Array>
  quarantineAndPromote(key: string, content: Uint8Array, mediaType: string): Promise<void>
  quarantine(content: Uint8Array, mediaType: string): Promise<string>
  delete(key: string): Promise<void>
}

export class MemoryArtifactContentStore implements ArtifactContentStore {
  private readonly values = new Map<string, Uint8Array>()
  async putImmutable(key: string, content: Uint8Array): Promise<void> {
    safeKey(key)
    if (this.values.has(key)) throw new Error('artifact_object_exists')
    this.values.set(key, new Uint8Array(content))
  }
  async get(key: string): Promise<Uint8Array> {
    const value = this.values.get(safeKey(key))
    if (!value) throw new Error('artifact_content_missing')
    return new Uint8Array(value)
  }
  async quarantineAndPromote(key: string, content: Uint8Array): Promise<void> { await this.putImmutable(key, content) }
  async quarantine(content: Uint8Array): Promise<string> { const key = `quarantine/${crypto.randomUUID()}`; await this.putImmutable(key, content); return key }
  async delete(key: string): Promise<void> { this.values.delete(safeKey(key)) }
}

function safeKey(key: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9/_-]*$/.test(key) || key.includes('..') || key.startsWith('/')) {
    throw new Error('invalid_artifact_object_key')
  }
  return key
}

export class FileArtifactContentStore implements ArtifactContentStore {
  private readonly root: string

  constructor(root: string) {
    this.root = resolve(root)
  }

  private path(key: string): string {
    const path = resolve(join(this.root, safeKey(key)))
    if (!path.startsWith(`${this.root}/`)) throw new Error('invalid_artifact_object_key')
    return path
  }

  async putImmutable(key: string, content: Uint8Array): Promise<void> {
    const path = this.path(key)
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    await writeFile(path, content, { flag: 'wx', mode: 0o600 })
  }

  async get(key: string): Promise<Uint8Array> {
    return new Uint8Array(await readFile(this.path(key)))
  }

  async quarantineAndPromote(key: string, content: Uint8Array): Promise<void> {
    const target = this.path(key)
    const quarantine = this.path(`quarantine/${crypto.randomUUID()}`)
    await mkdir(dirname(quarantine), { recursive: true, mode: 0o700 })
    await mkdir(dirname(target), { recursive: true, mode: 0o700 })
    await writeFile(quarantine, content, { flag: 'wx', mode: 0o600 })
    await rename(quarantine, target)
  }

  async quarantine(content: Uint8Array): Promise<string> {
    const key = `quarantine/${crypto.randomUUID()}`
    const path = this.path(key)
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    await writeFile(path, content, { flag: 'wx', mode: 0o600 })
    return key
  }

  async delete(key: string): Promise<void> {
    const { rm } = await import('node:fs/promises')
    await rm(this.path(key), { force: true })
  }
}

export class S3ArtifactContentStore implements ArtifactContentStore {
  constructor(private readonly client: S3Client, private readonly bucket: string, private readonly prefix: string,
    private readonly kmsKeyId: string) {}

  private key(key: string): string {
    return `${this.prefix.replace(/\/$/, '')}/${safeKey(key)}`
  }

  async putImmutable(key: string, content: Uint8Array, mediaType: string): Promise<void> {
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: this.key(key), Body: content,
      ContentType: mediaType, ServerSideEncryption: 'aws:kms', SSEKMSKeyId: this.kmsKeyId, IfNoneMatch: '*' }))
  }

  async get(key: string): Promise<Uint8Array> {
    const response = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: this.key(key) }))
    if (!response.Body) throw new Error('artifact_content_missing')
    return new Uint8Array(await response.Body.transformToByteArray())
  }

  async quarantineAndPromote(key: string, content: Uint8Array, mediaType: string): Promise<void> {
    const quarantineKey = this.key(`quarantine/${crypto.randomUUID()}`)
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: quarantineKey, Body: content,
      ContentType: mediaType, ServerSideEncryption: 'aws:kms', SSEKMSKeyId: this.kmsKeyId, IfNoneMatch: '*' }))
    try {
      await this.client.send(new CopyObjectCommand({ Bucket: this.bucket, Key: this.key(key),
        CopySource: encodeURIComponent(`${this.bucket}/${quarantineKey}`), ServerSideEncryption: 'aws:kms', SSEKMSKeyId: this.kmsKeyId }))
    } finally {
      await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: quarantineKey }))
    }
  }


  async quarantine(content: Uint8Array, mediaType: string): Promise<string> {
    const key = `quarantine/${crypto.randomUUID()}`
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: this.key(key), Body: content,
      ContentType: mediaType, ServerSideEncryption: 'aws:kms', SSEKMSKeyId: this.kmsKeyId, IfNoneMatch: '*' }))
    return key
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: this.key(key) }))
  }
}
