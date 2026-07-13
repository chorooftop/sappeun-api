import { z } from 'zod'

const emptyToUndefined = (value: unknown) => {
  if (typeof value !== 'string') return value
  const trimmed = value.trim()
  return trimmed.length === 0 ? undefined : trimmed
}

const corsOriginsSchema = z.preprocess((value) => {
  if (typeof value !== 'string') return []
  return value
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean)
}, z.array(z.string().url()).default([]))

export const envSchema = z.object({
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  API_PREFIX: z.preprocess(emptyToUndefined, z.string().default('v1')),
  CORS_ORIGINS: corsOriginsSchema,
  SUPABASE_URL: z.preprocess(emptyToUndefined, z.string().url()),
  SUPABASE_ANON_KEY: z.preprocess(emptyToUndefined, z.string().min(1)),
  SUPABASE_SERVICE_ROLE_KEY: z.preprocess(emptyToUndefined, z.string().min(1)),
  R2_ACCOUNT_ID: z.preprocess(emptyToUndefined, z.string().min(1)),
  R2_ACCESS_KEY_ID: z.preprocess(emptyToUndefined, z.string().min(1)),
  R2_SECRET_ACCESS_KEY: z.preprocess(emptyToUndefined, z.string().min(1)),
  R2_BUCKET: z.preprocess(emptyToUndefined, z.string().min(1)),
  R2_PUBLIC_ASSET_BUCKET: z.preprocess(
    emptyToUndefined,
    z.string().min(1).optional(),
  ),
  R2_PUBLIC_ASSET_BASE_URL: z.preprocess(
    emptyToUndefined,
    z.string().url().optional(),
  ),
  R2_ENDPOINT: z.preprocess(emptyToUndefined, z.string().url().optional()),
  R2_REGION: z.preprocess(emptyToUndefined, z.string().default('auto')),
  R2_OWNER_HASH_SECRET: z.preprocess(emptyToUndefined, z.string().min(16)),
  CRON_SECRET: z.preprocess(emptyToUndefined, z.string().optional()),
  DAILY_BINGO_ENABLED: z.preprocess(
    emptyToUndefined,
    z.enum(['true', 'false']).optional().default('true'),
  ),
  QA_AUTH_ENABLED: z.preprocess(
    emptyToUndefined,
    z.enum(['true', 'false']).optional().default('false'),
  ),
  QA_AUTH_ALLOW_PRODUCTION: z.preprocess(
    emptyToUndefined,
    z.enum(['true', 'false']).optional().default('false'),
  ),
  QA_AUTH_EMAIL: z.preprocess(emptyToUndefined, z.email().optional()),
  QA_AUTH_PASSWORD: z.preprocess(
    emptyToUndefined,
    z.string().min(8).optional(),
  ),
  QA_AUTH_CODE_HASH: z.preprocess(
    emptyToUndefined,
    z.string().min(16).optional(),
  ),
  QA_AUTH_BIRTH_DATE: z.preprocess(
    emptyToUndefined,
    z.iso.date().optional().default('2000-01-01'),
  ),
  QA_AUTH_DISPLAY_NAME: z.preprocess(
    emptyToUndefined,
    z.string().min(1).max(40).optional().default('사뿐 QA'),
  ),
})

export type AppEnv = z.infer<typeof envSchema>

export function validateEnv(config: Record<string, unknown>): AppEnv {
  const merged = {
    ...config,
    SUPABASE_URL: config.SUPABASE_URL ?? config.NEXT_PUBLIC_SUPABASE_URL,
    SUPABASE_ANON_KEY:
      config.SUPABASE_ANON_KEY ?? config.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  }
  return envSchema.parse(merged)
}
