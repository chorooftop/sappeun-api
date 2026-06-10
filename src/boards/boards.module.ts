import { Module } from '@nestjs/common'

import { BadgesModule } from '@/badges/badges.module'
import { BoardsController } from '@/boards/boards.controller'
import { BoardsService } from '@/boards/boards.service'
import { ClockService } from '@/common/time/clock.service'

@Module({
  imports: [BadgesModule],
  controllers: [BoardsController],
  providers: [BoardsService, ClockService],
  exports: [BoardsService],
})
export class BoardsModule {}
