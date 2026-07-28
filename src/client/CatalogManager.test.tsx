// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CatalogManager } from './CatalogManager'
import type { AuthSession, DataSource } from './api'
import type { CatalogBundle } from '../shared/catalog'

const auth: AuthSession = { authenticated: true, principal: { displayName: 'Alice' },
  workspace: { name: 'Workspace', role: 'editor' }, applicationRole: 'user', csrfToken: 'csrf' }
const sources: DataSource[] = [{ id: 'sales', name: '売上', type: 'database-table', dataModel: 'table',
  queryTemplates: [], version: 1, accessMode: 'read-only', status: 'active' }]
const definition = { sourceId: 'sales', displayName: '売上', description: '', policy: 'curated' as const, classification: 'internal' as const,
  dataModel: 'table' as const, defaultTimeField: null, relationships: [], fields: [{ path: 'amount', dataTypes: ['number' as const], nullable: false, presence: 1, repeated: false,
    businessName: '金額', description: '', unit: 'JPY', timezone: '' }] }
const canonical = { id: 'canonical-1', sourceId: 'sales', scope: 'canonical' as const, version: 1, definition,
  schemaFingerprint: 'canonical', changeSource: 'manual' as const, createdBy: 'admin', createdAt: '2026-07-22T00:00:00.000Z' }

describe('CatalogManager', () => {
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

  it('gives a general user personal edit, exploration and reset controls without canonical mutation controls', async () => {
    let personalActive = true
    const bundle = (): CatalogBundle => ({ sourceId: 'sales', canonical,
      ...(personalActive ? { personal: { ...canonical, id: 'personal-1', scope: 'personal' as const, ownerId: 'p1', version: 1,
        baseCanonicalVersion: 1, definition: { ...definition, displayName: '自分用売上' } } } : {}),
      effective: personalActive ? { ...canonical, id: 'personal-1', scope: 'personal' as const, ownerId: 'p1', version: 1,
        baseCanonicalVersion: 1, definition: { ...definition, displayName: '自分用売上' } } : canonical,
      personalOutdated: false })
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'DELETE') personalActive = false
      return Response.json(bundle())
    }))
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    const onChange = vi.fn()
    render(<CatalogManager auth={auth} sources={sources} onChange={onChange} onClose={vi.fn()} />)

    expect(await screen.findByDisplayValue('自分用売上')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Agentで探索' })).toBeTruthy()
    expect(screen.queryByRole('tab', { name: 'Workspace正本' })).toBeNull()
    expect(screen.queryByRole('button', { name: /正本を保存|正本へ反映/ })).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: '正本へ戻す' }))
    await waitFor(() => expect(screen.getByDisplayValue('売上')).toBeTruthy())
    expect(onChange).toHaveBeenCalled()
  })

  it('does not claim to return to a canonical Catalog when none exists', async () => {
    let personalActive = true
    const personal = { ...canonical, id: 'personal-1', scope: 'personal' as const, ownerId: 'p1', version: 1 }
    const bundle = (): CatalogBundle => ({ sourceId: 'sales',
      ...(personalActive ? { personal, effective: personal } : {}), personalOutdated: false })
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'DELETE') personalActive = false
      return Response.json(bundle())
    }))
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    render(<CatalogManager auth={auth} sources={sources} onClose={vi.fn()} />)

    await userEvent.click(await screen.findByRole('button', { name: '自分用Catalogを解除' }))
    expect(confirm).toHaveBeenCalledWith('自分用Catalogの利用を解除しますか？過去versionは履歴として保持されます。')
    expect(await screen.findByText('自分用Catalogの利用を解除しました。')).toBeTruthy()
  })
})
