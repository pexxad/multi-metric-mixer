import type { ArtifactSummary, TableRow, Workflow } from './workflow'

export type WorkflowChangeSource = 'manual' | 'agent' | 'import' | 'migration'

export type SavedWorkflow = {
  workflow: Workflow
  version: number
  contentHash: string
  status: 'draft' | 'ready' | 'stale' | 'archived'
  validation: { valid: boolean; errors: string[] }
  updatedAt: string
}

export type StoredArtifact = ArtifactSummary & {
  workspaceId: string
  runId?: string
  rows?: TableRow[]
  content?: Uint8Array
  mimeType?: string
}
