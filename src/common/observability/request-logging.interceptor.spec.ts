import {
  BadRequestException,
  type CallHandler,
  type ExecutionContext,
} from '@nestjs/common'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Observable, of, throwError } from 'rxjs'

import { RequestLoggingInterceptor } from '@/common/observability/request-logging.interceptor'

describe('RequestLoggingInterceptor', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('logs successful requests with the Render request id', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined)
    const response = responseStub(200)
    const interceptor = new RequestLoggingInterceptor()

    await lastValueFrom(
      interceptor.intercept(
        context(response, { 'rndr-id': 'render-request-id' }),
        handler(of({ ok: true })),
      ),
    )

    expect(response.setHeader).toHaveBeenCalledWith(
      'x-request-id',
      'render-request-id',
    )
    expect(JSON.parse(info.mock.calls[0]?.[0] as string)).toMatchObject({
      level: 'info',
      event: 'http_request_completed',
      requestId: 'render-request-id',
      method: 'GET',
      path: '/v1/health',
      status: 200,
    })
  })

  it('logs failed requests and rethrows the original error', async () => {
    const errorLog = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined)
    const response = responseStub(500)
    const interceptor = new RequestLoggingInterceptor()
    const error = new Error('boom')

    await expect(
      lastValueFrom(
        interceptor.intercept(context(response), handler(throwError(() => error))),
      ),
    ).rejects.toBe(error)

    expect(response.setHeader).toHaveBeenCalledWith(
      'x-request-id',
      expect.any(String),
    )
    expect(JSON.parse(errorLog.mock.calls[0]?.[0] as string)).toMatchObject({
      level: 'error',
      event: 'http_request_completed',
      method: 'GET',
      path: '/v1/health',
      status: 500,
    })
  })

  it('logs 4xx exceptions without using error level', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined)
    const errorLog = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined)
    const response = responseStub(200)
    const interceptor = new RequestLoggingInterceptor()

    await expect(
      lastValueFrom(
        interceptor.intercept(
          context(response),
          handler(throwError(() => new BadRequestException('bad input'))),
        ),
      ),
    ).rejects.toBeInstanceOf(BadRequestException)

    expect(errorLog).not.toHaveBeenCalled()
    expect(JSON.parse(info.mock.calls[0]?.[0] as string)).toMatchObject({
      level: 'info',
      event: 'http_request_completed',
      status: 400,
    })
  })
})

function context(
  response: ReturnType<typeof responseStub>,
  headers: Record<string, string> = {},
) {
  return {
    switchToHttp: () => ({
      getRequest: () => ({
        method: 'GET',
        originalUrl: '/v1/health',
        headers,
      }),
      getResponse: () => response,
    }),
  } as unknown as ExecutionContext
}

function responseStub(statusCode: number) {
  return {
    statusCode,
    setHeader: vi.fn(),
  }
}

function handler(source: Observable<unknown>): CallHandler {
  return {
    handle: () => source,
  }
}

function lastValueFrom<T>(source: Observable<T>) {
  return new Promise<T>((resolve, reject) => {
    let lastValue: T
    source.subscribe({
      next: (value) => {
        lastValue = value
      },
      error: reject,
      complete: () => resolve(lastValue),
    })
  })
}
