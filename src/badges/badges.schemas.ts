import { z } from 'zod'

import { artworkSpecSchema } from '@/common/artwork.schemas'

export const badgeDifficultyFilterSchema = z.enum([
  'easy',
  'medium',
  'hard',
  'all',
])
export const badgeStatusFilterSchema = z.enum(['earned', 'locked', 'all'])

export const userBadgesQuerySchema = z.object({
  difficulty: badgeDifficultyFilterSchema.default('all'),
  status: badgeStatusFilterSchema.default('all'),
})

export const badgeCatalogItemSchema = z.object({
  badgeId: z.string(),
  missionId: z.string(),
  catalogVersion: z.string(),
  title: z.string(),
  category: z.string(),
  difficulty: z.string(),
  gradeLabel: z.string(),
  gradeColor: z.string(),
  artworkKey: z.string().nullable(),
  artwork: artworkSpecSchema.optional(),
  sortOrder: z.number(),
})

export type UserBadgesQueryInput = z.infer<typeof userBadgesQuerySchema>
export type BadgeCatalogItem = z.infer<typeof badgeCatalogItemSchema>
