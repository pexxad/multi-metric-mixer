import { randomUUID } from 'node:crypto'
import { AppError } from '../shared/errors'
import type { RequestContext } from '../shared/request-context'
import type { DataSourceReadService } from './connectors/read-service'
import type { RunRepository } from './persistence/run-repository'
import type { SavedWorkflow, WorkflowRepository } from './persistence/workflow-repository'
import type { WorkflowTools } from './workflow-tools'
import type { WorkflowRun } from '../shared/workflow'
import type { RunLimitService } from './run-limit-service'

export class WorkflowExecutionService {
  constructor(
    private readonly workflows: WorkflowRepository,
    private readonly runs: RunRepository,
    private readonly sources: DataSourceReadService,
    private readonly tools: WorkflowTools,
    private readonly runLimits: RunLimitService,
  ) {}

  async execute(context: RequestContext, workflowId: string, version?: number): Promise<WorkflowRun> {
    const saved = await this.workflows.require(context, workflowId, version)
    if (!saved.validation.valid) throw new AppError('workflow_not_ready', 409, '設定不足のWorkflowは実行できません。', saved.validation.errors)
    const slot = await this.runLimits.acquire(context)
    try {
      return await this.executeSaved(context, saved)
    } finally {
      await this.runLimits.release(context, slot)
    }
  }

  private async executeSaved(context: RequestContext, saved: SavedWorkflow): Promise<WorkflowRun> {
    const workflow = saved.workflow
    const runId = `run_${randomUUID()}`
    await this.runs.start(context, runId, saved)
    const started = performance.now()
    const artifactsByStep = new Map<string, string>()
    const stepRuns: WorkflowRun['steps'] = []
    try {
      for (const step of workflow.steps) {
        const stepStarted = performance.now()
        let artifact
        if (step.kind === 'query') artifact = await this.sources.query(context, step.config, runId)
        else if (step.kind === 'joinAggregate' || step.kind === 'join') {
          const left = step.inputs.left ? artifactsByStep.get(step.inputs.left) : undefined
          const right = step.inputs.right ? artifactsByStep.get(step.inputs.right) : undefined
          if (!left || !right) throw new AppError('workflow_input_unresolved', 400, `ステップ「${step.id}」の左右入力が解決できません。`)
          artifact = step.kind === 'joinAggregate'
            ? await this.tools.joinAggregate(context, left, right, step.config, runId)
            : await this.tools.join(context, left, right, step.config, runId)
        } else {
          const input = step.input ? artifactsByStep.get(step.input) : undefined
          if (!input) throw new AppError('workflow_input_unresolved', 400, `ステップ「${step.id}」の入力が解決できません。`)
          if (step.kind === 'filterSelect') artifact = await this.tools.filterSelect(context, input, step.config, runId)
          else if (step.kind === 'derive') artifact = await this.tools.derive(context, input, step.config, runId)
          else if (step.kind === 'aggregate') artifact = await this.tools.aggregate(context, input, step.config, runId)
          else if (step.kind === 'sortLimit') artifact = await this.tools.sortLimit(context, input, step.config, runId)
          else if (step.kind === 'preview') artifact = await this.tools.preview(context, input, step.config, runId)
          else artifact = await this.tools.csv(context, input, step.config, runId)
        }
        artifactsByStep.set(step.id, artifact.id)
        stepRuns.push({ stepId: step.id, status: 'completed', artifact: this.tools.summary(artifact),
          durationMs: Math.max(1, Math.round(performance.now() - stepStarted)) })
      }
      const finalArtifact = stepRuns.at(-1)?.artifact
      if (!finalArtifact) throw new AppError('run_empty', 500, '実行結果がありません。')
      const run: WorkflowRun = {
        id: runId, workflowId: workflow.id, status: 'completed', startedAt: new Date().toISOString(),
        durationMs: Math.max(1, Math.round(performance.now() - started)), steps: stepRuns, finalArtifact,
      }
      await this.runs.finish(context, run)
      return run
    } catch (error) {
      await this.runs.fail(context, runId, error instanceof AppError ? error.code : 'internal_error')
      throw error
    }
  }
}
