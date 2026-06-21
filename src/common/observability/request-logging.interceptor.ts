import {
  CallHandler,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  NestInterceptor,
} from '@nestjs/common'
import type { Request, Response } from 'express'
import { catchError, tap, throwError } from 'rxjs'

import {
  createRequestId,
  firstHeaderValue,
  writeStructuredLog,
} from '@/common/observability/structured-log'

@Injectable()
export class RequestLoggingInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler) {
    const http = context.switchToHttp()
    const request = http.getRequest<Request>()
    const response = http.getResponse<Response>()
    const startedAt = Date.now()
    const requestId =
      firstHeaderValue(request.headers['rndr-id']) ??
      firstHeaderValue(request.headers['x-request-id']) ??
      createRequestId()

    response.setHeader('x-request-id', requestId)

    return next.handle().pipe(
      tap(() => {
        this.logRequest('info', request, response, requestId, startedAt)
      }),
      catchError((error: unknown) => {
        const status = statusFromError(error)
        this.logRequest(
          status >= 500 ? 'error' : 'info',
          request,
          response,
          requestId,
          startedAt,
          status,
        )
        return throwError(() => error)
      }),
    )
  }

  private logRequest(
    level: 'info' | 'error',
    request: Request,
    response: Response,
    requestId: string,
    startedAt: number,
    status = response.statusCode,
  ) {
    writeStructuredLog(level, 'http_request_completed', {
      requestId,
      method: request.method,
      path: request.originalUrl ?? request.url,
      status,
      durationMs: Date.now() - startedAt,
    })
  }
}

function statusFromError(error: unknown) {
  return error instanceof HttpException
    ? error.getStatus()
    : HttpStatus.INTERNAL_SERVER_ERROR
}
