import { Controller, Get } from '@nestjs/common'

import { MissionsService } from '@/missions/missions.service'

@Controller('missions')
export class MissionsController {
  constructor(private readonly missionsService: MissionsService) {}

  @Get('content')
  async content() {
    return { ...(await this.missionsService.getMissionContent()) }
  }
}
