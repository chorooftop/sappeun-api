import { z } from 'zod'

import {
  boardKindSchema,
  boardModeSchema,
  boardSizeForMode,
  missionSnapshotSchema,
} from '@/boards/boards.schemas'
import {
  MAX_CLIP_DESCRIPTION_LENGTH,
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

function validateMediaBoardShape(
  value: {
    mode: z.infer<typeof boardModeSchema>
    freePosition: number
    cellIds: readonly string[]
    position: number
    cellId: string
    missionSnapshots?: readonly z.infer<typeof missionSnapshotSchema>[]
  },
  ctx: z.core.$RefinementCtx,
) {
  const boardSize = boardSizeForMode(value.mode)

  if (value.cellIds.length !== boardSize) {
    ctx.addIssue({
      code: 'custom',
      path: ['cellIds'],
      message: `${value.mode} board must contain exactly ${boardSize} cells.`,
    })
  }

  if (value.freePosition >= boardSize) {
    ctx.addIssue({
      code: 'custom',
      path: ['freePosition'],
      message: 'freePosition is outside the board.',
    })
  }

  if (value.position >= boardSize) {
    ctx.addIssue({
      code: 'custom',
      path: ['position'],
      message: 'Position is outside the board.',
    })
    return
  }

  if (value.cellIds[value.position] !== value.cellId) {
    ctx.addIssue({
      code: 'custom',
      path: ['cellId'],
      message: 'cellId must match the board position.',
    })
  }

  value.missionSnapshots?.forEach((snapshot, position) => {
    if (snapshot.id !== value.cellIds[position]) {
      ctx.addIssue({
        code: 'custom',
        path: ['missionSnapshots', position, 'id'],
        message: 'Mission snapshot id must match the cell id at the same position.',
      })
    }
  })
}

function validateClipBoardSnapshot(
  value: {
    freePosition: number
    cellIds: readonly string[]
    missionSnapshots: readonly z.infer<typeof missionSnapshotSchema>[]
  },
  ctx: z.core.$RefinementCtx,
) {
  const boardSize = value.cellIds.length

  if (boardSize !== 9 && boardSize !== 25) {
    ctx.addIssue({
      code: 'custom',
      path: ['cellIds'],
      message: 'Board snapshot must contain exactly 9 or 25 cells.',
    })
  }

  if (value.missionSnapshots.length !== boardSize) {
    ctx.addIssue({
      code: 'custom',
      path: ['missionSnapshots'],
      message: 'missionSnapshots length must match cellIds length.',
    })
  }

  if (value.freePosition >= boardSize) {
    ctx.addIssue({
      code: 'custom',
      path: ['freePosition'],
      message: 'freePosition is outside the board.',
    })
  }

  value.missionSnapshots.forEach((snapshot, position) => {
    if (snapshot.id !== value.cellIds[position]) {
      ctx.addIssue({
        code: 'custom',
        path: ['missionSnapshots', position, 'id'],
        message: 'Mission snapshot id must match the cell id at the same position.',
      })
    }
  })
}

export const presignPhotoUploadSchema = z
  .object({
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
  .superRefine(validateMediaBoardShape)

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

export const presignClipUploadSchema = z
  .object({
    clientBoardSessionId: z.string().min(1).max(120),
    mode: boardModeSchema,
    boardKind: boardKindSchema,
    nickname: z.string().trim().min(1).max(40),
    title: z.string().trim().min(1).max(24),
    description: z.string().trim().max(120).optional(),
    clipDescription: z
      .string()
      .trim()
      .max(MAX_CLIP_DESCRIPTION_LENGTH)
      .optional(),
    freePosition: z.number().int().min(0).max(24),
    cellIds: z.array(z.string().min(1).max(80)).min(9).max(25),
    missionSnapshots: z.array(missionSnapshotSchema).min(9).max(25),
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
  .superRefine(validateMediaBoardShape)

export const confirmClipUploadSchema = z.object({
  clipId: z.uuid(),
  ownerKind: clipOwnerKindSchema,
})

export const updateClipDescriptionSchema = z.object({
  ownerKind: clipOwnerKindSchema,
  description: z.string().trim().max(MAX_CLIP_DESCRIPTION_LENGTH).optional(),
  boardSnapshot: z
    .object({
      boardKind: boardKindSchema,
      title: z.string().trim().min(1).max(24),
      description: z.string().trim().max(120).optional(),
      freePosition: z.number().int().min(0).max(24),
      cellIds: z.array(z.string().min(1).max(80)).min(9).max(25),
      missionSnapshots: z.array(missionSnapshotSchema).min(9).max(25),
    })
    .superRefine(validateClipBoardSnapshot)
    .optional(),
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
