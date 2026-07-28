// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OperationsPanel } from './OperationsPanel'
import type { AuthSession } from './api'

const auth: AuthSession = { authenticated: true, principal: { displayName: 'Alice' },
  workspace: { name: 'Workspace', role: 'owner' }, applicationRole: 'user', csrfToken: 'csrf' }

describe('OperationsPanel', () => {
  afterEach(() => vi.unstubAllGlobals())
  it('renders persisted run failures and untrusted artifact values as inert text', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.endsWith('/api/runs')) return Response.json({ runs: [{ id: 'run-1', workflowId: 'wf-1', workflowVersion: 2,
        status: 'failed', startedAt: '2026-07-21T00:00:00.000Z', summary: { errorCode: 'source_timeout' } }] })
      return Response.json({ artifacts: [{ id: 'art-1', type: 'csv', name: '<img src=x onerror=alert(1)>', rowCount: 1,
        columns: ['value'], provenance: ['test'], trustLevel: 'untrusted', classification: 'internal', checksum: 'hash',
        createdAt: '2026-07-21T00:00:00.000Z' }] })
    }))
    const { container } = render(<OperationsPanel auth={auth} workflows={[]} onClose={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('失敗理由: source_timeout')).toBeTruthy())
    expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeTruthy()
    expect(container.querySelector('img')).toBeNull()
    expect(screen.getByRole('button', { name: 'ダウンロード' })).toBeTruthy()
  })
})
