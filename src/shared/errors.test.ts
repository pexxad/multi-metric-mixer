import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { toProblemDetails } from './errors'

describe('toProblemDetails', () => {
  it('reports schema validation failures as client errors', () => {
    let error: unknown
    try {
      z.object({ operation: z.string().min(1) }).parse({})
    } catch (caught) {
      error = caught
    }

    expect(toProblemDetails(error, 'request-1')).toMatchObject({
      status: 400,
      code: 'invalid_request',
      requestId: 'request-1',
    })
  })

  it('reports malformed JSON without exposing parser internals', () => {
    let error: unknown
    try {
      JSON.parse('{')
    } catch (caught) {
      error = caught
    }

    expect(toProblemDetails(error)).toEqual({
      type: 'https://multi-metric-mixer.example/problems/invalid_json',
      title: 'JSONの形式が正しくありません。',
      status: 400,
      code: 'invalid_json',
      detail: 'JSONの構文を確認してください。',
      requestId: undefined,
    })
  })
})
