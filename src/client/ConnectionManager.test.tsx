// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConnectionManager } from './ConnectionManager'
import type { AuthSession } from './api'

const auth: AuthSession = { authenticated: true, principal: { id: 'p1', displayName: 'Alice', status: 'active' },
  workspace: { id: 'w1', name: 'Workspace', slug: 'workspace', role: 'owner', membershipVersion: 1 },
  applicationRole: 'admin', assuranceLevel: 'basic', csrfToken: 'csrf' }

describe('ConnectionManager', () => {
  afterEach(cleanup)
  it('switches among all Version 1 source types and provides an explicit close control', async () => {
    render(<ConnectionManager auth={auth} sources={[]} onChange={vi.fn()} onDeleted={vi.fn()} onClose={vi.fn()} />)
    expect(screen.getByText('ADMIN SETTINGS')).toBeTruthy()
    expect(screen.getByRole('button', { name: '閉じる' })).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: 'JSON / CSV' }))
    expect(document.querySelector('input[type="file"]')).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: 'DynamoDB' }))
    expect(screen.getByLabelText('Table')).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: 'CloudWatch Logs' }))
    expect(screen.getByLabelText('Log group')).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: 'SQL' }))
    expect(screen.getByLabelText('Secret ID')).toBeTruthy()
    expect(screen.getByLabelText('Table')).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: 'MongoDB' }))
    expect(screen.getByLabelText('Database')).toBeTruthy()
    expect(screen.getByLabelText('Collection')).toBeTruthy()
  })

  it('exposes test, edit, cancel edit and archive actions for an existing connection', async () => {
    render(<ConnectionManager auth={auth} sources={[{ id: 'api', name: '業務API', type: 'rest-json', baseUrl: 'https://api.example.com',
      path: '/data', method: 'GET', version: 1, accessMode: 'read-only', status: 'active' }]} onChange={vi.fn()} onDeleted={vi.fn()} onClose={vi.fn()} />)
    expect(screen.getByText('業務API')).toBeTruthy()
    expect(screen.getByRole('button', { name: '接続テスト' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '編集' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'アーカイブ' })).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: '編集' }))
    expect(screen.getByRole('button', { name: '編集をキャンセル' })).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: '編集をキャンセル' }))
    expect(screen.getByRole('button', { name: '接続を登録' })).toBeTruthy()
  })
})
