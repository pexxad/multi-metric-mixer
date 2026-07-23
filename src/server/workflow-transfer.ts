import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { AppError } from './errors'
import type { RequestContext } from './request-context'
import type { Workflow, WorkflowStep } from '../shared/workflow'
import { workflowStepSchema } from '../shared/workflow'
import { contentHash, type SavedWorkflow, type WorkflowRepository } from './persistence/workflow-repository'

const portableWorkflowSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(5_000),
  steps: z.array(workflowStepSchema).min(1).max(20),
}).strict()

const workflowTransferSchema = z.object({
  formatVersion: z.literal(1),
  workflowSchemaVersion: z.literal(1),
  definition: portableWorkflowSchema,
  capabilities: z.object({ workflow: z.literal(1), connectors: z.literal('read-only') }).strict(),
  contentHash: z.string().length(64).regex(/^[0-9a-f]+$/),
}).strict()

type WorkflowTransfer = z.infer<typeof workflowTransferSchema>

function portable(workflow: Workflow) {
  return { name: workflow.name, description: workflow.description, steps: workflow.steps }
}

export class WorkflowTransferService {
  constructor(private readonly workflows: WorkflowRepository) {}

  async prepare(context: RequestContext, id: string, version?: number): Promise<{ saved: SavedWorkflow; transfer: WorkflowTransfer }> {
    const saved = await this.workflows.require(context, id, version)
    const definition = portable(saved.workflow)
    return { saved, transfer: {
      formatVersion: 1,
      workflowSchemaVersion: 1,
      definition,
      capabilities: { workflow: 1, connectors: 'read-only' },
      contentHash: contentHash(definition),
    } }
  }

  async import(context: RequestContext, input: unknown): Promise<{ saved: SavedWorkflow; unresolvedConnections: Array<{ stepId: string; originalSource: string }> }> {
    const parsed = workflowTransferSchema.safeParse(input)
    if (!parsed.success) throw new AppError('workflow_import_invalid', 400, 'Workflowファイルの形式が不正です。', parsed.error.issues)
    if (contentHash(parsed.data.definition) !== parsed.data.contentHash) {
      throw new AppError('workflow_import_checksum_mismatch', 400, 'Workflowファイルが破損または変更されています。')
    }
    const unresolvedConnections: Array<{ stepId: string; originalSource: string }> = []
    const steps = parsed.data.definition.steps.map((step): WorkflowStep => {
      if (step.kind !== 'query') return step
      unresolvedConnections.push({ stepId: step.id, originalSource: step.config.source })
      return { ...step, config: { ...step.config, source: 'unconfigured' } }
    })
    const workflow: Workflow = {
      version: 1,
      id: `wf_import_${randomUUID().replaceAll('-', '')}`,
      name: `${parsed.data.definition.name}（インポート）`,
      description: parsed.data.definition.description,
      steps,
    }
    return { saved: await this.workflows.save(context, workflow, 'import'), unresolvedConnections }
  }
}
