import { Controller, Delete, Param, Post, Req } from '@nestjs/common'
import type { Request } from 'express'

import { AuthService } from '@/auth/auth.service'
import { SharesService } from '@/shares/shares.service'

@Controller('shares')
export class SharesController {
  constructor(
    private readonly authService: AuthService,
    private readonly sharesService: SharesService,
  ) {}

  @Post(':boardId')
  async createShare(
    @Req() request: Request,
    @Param('boardId') boardId: string,
  ) {
    const user = await this.authService.requireUser(request)
    return this.sharesService.createBoardShare(
      user.id,
      boardId,
      `${request.protocol}://${request.get('host')}`,
    )
  }

  @Delete(':boardId')
  async deleteShare(
    @Req() request: Request,
    @Param('boardId') boardId: string,
  ) {
    const user = await this.authService.requireUser(request)
    return this.sharesService.deleteBoardShare(user.id, boardId)
  }
}

@Controller('api/share')
export class SharesCompatibilityController {
  constructor(
    private readonly authService: AuthService,
    private readonly sharesService: SharesService,
  ) {}

  @Post(':boardId')
  async createShare(
    @Req() request: Request,
    @Param('boardId') boardId: string,
  ) {
    const user = await this.authService.requireUser(request)
    return this.sharesService.createBoardShare(
      user.id,
      boardId,
      `${request.protocol}://${request.get('host')}`,
    )
  }

  @Delete(':boardId')
  async deleteShare(
    @Req() request: Request,
    @Param('boardId') boardId: string,
  ) {
    const user = await this.authService.requireUser(request)
    return this.sharesService.deleteBoardShare(user.id, boardId)
  }
}
