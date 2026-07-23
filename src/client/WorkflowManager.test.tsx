// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { sampleWorkflow } from '../shared/workflow'
import type { AuthSession, WorkflowListItem } from './api'
import { WorkflowManager } from './WorkflowManager'

const auth: AuthSession = { authenticated: true, principal: { id: 'p1', displayName: 'Alice', status: 'active' },
  workspace: { id: 'w1', name: 'Workspace', slug: 'workspace', role: 'owner', membershipVersion: 1 },
  applicationRole: 'user', assuranceLevel: 'basic', csrfToken: 'csrf' }
const item: WorkflowListItem = { workflow: sampleWorkflow, version: 2, status: 'ready', updatedAt: '2026-07-21T00:00:00.000Z' }

describe('WorkflowManager', () => {
  afterEach(cleanup)
  it('lists Workflow details and requires explicit confirmation before deletion', async () => {
    const onDelete = vi.fn(async () => undefined)
    render(<WorkflowManager auth={auth} workflows={[item]} activeWorkflowId="other" activeDirty={false}
      onOpen={vi.fn(async () => undefined)} onCreate={vi.fn()} onDelete={onDelete} onClose={vi.fn()} />)
    expect(screen.getByRole('dialog', { name: 'Workflow管理' })).toBeTruthy()
    expect(screen.getByText(sampleWorkflow.name)).toBeTruthy()
    expect(screen.getByText('v2')).toBeTruthy()
    expect(screen.getByText('実行可能')).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: '削除' }))
    expect(screen.getByText(`「${sampleWorkflow.name}」を削除しますか？`)).toBeTruthy()
    expect(onDelete).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole('button', { name: '削除する' }))
    await waitFor(() => expect(onDelete).toHaveBeenCalledWith(item))
  })

  it('does not expose deletion to a viewer', () => {
    render(<WorkflowManager auth={{ ...auth, workspace: { ...auth.workspace, role: 'viewer' } }} workflows={[item]}
      activeWorkflowId={item.workflow.id} activeDirty={false} onOpen={vi.fn(async () => undefined)} onCreate={vi.fn()}
      onDelete={vi.fn(async () => undefined)} onClose={vi.fn()} />)
    expect(screen.queryByRole('button', { name: '削除' })).toBeNull()
    expect(screen.getByText('削除はWorkspaceのオーナーまたは編集者だけが実行できます。')).toBeTruthy()
  })
})
