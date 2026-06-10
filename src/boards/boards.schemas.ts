import { z } from 'zod'

import { MAX_CLIP_DESCRIPTION_LENGTH } from '@/media/media.constants'

export const boardModeSchema = z.literal('3x3')
export const boardKindSchema = z.enum(['mission', 'custom'])
export const boardListStatusSchema = z.enum(['completed', 'active', 'all'])
const queryBooleanSchema = z.preprocess((value) => {
  if (value === undefined) return undefined
  if (value === true || value === 'true') return true
  if (value === false || value === 'false') return false
  return value
}, z.boolean())

export const boardListQuerySchema = z.object({
  status: boardListStatusSchema.default('all'),
  limit: z.coerce.number().int().min(1).max(50).default(50),
  includePreview: queryBooleanSchema.default(false),
})

export function boardSizeForMode(mode: unknown) {
  if (mode !== '3x3') {
    throw new Error('BOARD_MODE_UNSUPPORTED')
  }
  return 9
}

function validateCellIdentity(
  ctx: z.core.$RefinementCtx,
  params: {
    path: PropertyKey[]
    cellIds: readonly string[]
    position: number
    cellId: string
  },
) {
  const expectedCellId = params.cellIds[params.position]

  if (!expectedCellId) {
    ctx.addIssue({
      code: 'custom',
      path: [...params.path, 'position'],
      message: 'Position is outside the board.',
    })
    return
  }

  if (expectedCellId !== params.cellId) {
    ctx.addIssue({
      code: 'custom',
      path: [...params.path, 'cellId'],
      message: 'cellId must match the board position.',
    })
  }
}

