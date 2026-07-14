import { Body, Controller, Post, UseGuards } from '@nestjs/common'
import type { User } from '@supabase/supabase-js'

import { CurrentUser } from '@/auth/current-user.decorator'
import { SupabaseAuthGuard } from '@/auth/supabase-auth.guard'
import { ZodValidationPipe } from '@/common/pipes/zod-validation.pipe'
import {
  confirmGroupClipUploadSchema,
  confirmGroupPhotoUploadSchema,
  presignGroupClipUploadSchema,
  presignGroupPhotoUploadSchema,
  type ConfirmGroupClipUploadInput,
  type ConfirmGroupPhotoUploadInput,
  type PresignGroupClipUploadInput,
  type PresignGroupPhotoUploadInput,
} from '@/group-boards/group-media.schemas'
import { GroupMediaService } from '@/group-boards/group-media.service'

@Controller('media/group')
@UseGuards(SupabaseAuthGuard)
export class GroupMediaController {
  constructor(private readonly groupMediaService: GroupMediaService) {}

  @Post('photos/presign')
  async presignPhoto(
    @CurrentUser() user: User,
    @Body(new ZodValidationPipe(presignGroupPhotoUploadSchema))
    input: PresignGroupPhotoUploadInput,
  ) {
    return this.groupMediaService.presignGroupPhotoUpload(user, input)
  }

  @Post('photos/confirm')
  async confirmPhoto(
    @CurrentUser() user: User,
    @Body(new ZodValidationPipe(confirmGroupPhotoUploadSchema))
    input: ConfirmGroupPhotoUploadInput,
  ) {
    return this.groupMediaService.confirmGroupPhotoUpload(user, input)
  }

  @Post('clips/presign')
  async presignClip(
    @CurrentUser() user: User,
    @Body(new ZodValidationPipe(presignGroupClipUploadSchema))
    input: PresignGroupClipUploadInput,
  ) {
    return this.groupMediaService.presignGroupClipUpload(user, input)
  }

  @Post('clips/confirm')
  async confirmClip(
    @CurrentUser() user: User,
    @Body(new ZodValidationPipe(confirmGroupClipUploadSchema))
    input: ConfirmGroupClipUploadInput,
  ) {
    return this.groupMediaService.confirmGroupClipUpload(user, input)
  }
}
