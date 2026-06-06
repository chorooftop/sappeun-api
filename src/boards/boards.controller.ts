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
  Req,
  UseGuards,
} from '@nestjs/common'
import type { User } from '@supabase/supabase-js'
import type { Request } from 'express'

import { CurrentUser } from '@/auth/current-user.decorator'
import { AuthService } from '@/auth/auth.service'
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

function assertBoardPosition(position: number) {
  if (!Number.isInteger(position) || position < 0 || position > 24) {
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
    private readonly authService: AuthService,
    private readonly boardsService: BoardsService,
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
    return {
      session: await this.boardsService.getLatestUserBoardSession(user.id),
    }
  }

  @Get('current')
  @UseGuards(SupabaseAuthGuard)
  async current(@CurrentUser() user: User) {
    return {
      session: await this.boardsService.getLatestUserBoardSession(user.id),
    }
  }

  @Delete('current')
  @UseGuards(SupabaseAuthGuard)
  async deleteCurrent(@CurrentUser() user: User) {
    await this.boardsService.deleteActiveUserBoards(user.id)
    return { ok: true }
  }

  @Post('session')
  async ensureSession(
    @Req() request: Request,
    @Body(new ZodValidationPipe(boardSessionSchema)) session: BoardSessionInput,
  ) {
    const { user } = await this.authService.resolveUser(request)
    if (!user) return { boardId: null }
    return this.boardsService.ensureUserBoardFromSession(user.id, session)
  }

  @Post('adopt-guest-session')
  @UseGuards(SupabaseAuthGuard)
  async adoptGuestSession(
    @CurrentUser() user: User,
    @Body(new ZodValidationPipe(boardSessionSchema)) session: BoardSessionInput,
  ) {
    return {
      session: await this.boardsService.adoptGuestBoardSession({
        userId: user.id,
        session,
      }),
    }
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

@Controller('api/boards')
export class BoardsCompatibilityController {
  constructor(
    private readonly authService: AuthService,
    private readonly boardsService: BoardsService,
  ) {}

  @Get()
  async list(@Req() request: Request, @Query() query: unknown) {
    const user = await this.authService.requireUser(request)
    return {
      boards: await this.boardsService.listUserBoards(
        user.id,
        parseBoardListQuery(query),
      ),
    }
  }

  @Get('active')
  async active(@Req() request: Request) {
    const user = await this.authService.requireUser(request)
    return {
      session: await this.boardsService.getLatestUserBoardSession(user.id),
    }
  }

  @Get('current')
  async current(@Req() request: Request) {
    const user = await this.authService.requireUser(request)
    return {
      session: await this.boardsService.getLatestUserBoardSession(user.id),
    }
  }

  @Delete('current')
  async deleteCurrent(@Req() request: Request) {
    const user = await this.authService.requireUser(request)
    await this.boardsService.deleteActiveUserBoards(user.id)
    return { ok: true }
  }

  @Post('session')
  async ensureSession(
    @Req() request: Request,
    @Body(new ZodValidationPipe(boardSessionSchema)) session: BoardSessionInput,
  ) {
    const { user } = await this.authService.resolveUser(request)
    if (!user) return { boardId: null }
    return this.boardsService.ensureUserBoardFromSession(user.id, session)
  }

  @Post('adopt-guest-session')
  async adoptGuestSession(
    @Req() request: Request,
    @Body(new ZodValidationPipe(boardSessionSchema)) session: BoardSessionInput,
  ) {
    const user = await this.authService.requireUser(request)
    return {
      session: await this.boardsService.adoptGuestBoardSession({
        userId: user.id,
        session,
      }),
    }
  }

  @Get(':boardId')
  async detail(@Req() request: Request, @Param('boardId') boardId: string) {
    const user = await this.authService.requireUser(request)
    const board = await this.boardsService.getUserBoardDetail(user.id, boardId)
    if (!board) throw new NotFoundException('Board not found.')
    return { board }
  }

  @Delete(':boardId')
  async delete(@Req() request: Request, @Param('boardId') boardId: string) {
    const user = await this.authService.requireUser(request)
    return { ok: await this.boardsService.deleteUserBoard(user.id, boardId) }
  }

  @Post(':boardId/end')
  async end(@Req() request: Request, @Param('boardId') boardId: string) {
    const user = await this.authService.requireUser(request)
    return {
      ok: true,
      board: await this.boardsService.endUserBoard(user.id, boardId),
    }
  }

  @Patch(':boardId/cells/:position')
  async markCell(
    @Req() request: Request,
    @Param('boardId') boardId: string,
    @Param('position', ParseIntPipe) position: number,
    @Body(new ZodValidationPipe(markBoardCellSchema))
    input: { cellId: string; marked: boolean },
  ) {
    const user = await this.authService.requireUser(request)
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
  async replaceCell(
    @Req() request: Request,
    @Param('boardId') boardId: string,
    @Param('position', ParseIntPipe) position: number,
    @Body(new ZodValidationPipe(replaceBoardCellSchema))
    input: { cellId: string },
  ) {
    const user = await this.authService.requireUser(request)
    await this.boardsService.replaceUserBoardCell({
      userId: user.id,
      boardId,
      position: assertBoardPosition(position),
      cellId: input.cellId,
    })
    return { ok: true }
  }
}