function validateBoardShape(
  value: {
    mode: z.infer<typeof boardModeSchema>
    boardKind?: z.infer<typeof boardKindSchema>
    freePosition: number
    cellIds: readonly string[]
    missionSnapshots?: readonly z.infer<typeof missionSnapshotSchema>[]
    markedPositions?: readonly number[]
    photos?: readonly { position: number; cellId: string }[]
    clips?: readonly { position: number; cellId: string }[]
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

  value.markedPositions?.forEach((position, index) => {
    if (position >= boardSize) {
      ctx.addIssue({
        code: 'custom',
        path: ['markedPositions', index],
        message: 'Marked position is outside the board.',
      })
    }
  })

  const missionSnapshots = value.missionSnapshots
  if (missionSnapshots?.length) {
    if (missionSnapshots.length !== boardSize) {
      ctx.addIssue({
        code: 'custom',
        path: ['missionSnapshots'],
        message: `${value.mode} board must contain exactly ${boardSize} mission snapshots.`,
      })
    }

    missionSnapshots.forEach((snapshot, position) => {
      if (snapshot.id !== value.cellIds[position]) {
        ctx.addIssue({
          code: 'custom',
          path: ['missionSnapshots', position, 'id'],
          message:
            'Mission snapshot id must match the cell id at the same position.',
        })
      }
    })
  }

  value.photos?.forEach((photo, index) =>
    validateCellIdentity(ctx, {
      path: ['photos', index],
      cellIds: value.cellIds,
      position: photo.position,
      cellId: photo.cellId,
    }),
  )

  value.clips?.forEach((clip, index) =>
    validateCellIdentity(ctx, {
      path: ['clips', index],
      cellIds: value.cellIds,
      position: clip.position,
      cellId: clip.cellId,
    }),
  )
}

export const missionSnapshotSchema = z.object({
  id: z.string().min(1).max(80),
  category: z.enum([
    'nature',
    'manmade',
    'animal',
    'time',
    'self',
    'color',
    'special',
  ]),
  label: z.string().trim().min(1).max(40),
  caption: z.string().max(120).optional(),
  captureLabel: z.string().max(40).optional(),
  hint: z.string().max(160).optional(),
  icon: z.string().nullable(),
  variant: z.enum(['QeQCU', 'k4Srv', 'rAdyJ']),
  textOnly: z.boolean().optional(),
  fontSize: z.number().optional(),
  swatch: z.string().optional(),
  swatchLabel: z.string().optional(),
  camera: z.enum(['front', 'back', 'timer']).optional(),
  difficulty: z.enum(['easy', 'medium', 'hard']).optional(),
  noPhoto: z.boolean().optional(),
  fixedPosition: z.literal('center').optional(),
})

export const boardSnapshotSchema = z
  .object({
    clientBoardSessionId: z.string().min(1).max(120),
    mode: boardModeSchema,
    boardKind: boardKindSchema.optional(),
    nickname: z.string().trim().min(1).max(40),
    title: z.string().trim().min(1).max(24).optional(),
    description: z.string().trim().max(120).optional(),
    freePosition: z.number().int().min(0).max(8),
    cellIds: z.array(z.string().min(1).max(80)).length(9),
    missionSnapshots: z.array(missionSnapshotSchema).length(9).optional(),
  })
  .superRefine(validateBoardShape)

export const persistedBoardPhotoSchema = z.object({
  position: z.number().int().min(0).max(8),
  cellId: z.string().min(1).max(80),
  photoId: z.uuid(),
  ownerKind: z.literal('user'),
  previewUrl: z.string().optional(),
  previewUrlExpiresAt: z.string().optional(),
  uploadStatus: z.enum(['uploading', 'uploaded', 'failed']),
})

export const persistedBoardClipSchema = z.object({
  position: z.number().int().min(0).max(8),
  cellId: z.string().min(1).max(80),
  clipId: z.uuid(),
  ownerKind: z.literal('user'),
  clipUrl: z.string().optional(),
  clipUrlExpiresAt: z.string().optional(),
  posterUrl: z.string().optional(),
  posterUrlExpiresAt: z.string().optional(),
  durationMs: z.number().min(1).max(3000),
  description: z.string().trim().max(MAX_CLIP_DESCRIPTION_LENGTH).optional(),
  pendingKey: z.string().optional(),
  uploadStatus: z.enum(['local_pending', 'uploading', 'uploaded', 'failed']),
})

export const boardSessionSchema = z.discriminatedUnion('version', [
  z
    .object({
      version: z.literal(2),
      sessionId: z.string().min(1).max(120),
      boardId: z.uuid().optional(),
      mode: boardModeSchema,
      nickname: z.string().trim().min(1).max(40),
      createdAt: z.string().min(1),
      updatedAt: z.string().min(1),
      freePosition: z.number().int().min(0).max(8),
      cellIds: z.array(z.string().min(1).max(80)).length(9),
      markedPositions: z.array(z.number().int().min(0).max(8)).max(9),
      photos: z.array(persistedBoardPhotoSchema).max(9),
      endedAt: z.string().nullable(),
    })
    .superRefine(validateBoardShape),
  z
    .object({
      version: z.literal(3),
      sessionId: z.string().min(1).max(120),
      boardId: z.uuid().optional(),
      mode: boardModeSchema,
      nickname: z.string().trim().min(1).max(40),
      createdAt: z.string().min(1),
      updatedAt: z.string().min(1),
      freePosition: z.number().int().min(0).max(8),
      cellIds: z.array(z.string().min(1).max(80)).length(9),
      markedPositions: z.array(z.number().int().min(0).max(8)).max(9),
      clips: z.array(persistedBoardClipSchema).max(9),
      endedAt: z.string().nullable(),
    })
    .superRefine(validateBoardShape),
  z
    .object({
      version: z.literal(4),
      sessionId: z.string().min(1).max(120),
      boardId: z.uuid().optional(),
      mode: boardModeSchema,
      boardKind: boardKindSchema,
      nickname: z.string().trim().min(1).max(40),
      title: z.string().trim().min(1).max(24),
      description: z.string().trim().max(120).optional(),
      createdAt: z.string().min(1),
      updatedAt: z.string().min(1),
      freePosition: z.number().int().min(0).max(8),
      cellIds: z.array(z.string().min(1).max(80)).length(9),
      missionSnapshots: z.array(missionSnapshotSchema).length(9),
      markedPositions: z.array(z.number().int().min(0).max(8)).max(9),
      clips: z.array(persistedBoardClipSchema).max(9),
      endedAt: z.string().nullable(),
    })
    .superRefine(validateBoardShape),
])

export const markBoardCellSchema = z.object({
  cellId: z.string().min(1).max(80),
  marked: z.boolean(),
})

export const replaceBoardCellSchema = z.object({
  cellId: z.string().min(1).max(80),
})

export const endBoardSchema = z.object({
  title: z.string().trim().min(1).max(24).optional(),
})

export const updateBoardTitleSchema = z.object({
  title: z.string().trim().min(1).max(24),
})

export const editBoardCellMissionSchema = z.object({
  cellId: z.string().min(1).max(80),
  title: z.string().trim().min(1).max(40),
  description: z.string().trim().max(160).optional(),
  captureLabel: z.string().trim().max(40).optional(),
})

export const restoreBoardCellMissionSchema = z.object({
  cellId: z.string().min(1).max(80),
})

export type BoardSnapshotInput = z.infer<typeof boardSnapshotSchema>
export type BoardSessionInput = z.infer<typeof boardSessionSchema>
export type BoardListQueryInput = z.infer<typeof boardListQuerySchema>
export type EndBoardInput = z.infer<typeof endBoardSchema>
export type UpdateBoardTitleInput = z.infer<typeof updateBoardTitleSchema>
export type EditBoardCellMissionInput = z.infer<
  typeof editBoardCellMissionSchema
>
export type RestoreBoardCellMissionInput = z.infer<
  typeof restoreBoardCellMissionSchema
>
