import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
} from '@nestjs/common'
import type { Request, Response } from 'express'

import {
  firstHeaderValue,
  serializeError,
  writeStructuredLog,
} from '@/common/observability/structured-log'

@Catch()
export class GlobalHttpExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp()
    const request = ctx.getRequest<Request>()
    const response = ctx.getResponse<Response>()
    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR
    const requestId =
      firstHeaderValue(request.headers['rndr-id']) ??
      firstHeaderValue(request.headers['x-request-id']) ??
      null

    if (status >= 500) {
      const error = serializeError(exception)
      writeStructuredLog('error', 'http_request_failed', {
        requestId,
        method: request.method,
        path: request.originalUrl ?? request.url,
        status,
        errorName: error.name,
        message: error.message,
        stack: error.stack,
      })
    }

    response.status(status).json(responseBody(exception, status))
  }
}

function responseBody(exception: unknown, status: number) {
  if (exception instanceof HttpException) {
    const body = exception.getResponse()
    if (typeof body === 'object' && body !== null) return body
    return {
      statusCode: status,
      message: body,
    }
  }

  return {
    statusCode: status,
    message: 'Internal server error',
  }
}
