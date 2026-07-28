// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConnectionManager } from './ConnectionManager'
import type { AdminDataSource, AuthSession } from './api'

const auth: AuthSession = { authenticated: true, principal: { displayName: 'Alice' },
  workspace: { name: 'Workspace', role: 'owner' }, applicationRole: 'admin', csrfToken: 'csrf' }

describe('ConnectionManager', () => {
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  function renderManager(sources: AdminDataSource[] = []) {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      return Response.json(url.includes('connection-profiles') ? { connections: [] } : { sources })
    }))
    render(<ConnectionManager auth={auth} onSaved={vi.fn()} onDeleted={vi.fn()} onClose={vi.fn()} />)
  }

  it('switches among all Version 1 source types and provides an explicit close control', async () => {
    renderManager()
    expect(screen.getByText('ADMIN SETTINGS')).toBeTruthy()
    expect(screen.getByRole('button', { name: '閉じる' })).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: 'JSON / CSV' }))
    expect(document.querySelector('input[type="file"]')).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: 'DynamoDB' }))
    expect(screen.getByLabelText('Table')).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: 'CloudWatch Logs' }))
    expect(screen.getByLabelText('Log group')).toBeTruthy()
    await userEvent.selectOptions(screen.getByLabelText('取得方式'), 'template-required')
    expect(screen.getByText('検索パターン')).toBeTruthy()
    expect(screen.getByDisplayValue('開始日時')).toBeTruthy()
    expect(screen.getByDisplayValue('終了日時')).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: '変数を追加' }))
    expect(screen.getByLabelText('入力方法 3')).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: '表形式DB' }))
    expect(screen.getByLabelText('接続先')).toBeTruthy()
    expect(screen.getByLabelText('Table')).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: 'JSONライクDB' }))
    expect(screen.getByLabelText('Database')).toBeTruthy()
    expect(screen.getByLabelText('Collection')).toBeTruthy()
  })

  it('exposes test, edit, cancel edit and archive actions for an existing connection', async () => {
    renderManager([{ id: 'api', name: '業務API', type: 'rest-json', baseUrl: 'https://api.example.com',
      path: '/data', method: 'GET', version: 1, accessMode: 'read-only', status: 'active' }])
    await waitFor(() => expect(screen.getByText('業務API')).toBeTruthy())
    expect(screen.getByRole('button', { name: '接続テスト' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '編集' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'アーカイブ' })).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: '編集' }))
    expect(screen.getByRole('button', { name: '編集をキャンセル' })).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: '編集をキャンセル' }))
    expect(screen.getByRole('button', { name: '接続を登録' })).toBeTruthy()
  })
})
