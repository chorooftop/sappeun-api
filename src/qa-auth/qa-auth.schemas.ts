import { z } from 'zod'

export const qaAuthSessionSchema = z
  .object({
    client: z.string().trim().min(1).max(40).optional(),
    flow: z.string().trim().min(1).max(80).optional(),
    code: z.string().trim().min(1).max(200).optional(),
  })
  .strict()
  .default({})

export type QaAuthSessionInput = z.infer<typeof qaAuthSessionSchema>
