import { afterEach, describe, expect, it } from 'vitest'
import { BackendDatabase } from './backend-core/persistence/backend-database'
import { WorkflowRepository } from './backend-core/persistence/workflow-repository'
import { ConversationRepository } from './bff/persistence/conversation-repository'
import { WorkflowTransferService } from './backend-core/workflow-transfer'
import { ApprovalService } from './bff/approval-service'
import { ArtifactRepository } from './backend-core/persistence/artifact-repository'
import { UploadIngestionService } from './backend-core/upload-ingestion'
import type { RequestContext } from './shared/request-context'
import { sampleWorkflow } from './shared/workflow'
import { MemoryArtifactContentStore } from './backend-core/persistence/artifact-content-store'
import { backendContext, testBackendDatabase, testBffDatabase, testContext } from './test-support'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe('Version 1 persisted user flows', () => {
  const databases: Array<{ close(): Promise<void> }> = []
  afterEach(async () => { for (const database of databases.splice(0)) await database.close() })

  async function setup(subject = 'alice') {
    const bffDatabase = await testBffDatabase(); databases.push(bffDatabase)
    const backendDatabase = await testBackendDatabase(); databases.push(backendDatabase)
    const context: RequestContext = await testContext(bffDatabase, `request-${subject}`, {
      providerKey: 'oidc-main', subject, displayName: subject, groups: [], applicationRole: 'user', assuranceLevel: 'basic',
    })
    return { bffDatabase, backendDatabase, context }
  }

  it('stores an idempotent chat exchange and context snapshot against an immutable Workflow version', async () => {
    const { bffDatabase, backendDatabase, context } = await setup()
    const saved = await new WorkflowRepository(backendDatabase).save(context, sampleWorkflow, 'agent')
    const repository = new ConversationRepository(bffDatabase)
    const input = { title: '分析', clientMessageId: 'browser-1', userMessage: 'CSVにして', assistantMessage: 'CSVノードを追加しました。',
      workflowId: saved.workflow.id, workflowVersion: saved.version, contextSummary: { changes: ['CSVノード追加'] } }
    const first = await repository.appendExchange(context, input)
    const duplicate = await repository.appendExchange(context, { ...input, conversationId: first.id })
    expect(duplicate.messages).toHaveLength(2)
    expect(await bffDatabase.query.selectFrom('context_snapshots').select(({ fn }) => fn.countAll().as('count')).executeTakeFirst()).toMatchObject({ count: 1 })
    expect(duplicate.messages[1]).toMatchObject({ role: 'assistant', workflowVersion: 1 })
  })

  it('exports no Workspace or connection definition and imports as a new unresolved Draft', async () => {
    const { backendDatabase, context } = await setup()
    const workflows = new WorkflowRepository(backendDatabase)
    const definition = { ...sampleWorkflow, steps: sampleWorkflow.steps.map((step) => step.kind === 'query'
      ? { ...step, config: { ...step.config, source: 'private-source-id' } } : step) }
    const saved = await workflows.save(context, definition, 'manual')
    const transfers = new WorkflowTransferService(workflows)
    const transfer = (await transfers.prepare(context, saved.workflow.id, saved.version)).transfer
    expect(JSON.stringify(transfer)).not.toContain(context.workspace.id)
    expect(JSON.stringify(transfer)).not.toContain('baseUrl')
    const imported = await transfers.import(context, transfer)
    expect(imported.saved.workflow.id).not.toBe(saved.workflow.id)
    expect(imported.saved.status).toBe('draft')
    expect(imported.unresolvedConnections).toEqual([{ stepId: 'fetch-json', originalSource: 'private-source-id' }])
  })

  it('binds an export approval to the exact immutable version and consumes it once', async () => {
    const { bffDatabase, backendDatabase, context } = await setup()
    const saved = await new WorkflowRepository(backendDatabase).save(context, sampleWorkflow, 'manual')
    const action = { type: 'workflow_export' as const, workflowId: saved.workflow.id, version: saved.version, contentHash: saved.contentHash }
    const approvals = new ApprovalService(bffDatabase)
    const approval = await approvals.issue(context, action, { workflowName: saved.workflow.name })
    await expect(approvals.consume(context, approval.id, { ...action, version: 2 })).rejects.toThrow(/承認/)
    await approvals.consume(context, approval.id, action)
    await expect(approvals.consume(context, approval.id, action)).rejects.toThrow(/承認/)
  })

  it('binds an export-producing run approval to the exact output node set', async () => {
    const { bffDatabase, backendDatabase, context } = await setup()
    const saved = await new WorkflowRepository(backendDatabase).save(context, sampleWorkflow, 'manual')
    const action = { type: 'workflow_run_export' as const, workflowId: saved.workflow.id, version: saved.version,
      contentHash: saved.contentHash, outputStepIds: ['csv'] }
    const approvals = new ApprovalService(bffDatabase)
    const approval = await approvals.issue(context, action, { outputFiles: ['rest-response.csv'] })
    await expect(approvals.consume(context, approval.id, { ...action, outputStepIds: ['other'] })).rejects.toThrow(/承認/)
    await approvals.consume(context, approval.id, action)
  })

  it('quarantines validated JSON/CSV as untrusted Artifacts and rejects dangerous CSV headers', async () => {
    const { backendDatabase, context } = await setup()
    const contentStore = new MemoryArtifactContentStore()
    const ingestion = new UploadIngestionService(new ArtifactRepository(backendDatabase, contentStore), contentStore, {
      maxBytes: 10_000, maxRows: 10, maxColumns: 5, maxFieldChars: 100, maxDepth: 5, maxParseMs: 1_000,
      maxJsonNodes: 100, maxJsonKeys: 20,
    })
    const artifact = await ingestion.ingest(context, { format: 'json', filename: '../../report.json', contentType: 'application/json',
      bytes: Buffer.from('[{"name":"Alice","value":1}]') })
    expect(artifact).toMatchObject({ name: 'report.json', trustLevel: 'untrusted', rowCount: 1 })
    expect(artifact.provenance).toContain('quarantine:validated')
    await expect(ingestion.ingest(context, { format: 'csv', contentType: 'text/csv', bytes: Buffer.from('__proto__,value\nx,1') }))
      .rejects.toThrow(/header/)
    await expect(ingestion.ingest(context, { format: 'json', filename: 'report.csv', contentType: 'application/json', bytes: Buffer.from('{}') }))
      .rejects.toThrow(/拡張子/)
    await expect(ingestion.ingest(context, { format: 'json', filename: 'keys.json', contentType: 'application/json',
      bytes: Buffer.from(`{${Array.from({ length: 21 }, (_, index) => `"k${index}":${index}`).join(',')}}`) }))
      .rejects.toThrow(/key数/)
  })

  it('restores Workflow metadata and Artifact content after a local process restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mmm-restart-'))
    const filename = join(directory, 'app.sqlite')
    const artifactPath = join(directory, 'artifacts')
    let database = await BackendDatabase.open({ kind: 'sqlite', filename }); databases.push(database)
    const context = backendContext({ requestId: 'before-restart' })
    const saved = await new WorkflowRepository(database).save(context, sampleWorkflow, 'manual')
    const { FileArtifactContentStore } = await import('./backend-core/persistence/artifact-content-store')
    const artifact = await new ArtifactRepository(database, new FileArtifactContentStore(artifactPath)).createTable(context, 'persisted', [{ value: 42 }], ['restart-test'])
    await database.close(); databases.splice(databases.indexOf(database), 1)
    database = await BackendDatabase.open({ kind: 'sqlite', filename }); databases.push(database)
    const after = backendContext({ requestId: 'after-restart' })
    expect(await new WorkflowRepository(database).require(after, saved.workflow.id, saved.version)).toMatchObject({ contentHash: saved.contentHash })
    expect(await new ArtifactRepository(database, new FileArtifactContentStore(artifactPath)).get(after, artifact.id)).toMatchObject({ rows: [{ value: 42 }] })
    await database.close(); databases.splice(databases.indexOf(database), 1)
    await rm(directory, { recursive: true, force: true })
  })
})
