// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ArtifactDownloadButton } from './ArtifactDownloadButton'
import type { AuthSession } from './api'

const auth: AuthSession = { authenticated: true, principal: { id: 'p1', displayName: 'Alice', status: 'active' },
  workspace: { id: 'w1', name: 'Workspace', slug: 'workspace', role: 'owner', membershipVersion: 1 },
  applicationRole: 'user', assuranceLevel: 'basic', csrfToken: 'csrf' }
const artifact = { id: 'art-1', type: 'csv' as const, name: 'report.csv', rowCount: 2, columns: ['value'], provenance: ['test'],
  trustLevel: 'untrusted' as const, classification: 'confidential' as const, checksum: 'sha256-value', createdAt: '2026-07-21T00:00:00.000Z' }

describe('ArtifactDownloadButton', () => {
  afterEach(() => vi.unstubAllGlobals())
  it('renders the server-issued significant fields before download', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ id: 'approval-1', expiresAt: '2026-07-21T00:05:00.000Z',
      summary: { artifactName: 'report.csv', rows: 2, classification: 'confidential', destination: 'ログイン中の端末', checksum: 'sha256-value' } })))
    render(<ArtifactDownloadButton auth={auth} artifact={artifact} />)
    await userEvent.click(screen.getByRole('button', { name: 'ダウンロード' }))
    await waitFor(() => expect(screen.getByRole('dialog', { name: '成果物ダウンロードの確認' })).toBeTruthy())
    expect(screen.getByText('sha256-value')).toBeTruthy()
    expect(screen.getByText('内容確認用ハッシュ')).toBeTruthy()
    expect(screen.getByText('ログイン中の端末')).toBeTruthy()
    expect(screen.getByText('機密')).toBeTruthy()
    expect(screen.getByRole('button', { name: '確認してダウンロード' })).toBeTruthy()
  })
})
