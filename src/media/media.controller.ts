import {
  Body,
  Controller,
  Delete,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common'
import { BadRequestException } from '@nestjs/common'
import type { Request } from 'express'

import { AuthService } from '@/auth/auth.service'
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
export class MediaController {
  constructor(
    private readonly authService: AuthService,
    private readonly mediaService: MediaService,
  ) {}

  @Post('photos/presign')
  async presignPhoto(
    @Req() request: Request,
    @Body(new ZodValidationPipe(presignPhotoUploadSchema))
    input: PresignPhotoUploadInput,
  ) {
    const { user } = await this.authService.resolveUser(request)
    const guestSession = this.authService.resolveOrCreateGuestSession(request)
    return this.mediaService.preparePhotoUpload({
      input,
      user,
      guestSessionId: guestSession.guestSessionId!,
    })
  }

  @Post('photos/confirm')
  async confirmPhoto(
    @Req() request: Request,
    @Body(new ZodValidationPipe(confirmPhotoUploadSchema))
    input: ConfirmPhotoUploadInput,
  ) {
    const { user } = await this.authService.resolveUser(request)
    const guestSession = this.authService.getGuestSession(request)
    return this.mediaService.confirmPhotoUpload({
      input,
      user,
      guestSessionId: guestSession.guestSessionId,
    })
  }

  @Post('photos/preview')
  async previewPhotos(
    @Req() request: Request,
    @Body(new ZodValidationPipe(photoPreviewSchema)) input: PhotoPreviewInput,
  ) {
    const { user } = await this.authService.resolveUser(request)
    const guestSession = this.authService.getGuestSession(request)
    return this.mediaService.createPhotoPreviewUrls({
      input,
      user,
      guestSessionId: guestSession.guestSessionId,
    })
  }

  @Delete('photos/:photoId')
  async deletePhoto(
    @Req() request: Request,
    @Param('photoId') photoId: string,
    @Query('ownerKind') ownerKind: string,
  ) {
    const { user } = await this.authService.resolveUser(request)
    const guestSession = this.authService.getGuestSession(request)
    return this.mediaService.deletePhoto({
      photoId,
      ownerKind: parseOwnerKind(ownerKind),
      user,
      guestSessionId: guestSession.guestSessionId,
    })
  }

  @Post('photos/promote-guest')
  async promoteGuestPhotos(@Req() request: Request) {
    const user = await this.authService.requireUser(request)
    const guestSession = this.authService.getGuestSession(request)
    return this.mediaService.promoteGuestPhotosForUser({
      userId: user.id,
      guestSessionId: guestSession.guestSessionId,
    })
  }

  @Post('clips/presign')
  async presignClip(
    @Req() request: Request,
    @Body(new ZodValidationPipe(presignClipUploadSchema))
    input: PresignClipUploadInput,
  ) {
    const { user } = await this.authService.resolveUser(request)
    const guestSession = this.authService.resolveOrCreateGuestSession(request)
    return this.mediaService.prepareClipUpload({
      input,
      user,
      guestSessionId: guestSession.guestSessionId!,
    })
  }

  @Post('clips/confirm')
  async confirmClip(
    @Req() request: Request,
    @Body(new ZodValidationPipe(confirmClipUploadSchema))
    input: ConfirmClipUploadInput,
  ) {
    const { user } = await this.authService.resolveUser(request)
    const guestSession = this.authService.getGuestSession(request)
    return this.mediaService.confirmClipUpload({
      input,
      user,
      guestSessionId: guestSession.guestSessionId,
    })
  }

  @Post('clips/preview')
  async previewClips(
    @Req() request: Request,
    @Body(new ZodValidationPipe(clipPreviewSchema)) input: ClipPreviewInput,
  ) {
    const { user } = await this.authService.resolveUser(request)
    const guestSession = this.authService.getGuestSession(request)
    return this.mediaService.createClipPreviewUrls({
      input,
      user,
      guestSessionId: guestSession.guestSessionId,
    })
  }

  @Patch('clips/:clipId')
  async updateClipDescription(
    @Req() request: Request,
    @Param('clipId') clipId: string,
    @Body(new ZodValidationPipe(updateClipDescriptionSchema))
    input: UpdateClipDescriptionInput,
  ) {
    clipOwnerKindSchema.parse(input.ownerKind)
    const { user } = await this.authService.resolveUser(request)
    const guestSession = this.authService.getGuestSession(request)
    return this.mediaService.updateClipDescription({
      clipId,
      input,
      user,
      guestSessionId: guestSession.guestSessionId,
    })
  }

  @Delete('clips/:clipId')
  async deleteClip(
    @Req() request: Request,
    @Param('clipId') clipId: string,
    @Query('ownerKind') ownerKind: string,
  ) {
    const { user } = await this.authService.resolveUser(request)
    const guestSession = this.authService.getGuestSession(request)
    return this.mediaService.deleteClip({
      clipId,
      ownerKind: parseOwnerKind(ownerKind),
      user,
      guestSessionId: guestSession.guestSessionId,
    })
  }

  @Post('clips/promote-guest')
  async promoteGuestClips(@Req() request: Request) {
    const user = await this.authService.requireUser(request)
    const guestSession = this.authService.getGuestSession(request)
    return this.mediaService.promoteGuestClipsForUser({
      userId: user.id,
      guestSessionId: guestSession.guestSessionId,
    })
  }
}

@Controller('api/photos')
export class PhotosCompatibilityController {
  constructor(
    private readonly authService: AuthService,
    private readonly mediaService: MediaService,
  ) {}

  @Post('presign')
  async presign(
    @Req() request: Request,
    @Body(new ZodValidationPipe(presignPhotoUploadSchema))
    input: PresignPhotoUploadInput,
  ) {
    const { user } = await this.authService.resolveUser(request)
    const guestSession = this.authService.resolveOrCreateGuestSession(request)
    return this.mediaService.preparePhotoUpload({
      input,
      user,
      guestSessionId: guestSession.guestSessionId!,
    })
  }

  @Post('confirm')
  async confirm(
    @Req() request: Request,
    @Body(new ZodValidationPipe(confirmPhotoUploadSchema))
    input: ConfirmPhotoUploadInput,
  ) {
    const { user } = await this.authService.resolveUser(request)
    const guestSession = this.authService.getGuestSession(request)
    return this.mediaService.confirmPhotoUpload({
      input,
      user,
      guestSessionId: guestSession.guestSessionId,
    })
  }

  @Post('preview')
  async preview(
    @Req() request: Request,
    @Body(new ZodValidationPipe(photoPreviewSchema)) input: PhotoPreviewInput,
  ) {
    const { user } = await this.authService.resolveUser(request)
    const guestSession = this.authService.getGuestSession(request)
    return this.mediaService.createPhotoPreviewUrls({
      input,
      user,
      guestSessionId: guestSession.guestSessionId,
    })
  }

  @Post('promote-guest')
  async promoteGuest(@Req() request: Request) {
    const user = await this.authService.requireUser(request)
    const guestSession = this.authService.getGuestSession(request)
    return this.mediaService.promoteGuestPhotosForUser({
      userId: user.id,
      guestSessionId: guestSession.guestSessionId,
    })
  }

  @Delete(':photoId')
  async delete(
    @Req() request: Request,
    @Param('photoId') photoId: string,
    @Query('ownerKind') ownerKind: string,
  ) {
    const { user } = await this.authService.resolveUser(request)
    const guestSession = this.authService.getGuestSession(request)
    return this.mediaService.deletePhoto({
      photoId,
      ownerKind: parseOwnerKind(ownerKind),
      user,
      guestSessionId: guestSession.guestSessionId,
    })
  }
}

@Controller('api/clips')
export class ClipsCompatibilityController {
  constructor(
    private readonly authService: AuthService,
    private readonly mediaService: MediaService,
  ) {}

  @Post('presign')
  async presign(
    @Req() request: Request,
    @Body(new ZodValidationPipe(presignClipUploadSchema))
    input: PresignClipUploadInput,
  ) {
    const { user } = await this.authService.resolveUser(request)
    const guestSession = this.authService.resolveOrCreateGuestSession(request)
    return this.mediaService.prepareClipUpload({
      input,
      user,
      guestSessionId: guestSession.guestSessionId!,
    })
  }

  @Post('confirm')
  async confirm(
    @Req() request: Request,
    @Body(new ZodValidationPipe(confirmClipUploadSchema))
    input: ConfirmClipUploadInput,
  ) {
    const { user } = await this.authService.resolveUser(request)
    const guestSession = this.authService.getGuestSession(request)
    return this.mediaService.confirmClipUpload({
      input,
      user,
      guestSessionId: guestSession.guestSessionId,
    })
  }

  @Post('preview')
  async preview(
    @Req() request: Request,
    @Body(new ZodValidationPipe(clipPreviewSchema)) input: ClipPreviewInput,
  ) {
    const { user } = await this.authService.resolveUser(request)
    const guestSession = this.authService.getGuestSession(request)
    return this.mediaService.createClipPreviewUrls({
      input,
      user,
      guestSessionId: guestSession.guestSessionId,
    })
  }

  @Post('promote-guest')
  async promoteGuest(@Req() request: Request) {
    const user = await this.authService.requireUser(request)
    const guestSession = this.authService.getGuestSession(request)
    return this.mediaService.promoteGuestClipsForUser({
      userId: user.id,
      guestSessionId: guestSession.guestSessionId,
    })
  }

  @Patch(':clipId')
  async updateDescription(
    @Req() request: Request,
    @Param('clipId') clipId: string,
    @Body(new ZodValidationPipe(updateClipDescriptionSchema))
    input: UpdateClipDescriptionInput,
  ) {
    const { user } = await this.authService.resolveUser(request)
    const guestSession = this.authService.getGuestSession(request)
    return this.mediaService.updateClipDescription({
      clipId,
      input,
      user,
      guestSessionId: guestSession.guestSessionId,
    })
  }

  @Delete(':clipId')
  async delete(
    @Req() request: Request,
    @Param('clipId') clipId: string,
    @Query('ownerKind') ownerKind: string,
  ) {
    const { user } = await this.authService.resolveUser(request)
    const guestSession = this.authService.getGuestSession(request)
    return this.mediaService.deleteClip({
      clipId,
      ownerKind: parseOwnerKind(ownerKind),
      user,
      guestSessionId: guestSession.guestSessionId,
    })
  }
}
