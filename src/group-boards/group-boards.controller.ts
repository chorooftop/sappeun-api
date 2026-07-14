import {
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Post,
  UseGuards,
} from '@nestjs/common'
import type { User } from '@supabase/supabase-js'

import { CurrentUser } from '@/auth/current-user.decorator'
import { SupabaseAuthGuard } from '@/auth/supabase-auth.guard'
import { GroupBoardsService } from '@/group-boards/group-boards.service'

@Controller('connections/groups/:groupId/board')
@UseGuards(SupabaseAuthGuard)
export class GroupBoardsController {
  constructor(private readonly groupBoardsService: GroupBoardsService) {}

  @Get()
  async getBoard(@CurrentUser() user: User, @Param('groupId') groupId: string) {
    return this.groupBoardsService.getTodayBoard(user.id, groupId)
  }

  @Post('reroll')
  async reroll(@CurrentUser() user: User, @Param('groupId') groupId: string) {
    return this.groupBoardsService.rerollBoard(user.id, groupId)
  }

  @Get('cells/:position')
  async getCell(
    @CurrentUser() user: User,
    @Param('groupId') groupId: string,
    @Param('position', ParseIntPipe) position: number,
  ) {
    return this.groupBoardsService.getCell(user.id, groupId, position)
  }

  @Delete('cells/:position/media/:mediaId')
  async deleteCellMedia(
    @CurrentUser() user: User,
    @Param('groupId') groupId: string,
    @Param('mediaId') mediaId: string,
  ) {
    return this.groupBoardsService.deleteCellMedia(user.id, groupId, mediaId)
  }

  @Post('end')
  async endBoard(@CurrentUser() user: User, @Param('groupId') groupId: string) {
    return this.groupBoardsService.endBoard(user.id, groupId)
  }
}
