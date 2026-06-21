import 'reflect-metadata'

import { ConfigService } from '@nestjs/config'
import { NestFactory } from '@nestjs/core'
import helmet from 'helmet'

import { AppModule } from '@/app.module'
import { GlobalHttpExceptionFilter } from '@/common/observability/http-exception.filter'
import { RequestLoggingInterceptor } from '@/common/observability/request-logging.interceptor'
import {
  serializeError,
  writeStructuredLog,
} from '@/common/observability/structured-log'
import type { AppEnv } from '@/config/env'

const startedAt = Date.now()

async function bootstrap() {
  writeStructuredLog('info', 'app_bootstrap_started', runtimeLogFields())
  const app = await NestFactory.create(AppModule)
  const config = app.get<ConfigService<AppEnv, true>>(ConfigService)
  const corsOrigins = config.get('CORS_ORIGINS', { infer: true })
  const apiPrefix = config.get('API_PREFIX', { infer: true })
  const port = config.get('PORT', { infer: true })

  app.use(helmet())
  app.enableShutdownHooks()
  app.useGlobalFilters(new GlobalHttpExceptionFilter())
  app.useGlobalInterceptors(new RequestLoggingInterceptor())
  app.enableCors({
    origin: corsOrigins.length > 0 ? corsOrigins : true,
    credentials: true,
  })
  app.setGlobalPrefix(apiPrefix, {
    exclude: [
      'api/profile',
      'api/photos/presign',
      'api/photos/confirm',
      'api/photos/preview',
      'api/photos/:photoId',
      'api/clips/presign',
      'api/clips/confirm',
      'api/clips/preview',
      'api/clips/:clipId',
      'api/share/:boardId',
      'api/jobs/cleanup-temp-photos',
      'api/jobs/cleanup-temp-clips',
    ],
  })

  await app.listen(port, '0.0.0.0')
  writeStructuredLog('info', 'app_listening', runtimeLogFields({ port }))
}

process.on('unhandledRejection', (reason) => {
  writeStructuredLog('fatal', 'unhandled_rejection', {
    ...runtimeLogFields(),
    error: serializeError(reason),
  })
})

process.on('uncaughtException', (error) => {
  writeStructuredLog('fatal', 'uncaught_exception', {
    ...runtimeLogFields(),
    error: serializeError(error),
  })
  process.exitCode = 1
})

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    writeStructuredLog('warn', 'process_signal_received', {
      ...runtimeLogFields(),
      signal,
    })
  })
}

void bootstrap().catch((error: unknown) => {
  writeStructuredLog('fatal', 'app_bootstrap_failed', {
    ...runtimeLogFields(),
    error: serializeError(error),
  })
  process.exitCode = 1
})

function runtimeLogFields(extra: { port?: number } = {}) {
  return {
    nodeEnv: process.env.NODE_ENV ?? null,
    port: extra.port ?? process.env.PORT ?? null,
    uptimeMs: Date.now() - startedAt,
  }
}
