import { validateWorkflowGraph, workflowSchema, type Workflow } from './workflow'

export function validateWorkflow(input: unknown): { valid: boolean; errors: string[]; workflow?: Workflow } {
  const parsed = workflowSchema.safeParse(input)
  if (!parsed.success) return { valid: false, errors: parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`) }
  const errors = validateWorkflowGraph(parsed.data)
  return { valid: errors.length === 0, errors, workflow: parsed.data }
}
