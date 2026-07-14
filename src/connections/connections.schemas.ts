import { z } from 'zod'

import {
  INVITE_CODE_LENGTH,
  RELATIONSHIP_LABELS,
} from '@/connections/connections.constants'

export const relationshipLabelSchema = z.enum(RELATIONSHIP_LABELS)

export const createGroupSchema = z.object({
  name: z.string().trim().min(1).max(40),
  relationshipLabel: relationshipLabelSchema,
  theme: z.string().trim().min(1).max(40).optional(),
  emoji: z.string().trim().min(1).max(16).optional(),
})

export type CreateGroupInput = z.infer<typeof createGroupSchema>

export const joinRequestSchema = z.object({
  inviteCode: z
    .string()
    .trim()
    .length(INVITE_CODE_LENGTH)
    .transform((code) => code.toUpperCase()),
})

export type JoinRequestInput = z.infer<typeof joinRequestSchema>
