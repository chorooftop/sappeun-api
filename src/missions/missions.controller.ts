import { Controller, Get, Req } from '@nestjs/common'
import type { Request } from 'express'

import { parseClientCapabilities } from '@/common/client-capabilities'
import { MissionsService } from '@/missions/missions.service'

@Controller('missions')
export class MissionsController {
  constructor(private readonly missionsService: MissionsService) {}

  @Get('content')
  async content(@Req() request: Request) {
    return {
      ...(await this.missionsService.getMissionContent(
        undefined,
        parseClientCapabilities(request.headers),
      )),
    }
  }
}
