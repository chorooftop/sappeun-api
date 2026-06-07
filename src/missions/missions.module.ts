import { Module } from '@nestjs/common'

import { MissionsController } from '@/missions/missions.controller'
import { MissionsService } from '@/missions/missions.service'

@Module({
  controllers: [MissionsController],
  providers: [MissionsService],
  exports: [MissionsService],
})
export class MissionsModule {}
