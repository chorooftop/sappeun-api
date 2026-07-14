import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common'
import type { User } from '@supabase/supabase-js'

import { CurrentUser } from '@/auth/current-user.decorator'
import { SupabaseAuthGuard } from '@/auth/supabase-auth.guard'
import { BoardsService } from '@/boards/boards.service'
import {
  boardListQuerySchema,
  boardSessionSchema,
  editBoardCellMissionSchema,
  endBoardSchema,
  markBoardCellSchema,
  replaceBoardCellSchema,
  restoreBoardCellMissionSchema,
  updateBoardTitleSchema,
  type BoardListQueryInput,
  type BoardSessionInput,
  type EditBoardCellMissionInput,
  type EndBoardInput,
  type RestoreBoardCellMissionInput,
  type UpdateBoardTitleInput,
} from '@/boards/boards.schemas'
import { ZodValidationPipe } from '@/common/pipes/zod-validation.pipe'
import { GroupBoardsService } from '@/group-boards/group-boards.service'

function assertBoardPosition(position: number) {
  if (!Number.isInteger(position) || position < 0 || position > 8) {
    throw new BadRequestException('Invalid position.')
  }
  return position
}

function parseBoardListQuery(query: unknown): BoardListQueryInput {
  const parsed = boardListQuerySchema.safeParse(query)
  if (parsed.success) return parsed.data

  throw new BadRequestException({
    error: 'Invalid request query.',
    issues: parsed.error.issues.map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message,
    })),
  })
}

@Controller('boards')
export class BoardsController {
  constructor(
    private readonly boardsService: BoardsService,
    private readonly groupBoardsService: GroupBoardsService,
  ) {}

  @Get()
  @UseGuards(SupabaseAuthGuard)
  async list(@CurrentUser() user: User, @Query() query: unknown) {
    return {
      boards: await this.boardsService.listUserBoards(
        user.id,
        parseBoardListQuery(query),
      ),
    }
  }

  @Get('active')
  @UseGuards(SupabaseAuthGuard)
  async active(@CurrentUser() user: User) {
    return this.boardsService.getActiveUserBoardState(user.id)
  }

  @Get('current')
  @UseGuards(SupabaseAuthGuard)
  async current(@CurrentUser() user: User) {
    return this.boardsService.getActiveUserBoardState(user.id)
  }

  // AC-16: one call for everything playable today (personal + group boards).
  // Must stay above the ':boardId' route so 'home' is not captured as an id.
  @Get('home')
  @UseGuards(SupabaseAuthGuard)
  async home(@CurrentUser() user: User) {
    const [personalBoard, groupBoards] = await Promise.all([
      this.boardsService.getActiveUserBoardState(user.id),
      this.groupBoardsService.getHomeSummaries(user.id),
    ])
    return { personalBoard, groupBoards }
  }

  @Delete('current')
  @UseGuards(SupabaseAuthGuard)
  async deleteCurrent(@CurrentUser() user: User) {
    await this.boardsService.deleteActiveUserBoards(user.id)
    return { ok: true }
  }

  @Post('session')
  @UseGuards(SupabaseAuthGuard)
  async ensureSession(
    @CurrentUser() user: User,
    @Body(new ZodValidationPipe(boardSessionSchema)) session: BoardSessionInput,
  ) {
    return this.boardsService.ensureUserBoardFromSession(user.id, session)
  }

  @Get(':boardId')
  @UseGuards(SupabaseAuthGuard)
  async detail(@CurrentUser() user: User, @Param('boardId') boardId: string) {
    const board = await this.boardsService.getUserBoardDetail(user.id, boardId)
    if (!board) throw new NotFoundException('Board not found.')
    return { board }
  }

  @Delete(':boardId')
  @UseGuards(SupabaseAuthGuard)
  async delete(@CurrentUser() user: User, @Param('boardId') boardId: string) {
    return { ok: await this.boardsService.deleteUserBoard(user.id, boardId) }
  }

  @Post(':boardId/end')
  @UseGuards(SupabaseAuthGuard)
  async end(
    @CurrentUser() user: User,
    @Param('boardId') boardId: string,
    @Body(new ZodValidationPipe(endBoardSchema)) body: EndBoardInput,
  ) {
    return {
      ok: true,
      board: await this.boardsService.endUserBoard(user.id, boardId, body),
    }
  }

  @Post(':boardId/reroll')
  @UseGuards(SupabaseAuthGuard)
  async reroll(@CurrentUser() user: User, @Param('boardId') boardId: string) {
    return this.boardsService.ackBoardReroll(user.id, boardId)
  }

  @Patch(':boardId/title')
  @UseGuards(SupabaseAuthGuard)
  async updateTitle(
    @CurrentUser() user: User,
    @Param('boardId') boardId: string,
    @Body(new ZodValidationPipe(updateBoardTitleSchema))
    input: UpdateBoardTitleInput,
  ) {
    return {
      ok: true,
      board: await this.boardsService.updateBoardTitle(user.id, boardId, input),
    }
  }

  @Patch(':boardId/cells/:position/mission')
  @UseGuards(SupabaseAuthGuard)
  async editCellMission(
    @CurrentUser() user: User,
    @Param('boardId') boardId: string,
    @Param('position', ParseIntPipe) position: number,
    @Body(new ZodValidationPipe(editBoardCellMissionSchema))
    input: EditBoardCellMissionInput,
  ) {
    return this.boardsService.editBoardCellMission(
      user.id,
      boardId,
      assertBoardPosition(position),
      input,
    )
  }

  @Post(':boardId/cells/:position/mission/restore')
  @UseGuards(SupabaseAuthGuard)
  async restoreCellMission(
    @CurrentUser() user: User,
    @Param('boardId') boardId: string,
    @Param('position', ParseIntPipe) position: number,
    @Body(new ZodValidationPipe(restoreBoardCellMissionSchema))
    input: RestoreBoardCellMissionInput,
  ) {
    return this.boardsService.restoreBoardCellMission(
      user.id,
      boardId,
      assertBoardPosition(position),
      input,
    )
  }

  @Patch(':boardId/cells/:position')
  @UseGuards(SupabaseAuthGuard)
  async markCell(
    @CurrentUser() user: User,
    @Param('boardId') boardId: string,
    @Param('position', ParseIntPipe) position: number,
    @Body(new ZodValidationPipe(markBoardCellSchema))
    input: { cellId: string; marked: boolean },
  ) {
    await this.boardsService.markUserBoardCell({
      userId: user.id,
      boardId,
      position: assertBoardPosition(position),
      cellId: input.cellId,
      marked: input.marked,
    })
    return { ok: true }
  }

  @Post(':boardId/cells/:position')
  @UseGuards(SupabaseAuthGuard)
  async replaceCell(
    @CurrentUser() user: User,
    @Param('boardId') boardId: string,
    @Param('position', ParseIntPipe) position: number,
    @Body(new ZodValidationPipe(replaceBoardCellSchema))
    input: { cellId: string },
  ) {
    await this.boardsService.replaceUserBoardCell({
      userId: user.id,
      boardId,
      position: assertBoardPosition(position),
      cellId: input.cellId,
    })
    return { ok: true }
  }
}
