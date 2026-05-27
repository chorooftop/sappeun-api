import {
  Controller,
  Get,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import type { Request } from 'express'

import type { AppEnv } from '@/config/env'
import { MediaService } from '@/media/media.service'

@Controller('jobs')
export class JobsController {
  constructor(
    private readonly config: ConfigService<AppEnv, true>,
    private readonly mediaService: MediaService,
  ) {}

  @Post('cleanup-temp-photos')
  async cleanupTempPhotos(@Req() request: Request) {
    this.assertCronAuthorized(request)
    return this.mediaService.cleanupExpiredGuestPhotos()
  }

  @Post('cleanup-temp-clips')
  async cleanupTempClips(@Req() request: Request) {
    this.assertCronAuthorized(request)
    return this.mediaService.cleanupExpiredGuestClips()
  }

  private assertCronAuthorized(request: Request) {
    const secret = this.config.get('CRON_SECRET', { infer: true })
    const querySecret =
      typeof request.query.secret === 'string' ? request.query.secret : null

    if (
      !secret ||
      (request.headers.authorization !== `Bearer ${secret}` &&
        querySecret !== secret)
    ) {
      throw new UnauthorizedException('Unauthorized.')
    }
  }
}

@Controller('api/jobs')
export class JobsCompatibilityController {
  constructor(
    private readonly config: ConfigService<AppEnv, true>,
    private readonly mediaService: MediaService,
  ) {}

  @Get('cleanup-temp-photos')
  async cleanupTempPhotos(@Req() request: Request) {
    this.assertCronAuthorized(request)
    return this.mediaService.cleanupExpiredGuestPhotos()
  }

  @Get('cleanup-temp-clips')
  async cleanupTempClips(@Req() request: Request) {
    this.assertCronAuthorized(request)
    return this.mediaService.cleanupExpiredGuestClips()
  }

  private assertCronAuthorized(request: Request) {
    const secret = this.config.get('CRON_SECRET', { infer: true })
    const querySecret =
      typeof request.query.secret === 'string' ? request.query.secret : null

    if (
      !secret ||
      (request.headers.authorization !== `Bearer ${secret}` &&
        querySecret !== secret)
    ) {
      throw new UnauthorizedException('Unauthorized.')
    }
  }
}
