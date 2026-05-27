import { z } from 'zod'

import { MAX_CLIP_DESCRIPTION_LENGTH } from '@/media/media.constants'

export const boardModeSchema = z.enum(['5x5', '3x3'])
export const boardKindSchema = z.enum(['mission', 'custom'])

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

export const boardSnapshotSchema = z.object({
  clientBoardSessionId: z.string().min(1).max(120),
  mode: boardModeSchema,
  boardKind: boardKindSchema.optional(),
  nickname: z.string().trim().min(1).max(40),
  title: z.string().trim().min(1).max(24).optional(),
  description: z.string().trim().max(120).optional(),
  freePosition: z.number().int().min(0).max(24),
  cellIds: z.array(z.string().min(1).max(80)).min(9).max(25),
  missionSnapshots: z.array(missionSnapshotSchema).min(9).max(25).optional(),
})

export const persistedBoardPhotoSchema = z.object({
  position: z.number().int().min(0).max(24),
  cellId: z.string().min(1).max(80),
  photoId: z.uuid(),
  ownerKind: z.enum(['guest', 'user']),
  previewUrl: z.string().optional(),
  previewUrlExpiresAt: z.string().optional(),
  uploadStatus: z.enum(['uploading', 'uploaded', 'failed']),
})

export const persistedBoardClipSchema = z.object({
  position: z.number().int().min(0).max(24),
  cellId: z.string().min(1).max(80),
  clipId: z.uuid(),
  ownerKind: z.enum(['guest', 'user']),
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
  z.object({
    version: z.literal(2),
    sessionId: z.string().min(1).max(120),
    boardId: z.uuid().optional(),
    mode: boardModeSchema,
    nickname: z.string().trim().min(1).max(40),
    createdAt: z.string().min(1),
    updatedAt: z.string().min(1),
    freePosition: z.number().int().min(0).max(24),
    cellIds: z.array(z.string().min(1).max(80)).min(9).max(25),
    markedPositions: z.array(z.number().int().min(0).max(24)).max(25),
    photos: z.array(persistedBoardPhotoSchema).max(25),
    endedAt: z.string().nullable(),
  }),
  z.object({
    version: z.literal(3),
    sessionId: z.string().min(1).max(120),
    boardId: z.uuid().optional(),
    mode: boardModeSchema,
    nickname: z.string().trim().min(1).max(40),
    createdAt: z.string().min(1),
    updatedAt: z.string().min(1),
    freePosition: z.number().int().min(0).max(24),
    cellIds: z.array(z.string().min(1).max(80)).min(9).max(25),
    markedPositions: z.array(z.number().int().min(0).max(24)).max(25),
    clips: z.array(persistedBoardClipSchema).max(25),
    endedAt: z.string().nullable(),
  }),
  z.object({
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
    freePosition: z.number().int().min(0).max(24),
    cellIds: z.array(z.string().min(1).max(80)).min(9).max(25),
    missionSnapshots: z.array(missionSnapshotSchema).min(9).max(25),
    markedPositions: z.array(z.number().int().min(0).max(24)).max(25),
    clips: z.array(persistedBoardClipSchema).max(25),
    endedAt: z.string().nullable(),
  }),
])

export const markBoardCellSchema = z.object({
  cellId: z.string().min(1).max(80),
  marked: z.boolean(),
})

export const replaceBoardCellSchema = z.object({
  cellId: z.string().min(1).max(80),
})

export type BoardSnapshotInput = z.infer<typeof boardSnapshotSchema>
export type BoardSessionInput = z.infer<typeof boardSessionSchema>
