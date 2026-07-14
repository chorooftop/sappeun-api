import { z } from 'zod'

import {
  MAX_CLIP_DESCRIPTION_LENGTH,
  MAX_CLIP_DURATION_GRACE_MS,
  MAX_CLIP_SIZE_BYTES,
  MAX_PHOTO_SIZE_BYTES,
  MAX_POSTER_SIZE_BYTES,
} from '@/media/media.constants'
import {
  clipContentTypeSchema,
  clipOrientationSchema,
  posterContentTypeSchema,
} from '@/media/media.schemas'

// Group targets carry no client board snapshot: the board lives server-side,
// so presign only names the group + cell and the server validates the cell
// against the current group board (existing user schemas stay untouched).

export const presignGroupPhotoUploadSchema = z.object({
  groupId: z.uuid(),
  position: z.number().int().min(0).max(8),
  cellId: z.string().min(1).max(80),
  contentType: z.string().min(1).max(120),
  sizeBytes: z.number().int().min(1).max(MAX_PHOTO_SIZE_BYTES),
})

export const confirmGroupPhotoUploadSchema = z.object({
  groupId: z.uuid(),
  photoId: z.uuid(),
})

export const presignGroupClipUploadSchema = z.object({
  groupId: z.uuid(),
  position: z.number().int().min(0).max(8),
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
  clipDescription: z
    .string()
    .trim()
    .max(MAX_CLIP_DESCRIPTION_LENGTH)
    .optional(),
})

export const confirmGroupClipUploadSchema = z.object({
  groupId: z.uuid(),
  clipId: z.uuid(),
})

export type PresignGroupPhotoUploadInput = z.infer<
  typeof presignGroupPhotoUploadSchema
>
export type ConfirmGroupPhotoUploadInput = z.infer<
  typeof confirmGroupPhotoUploadSchema
>
export type PresignGroupClipUploadInput = z.infer<
  typeof presignGroupClipUploadSchema
>
export type ConfirmGroupClipUploadInput = z.infer<
  typeof confirmGroupClipUploadSchema
>
