import { Module } from '@nestjs/common'

import { BadgesModule } from '@/badges/badges.module'
import {
  BoardsCompatibilityController,
  BoardsController,
} from '@/boards/boards.controller'
import { BoardsService } from '@/boards/boards.service'

@Module({
  imports: [BadgesModule],
  controllers: [BoardsController, BoardsCompatibilityController],
  providers: [BoardsService],
  exports: [BoardsService],
})
export class BoardsModule {}
