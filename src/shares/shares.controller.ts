import { Controller, Delete, Param, Post } from '@nestjs/common'

@Controller('shares')
export class SharesController {
  @Post(':boardId')
  createShare(@Param('boardId') boardId: string) {
    return {
      boardId,
      status: 'planned',
      message: 'Share migration is planned in Phase 3.',
    }
  }

  @Delete(':boardId')
  deleteShare(@Param('boardId') boardId: string) {
    return {
      boardId,
      status: 'planned',
      message: 'Share migration is planned in Phase 3.',
    }
  }
}
