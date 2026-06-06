import { z } from 'zod'

export const badgeDifficultyFilterSchema = z.enum(['easy', 'medium', 'hard', 'all'])
export const badgeStatusFilterSchema = z.enum(['earned', 'locked', 'all'])

export const userBadgesQuerySchema = z.object({
  difficulty: badgeDifficultyFilterSchema.default('all'),
  status: badgeStatusFilterSchema.default('all'),
})

export type UserBadgesQueryInput = z.infer<typeof userBadgesQuerySchema>
