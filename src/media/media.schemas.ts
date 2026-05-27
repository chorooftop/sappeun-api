import { z } from 'zod'

import {
  boardKindSchema,
  boardModeSchema,
  missionSnapshotSchema,
} from '@/boards/boards.schemas'
import {
  MAX_CLIP_DURATION_GRACE_MS,
  MAX_CLIP_SIZE_BYTES,
  MAX_PHOTO_SIZE_BYTES,
  MAX_POSTER_SIZE_BYTES,
} from '@/media/media.constants'

export const ownerKindSchema = z.enum(['guest', 'user'])
export const photoOwnerKindSchema = ownerKindSchema
export const clipOwnerKindSchema = ownerKindSchema
export const clipContentTypeSchema = z.enum(['video/mp4', 'video/webm'])
export const posterContentTypeSchema = z.enum(['image/jpeg', 'image/webp'])
export const clipOrientationSchema = z.enum(['portrait', 'landscape', 'square'])

export const presignPhotoUploadSchema = z.object({
  clientBoardSessionId: z.string().min(1).max(120),
  mode: boardModeSchema,
  nickname: z.string().trim().min(1).max(40),
  freePosition: z.number().int().min(0).max(24),
  cellIds: z.array(z.string().min(1).max(80)).min(9).max(25),
  position: z.number().int().min(0).max(24),
  cellId: z.string().min(1).max(80),
  contentType: z.string().min(1).max(120),
  sizeBytes: z.number().int().min(1).max(MAX_PHOTO_SIZE_BYTES),
})

export const confirmPhotoUploadSchema = z.object({
  photoId: z.uuid(),
  ownerKind: photoOwnerKindSchema,
})

export const photoPreviewSchema = z.object({
  photos: z
    .array(
      z.object({
        photoId: z.uuid(),
        ownerKind: photoOwnerKindSchema,
      }),
    )
    .min(1)
    .max(50),
})

export const presignClipUploadSchema = z.object({
  clientBoardSessionId: z.string().min(1).max(120),
  mode: boardModeSchema,
  boardKind: boardKindSchema.optional(),
  nickname: z.string().trim().min(1).max(40),
  title: z.string().trim().min(1).max(24).optional(),
  description: z.string().trim().max(120).optional(),
  clipDescription: z.string().trim().max(120).optional(),
  freePosition: z.number().int().min(0).max(24),
  cellIds: z.array(z.string().min(1).max(80)).min(9).max(25),
  missionSnapshots: z.array(missionSnapshotSchema).min(9).max(25).optional(),
  position: z.number().int().min(0).max(24),
  cellId: z.string().min(1).max(80),
  contentType: clipContentTypeSchema,
  recorderMimeType: z.string().min(1).max(160),
  sizeBytes: z.number().int().min(1).max(MAX_CLIP_SIZE_BYTES),
  durationMs: z.number().min(1).max(MAX_CLIP_DURATION_GRACE_MS),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  orientation: clipOrientationSchema.optional(),
  posterContentType: posterContentTypeSchema,
  posterSizeBytes: z.number().int().min(1).max(MAX_POSTER_SIZE_BYTES),
  posterWidth: z.number().int().positive().optional(),
  posterHeight: z.number().int().positive().optional(),
})

export const confirmClipUploadSchema = z.object({
  clipId: z.uuid(),
  ownerKind: clipOwnerKindSchema,
})

export const updateClipDescriptionSchema = z.object({
  ownerKind: clipOwnerKindSchema,
  description: z.string().trim().max(120).optional(),
})

export const clipPreviewSchema = z.object({
  clips: z
    .array(
      z.object({
        clipId: z.uuid(),
        ownerKind: clipOwnerKindSchema,
      }),
    )
    .min(1)
    .max(50),
})

export type OwnerKind = z.infer<typeof ownerKindSchema>
export type PresignPhotoUploadInput = z.infer<typeof presignPhotoUploadSchema>
export type ConfirmPhotoUploadInput = z.infer<typeof confirmPhotoUploadSchema>
export type PhotoPreviewInput = z.infer<typeof photoPreviewSchema>
export type PresignClipUploadInput = z.infer<typeof presignClipUploadSchema>
export type ConfirmClipUploadInput = z.infer<typeof confirmClipUploadSchema>
export type ClipPreviewInput = z.infer<typeof clipPreviewSchema>
export type UpdateClipDescriptionInput = z.infer<
  typeof updateClipDescriptionSchema
>
