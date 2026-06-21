import { Controller, Get } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'

import type { AppEnv } from '@/config/env'

@Controller('health')
export class HealthController {
  constructor(private readonly config: ConfigService<AppEnv, true>) {}

  @Get()
  getHealth() {
    return {
      ok: true,
      service: 'sappeun-api',
      timestamp: new Date().toISOString(),
      uptimeSec: Math.floor(process.uptime()),
      nodeEnv: this.config.get('NODE_ENV', { infer: true }),
      ...(process.env.RENDER_GIT_COMMIT
        ? { commitSha: process.env.RENDER_GIT_COMMIT }
        : {}),
    }
  }
}
