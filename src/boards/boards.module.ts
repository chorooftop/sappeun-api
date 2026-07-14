import { Module } from '@nestjs/common'

import { BadgesModule } from '@/badges/badges.module'
import { BoardsController } from '@/boards/boards.controller'
import { BoardsService } from '@/boards/boards.service'
import { StreakService } from '@/boards/streak.service'
import { ClockService } from '@/common/time/clock.service'
import { GroupBoardsModule } from '@/group-boards/group-boards.module'

@Module({
  imports: [BadgesModule, GroupBoardsModule],
  controllers: [BoardsController],
  providers: [BoardsService, ClockService, StreakService],
  exports: [BoardsService, StreakService],
})
export class BoardsModule {}
