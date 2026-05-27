import { Module } from '@nestjs/common'

import { BoardsModule } from '@/boards/boards.module'
import {
  ClipsCompatibilityController,
  MediaController,
  PhotosCompatibilityController,
} from '@/media/media.controller'
import { MediaService } from '@/media/media.service'

@Module({
  imports: [BoardsModule],
  controllers: [
    MediaController,
    PhotosCompatibilityController,
    ClipsCompatibilityController,
  ],
  providers: [MediaService],
  exports: [MediaService],
})
export class MediaModule {}
