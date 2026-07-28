import { randomUUID } from 'node:crypto'
import type { AgentToolActivity } from '../../shared/api'
import type { RequestContext } from '../../shared/request-context'
import type { InternalMcpClient } from '../internal-mcp-client'

type ActivityListener = (activity: AgentToolActivity) => void | Promise<void>

export class AgentMcpRunner {
  readonly activities: AgentToolActivity[] = []

  constructor(
    private readonly client: InternalMcpClient,
    private readonly context: RequestContext,
    private readonly onActivity: ActivityListener = () => undefined,
  ) {}

  async call<T>(
    tool: string,
    label: string,
    input: Record<string, unknown>,
    validate: (result: T) => void = () => undefined,
  ): Promise<T> {
    const startedAt = performance.now()
    const running: AgentToolActivity = { id: randomUUID(), tool, label, status: 'running' }
    await this.onActivity(running)
    try {
      const result = await this.client.call<T>(this.context, tool, input)
      validate(result)
      const completed = { ...running, status: 'completed' as const, durationMs: Math.round(performance.now() - startedAt) }
      this.activities.push(completed)
      await this.onActivity(completed)
      return result
    } catch (error) {
      const failed = { ...running, status: 'failed' as const, durationMs: Math.round(performance.now() - startedAt) }
      this.activities.push(failed)
      await this.onActivity(failed)
      throw error
    }
  }
}
