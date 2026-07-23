export type ProblemDetails = {
  type: string
  title: string
  status: number
  code: string
  detail?: string
  requestId?: string
  errors?: unknown
}

export class AppError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
    readonly details?: unknown,
    readonly expose = status < 500,
  ) {
    super(message)
    this.name = 'AppError'
  }
}

export function toProblemDetails(error: unknown, requestId?: string): ProblemDetails {
  if (error instanceof AppError) {
    return {
      type: `https://multi-metric-mixer.example/problems/${error.code}`,
      title: error.expose ? error.message : 'Internal server error',
      status: error.status,
      code: error.code,
      detail: error.expose ? error.message : undefined,
      requestId,
      errors: error.expose ? error.details : undefined,
    }
  }
  return {
    type: 'https://multi-metric-mixer.example/problems/internal_error',
    title: 'Internal server error',
    status: 500,
    code: 'internal_error',
    requestId,
  }
}

