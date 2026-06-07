import { z } from 'zod'

export interface ArtworkBase {
  schemaVersion: 1
  alt?: string
  paletteMode?: 'mono' | 'fullColor'
}

export interface LucideArtwork extends ArtworkBase {
  type: 'lucide'
  key: string
}

export interface SwatchArtwork extends ArtworkBase {
  type: 'swatch'
  key?: string
  colorHex?: string
  label?: string
  effect?: 'solid' | 'rainbow'
}

export interface TextArtwork extends ArtworkBase {
  type: 'text'
  label: string
  fontSize?: number
}

export interface RemoteImageArtwork extends ArtworkBase {
  type: 'remoteImage'
  assetId: string
  url: string
  contentHash: string
  mimeType: 'image/webp' | 'image/png'
  width: number
  height: number
  fit?: 'contain'
  fallback: ArtworkSpec
}

export type ArtworkSpec =
  | LucideArtwork
  | SwatchArtwork
  | TextArtwork
  | RemoteImageArtwork

const DEFAULT_ARTWORK_HOST = 'assets.sappeun.app'
const MAX_FALLBACK_DEPTH = 2

const artworkBaseSchema = z.object({
  schemaVersion: z.literal(1),
  alt: z.string().max(80).optional(),
  paletteMode: z.enum(['mono', 'fullColor']).optional(),
})

const lucideArtworkSchema = artworkBaseSchema.extend({
  type: z.literal('lucide'),
  key: z.string().min(1).max(80),
})

const swatchArtworkSchema = artworkBaseSchema.extend({
  type: z.literal('swatch'),
  key: z.string().min(1).max(80).optional(),
  colorHex: z
    .string()
    .regex(/^#[0-9A-Fa-f]{6}$/)
    .optional(),
  label: z.string().max(20).optional(),
  effect: z.enum(['solid', 'rainbow']).optional(),
})

const textArtworkSchema = artworkBaseSchema.extend({
  type: z.literal('text'),
  label: z.string().min(1).max(4),
  fontSize: z.number().min(8).max(48).optional(),
})

function getArtworkSpecSchema(): z.ZodType<ArtworkSpec> {
  return artworkSpecSchema
}

const remoteImageArtworkSchema: z.ZodType<RemoteImageArtwork> =
  artworkBaseSchema.extend({
    type: z.literal('remoteImage'),
    assetId: z.string().min(1).max(120),
    url: z.string().url(),
    contentHash: z.string().min(12).max(96),
    mimeType: z.enum(['image/webp', 'image/png']),
    width: z.number().int().positive().max(1024),
    height: z.number().int().positive().max(1024),
    fit: z.literal('contain').optional(),
    fallback: z.lazy(getArtworkSpecSchema),
  })

function configuredArtworkHosts() {
  const hosts = new Set([DEFAULT_ARTWORK_HOST])
  const baseUrl = process.env.R2_PUBLIC_ASSET_BASE_URL
  if (!baseUrl) return hosts

  try {
    const parsed = new URL(baseUrl)
    if (parsed.protocol === 'https:') hosts.add(parsed.host)
  } catch {
    // Env validation catches malformed values during app bootstrap.
  }

  return hosts
}

function isAllowedRemoteImageUrl(value: string) {
  try {
    const parsed = new URL(value)
    return (
      parsed.protocol === 'https:' && configuredArtworkHosts().has(parsed.host)
    )
  } catch {
    return false
  }
}

function fallbackDepth(spec: ArtworkSpec, depth = 0): number {
  if (spec.type !== 'remoteImage') return depth
  return fallbackDepth(spec.fallback, depth + 1)
}

const artworkSpecSchemaBase = z.lazy(() =>
  z.union([
    lucideArtworkSchema,
    swatchArtworkSchema,
    textArtworkSchema,
    remoteImageArtworkSchema,
  ]),
) as z.ZodType<ArtworkSpec>

export const artworkSpecSchema = artworkSpecSchemaBase.superRefine(
  (value, ctx) => {
    if (value.type !== 'remoteImage') return

    if (!isAllowedRemoteImageUrl(value.url)) {
      ctx.addIssue({
        code: 'custom',
        path: ['url'],
        message: 'remoteImage.url must be HTTPS and use an allowed host.',
      })
    }

    if (fallbackDepth(value) > MAX_FALLBACK_DEPTH) {
      ctx.addIssue({
        code: 'custom',
        path: ['fallback'],
        message: `remoteImage fallback chain is limited to ${MAX_FALLBACK_DEPTH} levels.`,
      })
    }
  },
)
