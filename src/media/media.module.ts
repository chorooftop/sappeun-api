import { Module } from '@nestjs/common'

import { BoardsModule } from '@/boards/boards.module'
import { MediaController } from '@/media/media.controller'
import { MediaService } from '@/media/media.service'

@Module({
  imports: [BoardsModule],
  controllers: [MediaController],
  providers: [MediaService],
  exports: [MediaService],
})
export class MediaModule {}
