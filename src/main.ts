import 'reflect-metadata'

import { ConfigService } from '@nestjs/config'
import { NestFactory } from '@nestjs/core'
import helmet from 'helmet'

import { AppModule } from '@/app.module'
import type { AppEnv } from '@/config/env'

async function bootstrap() {
  const app = await NestFactory.create(AppModule)
  const config = app.get<ConfigService<AppEnv, true>>(ConfigService)
  const corsOrigins = config.get('CORS_ORIGINS', { infer: true })
  const apiPrefix = config.get('API_PREFIX', { infer: true })
  const port = config.get('PORT', { infer: true })

  app.use(helmet())
  app.enableShutdownHooks()
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
}

void bootstrap()
