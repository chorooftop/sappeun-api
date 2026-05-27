import { Module } from '@nestjs/common'

import {
  BoardsCompatibilityController,
  BoardsController,
} from '@/boards/boards.controller'
import { BoardsService } from '@/boards/boards.service'

@Module({
  controllers: [BoardsController, BoardsCompatibilityController],
  providers: [BoardsService],
  exports: [BoardsService],
})
export class BoardsModule {}
