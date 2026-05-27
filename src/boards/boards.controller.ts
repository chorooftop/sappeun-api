import { Body, Controller, Post, UseGuards } from '@nestjs/common'
import type { User } from '@supabase/supabase-js'

import { CurrentUser } from '@/auth/current-user.decorator'
import { SupabaseAuthGuard } from '@/auth/supabase-auth.guard'
import { BoardsService } from '@/boards/boards.service'
import {
  boardSessionSchema,
  type BoardSessionInput,
} from '@/boards/boards.schemas'
import { ZodValidationPipe } from '@/common/pipes/zod-validation.pipe'

@Controller('boards')
export class BoardsController {
  constructor(private readonly boardsService: BoardsService) {}

  @Post('session')
  @UseGuards(SupabaseAuthGuard)
  async ensureSession(
    @CurrentUser() user: User,
    @Body(new ZodValidationPipe(boardSessionSchema)) session: BoardSessionInput,
  ) {
    return this.boardsService.ensureUserBoardFromSession(user.id, session)
  }
}
