import { Controller, Post, Req, UnauthorizedException } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import type { Request } from 'express'

import type { AppEnv } from '@/config/env'

@Controller('jobs')
export class JobsController {
  constructor(private readonly config: ConfigService<AppEnv, true>) {}

  @Post('cleanup-temp-photos')
  cleanupTempPhotos(@Req() request: Request) {
    this.assertCronAuthorized(request)
    return {
      status: 'planned',
      message: 'Photo cleanup migration is planned in Phase 5.',
    }
  }

  @Post('cleanup-temp-clips')
  cleanupTempClips(@Req() request: Request) {
    this.assertCronAuthorized(request)
    return {
      status: 'planned',
      message: 'Clip cleanup migration is planned in Phase 5.',
    }
  }

  private assertCronAuthorized(request: Request) {
    const secret = this.config.get('CRON_SECRET', { infer: true })
    if (!secret || request.headers.authorization !== `Bearer ${secret}`) {
      throw new UnauthorizedException('Unauthorized.')
    }
  }
}
