import { Module } from '@nestjs/common'

import { BadgesModule } from '@/badges/badges.module'
import { ClockService } from '@/common/time/clock.service'
import { ConnectionsModule } from '@/connections/connections.module'
import { GroupBoardsController } from '@/group-boards/group-boards.controller'
import { GroupBoardsService } from '@/group-boards/group-boards.service'
import { GroupMediaController } from '@/group-boards/group-media.controller'
import { GroupMediaService } from '@/group-boards/group-media.service'
import { MissionsModule } from '@/missions/missions.module'

@Module({
  imports: [BadgesModule, ConnectionsModule, MissionsModule],
  controllers: [GroupBoardsController, GroupMediaController],
  providers: [GroupBoardsService, GroupMediaService, ClockService],
  exports: [GroupBoardsService],
})
export class GroupBoardsModule {}
