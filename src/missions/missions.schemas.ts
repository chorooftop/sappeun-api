import { z } from 'zod'

export const missionCellSchema = z.object({
  id: z.string(),
  category: z.string(),
  label: z.string(),
  caption: z.string().optional(),
  captureLabel: z.string().optional(),
  hint: z.string().optional(),
  icon: z.string().nullable(),
  variant: z.string(),
  textOnly: z.boolean().optional(),
  fontSize: z.number().optional(),
  swatch: z.string().optional(),
  swatchLabel: z.string().optional(),
  camera: z.string().optional(),
  difficulty: z.string().optional(),
  noPhoto: z.boolean().optional(),
  fixedPosition: z.string().optional(),
})

export const missionCategorySchema = z.object({
  label: z.string(),
  count: z.number(),
  tone: z.string(),
})

export const missionContentResponseSchema = z.object({
  version: z.string(),
  updatedAt: z.string(),
  totalCells: z.number(),
  categories: z.record(z.string(), missionCategorySchema),
  cells: z.array(missionCellSchema),
})

export type MissionCell = z.infer<typeof missionCellSchema>
export type MissionCategory = z.infer<typeof missionCategorySchema>
export type MissionContentResponse = z.infer<
  typeof missionContentResponseSchema
>
