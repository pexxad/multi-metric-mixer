import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadInitialAuth } from './api'

describe('initial authentication request', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('deduplicates concurrent checks so one-time session rotation is not raced', async () => {
    let release!: (response: Response) => void
    const response = new Promise<Response>((resolve) => { release = resolve })
    const fetchMock = vi.fn(() => response)
    vi.stubGlobal('fetch', fetchMock)

    const first = loadInitialAuth()
    const second = loadInitialAuth()
    expect(first).toBe(second)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    release(Response.json({ authenticated: false, providers: [] }, { status: 401 }))
    await expect(Promise.all([first, second])).resolves.toEqual([
      { session: null, providers: [] },
      { session: null, providers: [] },
    ])
  })
})
