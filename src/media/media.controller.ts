import {
  Body,
  Controller,
  Delete,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common'
import { BadRequestException } from '@nestjs/common'
import type { User } from '@supabase/supabase-js'

import { CurrentUser } from '@/auth/current-user.decorator'
import { SupabaseAuthGuard } from '@/auth/supabase-auth.guard'
import { ZodValidationPipe } from '@/common/pipes/zod-validation.pipe'
import { MediaService } from '@/media/media.service'
import {
  clipOwnerKindSchema,
  clipPreviewSchema,
  confirmClipUploadSchema,
  confirmPhotoUploadSchema,
  ownerKindSchema,
  photoPreviewSchema,
  presignClipUploadSchema,
  presignPhotoUploadSchema,
  updateClipDescriptionSchema,
  type ClipPreviewInput,
  type ConfirmClipUploadInput,
  type ConfirmPhotoUploadInput,
  type OwnerKind,
  type PhotoPreviewInput,
  type PresignClipUploadInput,
  type PresignPhotoUploadInput,
  type UpdateClipDescriptionInput,
} from '@/media/media.schemas'

function parseOwnerKind(value: unknown): OwnerKind {
  const parsed = ownerKindSchema.safeParse(value)
  if (!parsed.success) throw new BadRequestException('Invalid owner kind.')
  return parsed.data
}

@Controller('media')
@UseGuards(SupabaseAuthGuard)
export class MediaController {
  constructor(private readonly mediaService: MediaService) {}

  @Post('photos/presign')
  async presignPhoto(
    @CurrentUser() user: User,
    @Body(new ZodValidationPipe(presignPhotoUploadSchema))
    input: PresignPhotoUploadInput,
  ) {
    return this.mediaService.preparePhotoUpload({
      input,
      user,
      guestSessionId: null,
    })
  }

  @Post('photos/confirm')
  async confirmPhoto(
    @CurrentUser() user: User,
    @Body(new ZodValidationPipe(confirmPhotoUploadSchema))
    input: ConfirmPhotoUploadInput,
  ) {
    return this.mediaService.confirmPhotoUpload({
      input,
      user,
      guestSessionId: null,
    })
  }

  @Post('photos/preview')
  async previewPhotos(
    @CurrentUser() user: User,
    @Body(new ZodValidationPipe(photoPreviewSchema)) input: PhotoPreviewInput,
  ) {
    return this.mediaService.createPhotoPreviewUrls({
      input,
      user,
      guestSessionId: null,
    })
  }

  @Delete('photos/:photoId')
  async deletePhoto(
    @CurrentUser() user: User,
    @Param('photoId') photoId: string,
    @Query('ownerKind') ownerKind: string,
  ) {
    return this.mediaService.deletePhoto({
      photoId,
      ownerKind: parseOwnerKind(ownerKind),
      user,
      guestSessionId: null,
    })
  }

  @Post('clips/presign')
  async presignClip(
    @CurrentUser() user: User,
    @Body(new ZodValidationPipe(presignClipUploadSchema))
    input: PresignClipUploadInput,
  ) {
    return this.mediaService.prepareClipUpload({
      input,
      user,
      guestSessionId: null,
    })
  }

  @Post('clips/confirm')
  async confirmClip(
    @CurrentUser() user: User,
    @Body(new ZodValidationPipe(confirmClipUploadSchema))
    input: ConfirmClipUploadInput,
  ) {
    return this.mediaService.confirmClipUpload({
      input,
      user,
      guestSessionId: null,
    })
  }

  @Post('clips/preview')
  async previewClips(
    @CurrentUser() user: User,
    @Body(new ZodValidationPipe(clipPreviewSchema)) input: ClipPreviewInput,
  ) {
    return this.mediaService.createClipPreviewUrls({
      input,
      user,
      guestSessionId: null,
    })
  }

  @Patch('clips/:clipId')
  async updateClipDescription(
    @CurrentUser() user: User,
    @Param('clipId') clipId: string,
    @Body(new ZodValidationPipe(updateClipDescriptionSchema))
    input: UpdateClipDescriptionInput,
  ) {
    clipOwnerKindSchema.parse(input.ownerKind)
    return this.mediaService.updateClipDescription({
      clipId,
      input,
      user,
      guestSessionId: null,
    })
  }

  @Delete('clips/:clipId')
  async deleteClip(
    @CurrentUser() user: User,
    @Param('clipId') clipId: string,
    @Query('ownerKind') ownerKind: string,
  ) {
    return this.mediaService.deleteClip({
      clipId,
      ownerKind: parseOwnerKind(ownerKind),
      user,
      guestSessionId: null,
    })
  }
}

@Controller('api/photos')
@UseGuards(SupabaseAuthGuard)
export class PhotosCompatibilityController {
  constructor(private readonly mediaService: MediaService) {}

  @Post('presign')
  async presign(
    @CurrentUser() user: User,
    @Body(new ZodValidationPipe(presignPhotoUploadSchema))
    input: PresignPhotoUploadInput,
  ) {
    return this.mediaService.preparePhotoUpload({
      input,
      user,
      guestSessionId: null,
    })
  }

  @Post('confirm')
  async confirm(
    @CurrentUser() user: User,
    @Body(new ZodValidationPipe(confirmPhotoUploadSchema))
    input: ConfirmPhotoUploadInput,
  ) {
    return this.mediaService.confirmPhotoUpload({
      input,
      user,
      guestSessionId: null,
    })
  }

  @Post('preview')
  async preview(
    @CurrentUser() user: User,
    @Body(new ZodValidationPipe(photoPreviewSchema)) input: PhotoPreviewInput,
  ) {
    return this.mediaService.createPhotoPreviewUrls({
      input,
      user,
      guestSessionId: null,
    })
  }

  @Delete(':photoId')
  async delete(
    @CurrentUser() user: User,
    @Param('photoId') photoId: string,
    @Query('ownerKind') ownerKind: string,
  ) {
    return this.mediaService.deletePhoto({
      photoId,
      ownerKind: parseOwnerKind(ownerKind),
      user,
      guestSessionId: null,
    })
  }
}

@Controller('api/clips')
@UseGuards(SupabaseAuthGuard)
export class ClipsCompatibilityController {
  constructor(private readonly mediaService: MediaService) {}

  @Post('presign')
  async presign(
    @CurrentUser() user: User,
    @Body(new ZodValidationPipe(presignClipUploadSchema))
    input: PresignClipUploadInput,
  ) {
    return this.mediaService.prepareClipUpload({
      input,
      user,
      guestSessionId: null,
    })
  }

  @Post('confirm')
  async confirm(
    @CurrentUser() user: User,
    @Body(new ZodValidationPipe(confirmClipUploadSchema))
    input: ConfirmClipUploadInput,
  ) {
    return this.mediaService.confirmClipUpload({
      input,
      user,
      guestSessionId: null,
    })
  }

  @Post('preview')
  async preview(
    @CurrentUser() user: User,
    @Body(new ZodValidationPipe(clipPreviewSchema)) input: ClipPreviewInput,
  ) {
    return this.mediaService.createClipPreviewUrls({
      input,
      user,
      guestSessionId: null,
    })
  }

  @Patch(':clipId')
  async updateDescription(
    @CurrentUser() user: User,
    @Param('clipId') clipId: string,
    @Body(new ZodValidationPipe(updateClipDescriptionSchema))
    input: UpdateClipDescriptionInput,
  ) {
    return this.mediaService.updateClipDescription({
      clipId,
      input,
      user,
      guestSessionId: null,
    })
  }

  @Delete(':clipId')
  async delete(
    @CurrentUser() user: User,
    @Param('clipId') clipId: string,
    @Query('ownerKind') ownerKind: string,
  ) {
    return this.mediaService.deleteClip({
      clipId,
      ownerKind: parseOwnerKind(ownerKind),
      user,
      guestSessionId: null,
    })
  }
}
