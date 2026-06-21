import { HttpException, InternalServerErrorException } from '@nestjs/common'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { GlobalHttpExceptionFilter } from '@/common/observability/http-exception.filter'

describe('GlobalHttpExceptionFilter', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('logs 5xx exceptions and preserves the response status', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const json = vi.fn()
    const status = vi.fn(() => ({ json }))
    const filter = new GlobalHttpExceptionFilter()

    filter.catch(
      new InternalServerErrorException('database unavailable'),
      host(status),
    )

    expect(status).toHaveBeenCalledWith(500)
    expect(json).toHaveBeenCalledWith({
      statusCode: 500,
      message: 'database unavailable',
      error: 'Internal Server Error',
    })
    expect(error).toHaveBeenCalledTimes(1)
    expect(JSON.parse(error.mock.calls[0]?.[0] as string)).toMatchObject({
      level: 'error',
      event: 'http_request_failed',
      requestId: 'render-request-id',
      method: 'GET',
      path: '/v1/example',
      status: 500,
      errorName: 'InternalServerErrorException',
    })
  })

  it('does not error-log expected 4xx exceptions', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const json = vi.fn()
    const status = vi.fn(() => ({ json }))
    const filter = new GlobalHttpExceptionFilter()

    filter.catch(new HttpException('Nope', 404), host(status))

    expect(status).toHaveBeenCalledWith(404)
    expect(error).not.toHaveBeenCalled()
  })
})

function host(status: ReturnType<typeof vi.fn>) {
  return {
    switchToHttp: () => ({
      getRequest: () => ({
        method: 'GET',
        originalUrl: '/v1/example',
        headers: {
          'rndr-id': 'render-request-id',
        },
      }),
      getResponse: () => ({
        status,
      }),
    }),
  } as never
}
