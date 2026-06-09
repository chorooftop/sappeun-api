#!/usr/bin/env node
import {
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { basename } from 'node:path'

const MAX_SIZE_BYTES = 200 * 1024
const MAX_DIMENSION = 1024
const RECOMMENDED_DIMENSIONS = new Set([256, 512])
const CACHE_CONTROL = 'public, max-age=31536000, immutable'
const DEFAULT_REGION = 'auto'
const DEFAULT_PUBLIC_BASE_URL = 'https://assets.sappeun.app'
const ASSET_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/
const CONTENT_HASH_RE = /^.{12,96}$/
const CAPABILITY = 'runtime-artwork-v1'

function loadEnvFallback() {
  try {
    const raw = readFileSync(new URL('../.env', import.meta.url), 'utf8')
    for (const line of raw.split('\n')) {
      const match = line.match(/^([A-Z0-9_]+)=(.*)$/)
      if (match && !process.env[match[1]]) {
        process.env[match[1]] = match[2].trim()
      }
    }
  } catch {
    // --env-file or shell-provided env is preferred; .env is only a fallback.
  }
}

function usage() {
  return `Usage:
  node --env-file=.env scripts/upload-artwork-asset.mjs \\
    --file ./asset.webp \\
    --asset-id mission_squirrel_v1 \\
    --fallback '{"schemaVersion":1,"type":"lucide","key":"cat"}' \\
    [--palette-mode mono|fullColor] [--dry-run] \\
    [--target mission_content --mission-id n09]

Required env:
  R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY,
  R2_PUBLIC_ASSET_BUCKET, R2_PUBLIC_ASSET_BASE_URL
`
}

function parseArgs(argv) {
  const args = {}
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) {
      throw new Error(`Unexpected argument: ${token}`)
    }
    const key = token.slice(2)
    if (key === 'dry-run') {
      args.dryRun = true
      continue
    }
    const value = argv[index + 1]
    if (!value || value.startsWith('--')) {
      throw new Error(`Missing value for --${key}`)
    }
    args[key.replace(/-([a-z])/g, (_, char) => char.toUpperCase())] = value
    index += 1
  }
  return args
}

function requiredArg(args, key) {
  const value = args[key]
  if (!value)
    throw new Error(
      `Missing --${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`,
    )
  return value
}

function requiredEnv(key) {
  const value = process.env[key]
  if (!value) throw new Error(`Missing env ${key}`)
  return value
}

function assertAssetId(value) {
  if (!ASSET_ID_RE.test(value)) {
    throw new Error(
      'assetId must use only letters, numbers, underscores, or hyphens.',
    )
  }
}

function configuredArtworkHosts() {
  const hosts = new Set([new URL(DEFAULT_PUBLIC_BASE_URL).host])
  const baseUrl = process.env.R2_PUBLIC_ASSET_BASE_URL
  if (!baseUrl) return hosts

  try {
    const parsed = new URL(baseUrl)
    if (parsed.protocol === 'https:') hosts.add(parsed.host)
  } catch {
    // Runtime env validation handles malformed values for the API server.
  }

  return hosts
}

function assertBaseArtworkFields(spec) {
  if (spec.schemaVersion !== 1)
    throw new Error('fallback.schemaVersion must be 1.')
  if (
    spec.alt != null &&
    (typeof spec.alt !== 'string' || spec.alt.length > 80)
  ) {
    throw new Error('fallback.alt must be a string length <=80.')
  }
  if (
    spec.paletteMode != null &&
    spec.paletteMode !== 'mono' &&
    spec.paletteMode !== 'fullColor'
  ) {
    throw new Error('fallback.paletteMode must be mono or fullColor.')
  }
}

function assertAllowedRemoteImageUrl(value) {
  if (typeof value !== 'string') {
    throw new Error('remoteImage fallback url must be a string.')
  }

  let parsed
  try {
    parsed = new URL(value)
  } catch {
    throw new Error('remoteImage fallback url must be a valid URL.')
  }

  if (
    parsed.protocol !== 'https:' ||
    !configuredArtworkHosts().has(parsed.host)
  ) {
    throw new Error(
      'remoteImage fallback url must be HTTPS and use an allowed host.',
    )
  }
}

function assertPositiveBoundedInteger(value, field) {
  if (!Number.isInteger(value) || value <= 0 || value > MAX_DIMENSION) {
    throw new Error(
      `remoteImage fallback ${field} must be an integer from 1..${MAX_DIMENSION}.`,
    )
  }
}

function readUInt24LE(buffer, offset) {
  return buffer[offset] | (buffer[offset + 1] << 8) | (buffer[offset + 2] << 16)
}

function parsePng(buffer) {
  const signature = buffer.subarray(0, 8).toString('hex')
  if (signature !== '89504e470d0a1a0a') return null
  if (buffer.subarray(12, 16).toString('ascii') !== 'IHDR') {
    throw new Error('Invalid PNG: missing IHDR chunk.')
  }
  return {
    mimeType: 'image/png',
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
  }
}

function parseWebp(buffer) {
  if (
    buffer.subarray(0, 4).toString('ascii') !== 'RIFF' ||
    buffer.subarray(8, 12).toString('ascii') !== 'WEBP'
  ) {
    return null
  }

  let offset = 12
  while (offset + 8 <= buffer.length) {
    const chunkType = buffer.subarray(offset, offset + 4).toString('ascii')
    const chunkSize = buffer.readUInt32LE(offset + 4)
    const payload = offset + 8

    if (payload + chunkSize > buffer.length) {
      throw new Error('Invalid WebP: truncated chunk.')
    }

    if (chunkType === 'VP8X') {
      if (chunkSize < 10) throw new Error('Invalid WebP: short VP8X chunk.')
      return {
        mimeType: 'image/webp',
        width: readUInt24LE(buffer, payload + 4) + 1,
        height: readUInt24LE(buffer, payload + 7) + 1,
      }
    }

    if (chunkType === 'VP8L') {
      if (chunkSize < 5 || buffer[payload] !== 0x2f) {
        throw new Error('Invalid WebP: short VP8L chunk.')
      }
      const bits = buffer.readUInt32LE(payload + 1)
      return {
        mimeType: 'image/webp',
        width: (bits & 0x3fff) + 1,
        height: ((bits >> 14) & 0x3fff) + 1,
      }
    }

    if (chunkType === 'VP8 ') {
      if (chunkSize < 10) throw new Error('Invalid WebP: short VP8 chunk.')
      const startCode = buffer
        .subarray(payload + 3, payload + 6)
        .toString('hex')
      if (startCode !== '9d012a')
        throw new Error('Invalid WebP: VP8 start code.')
      return {
        mimeType: 'image/webp',
        width: buffer.readUInt16LE(payload + 6) & 0x3fff,
        height: buffer.readUInt16LE(payload + 8) & 0x3fff,
      }
    }

    offset = payload + chunkSize + (chunkSize % 2)
  }

  throw new Error('Invalid WebP: no VP8/VP8L/VP8X chunk found.')
}

function inspectImage(buffer) {
  const info = parsePng(buffer) ?? parseWebp(buffer)
  if (!info) throw new Error('Unsupported artwork image type. Use PNG or WebP.')
  if (info.width > MAX_DIMENSION || info.height > MAX_DIMENSION) {
    throw new Error(`Image dimensions exceed ${MAX_DIMENSION}px.`)
  }
  return info
}

function validateArtworkSpec(spec, depth = 0) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
    throw new Error('fallback must be a JSON object.')
  }
  assertBaseArtworkFields(spec)

  if (spec.type === 'lucide') {
    if (
      typeof spec.key !== 'string' ||
      spec.key.length < 1 ||
      spec.key.length > 80
    ) {
      throw new Error('lucide fallback requires key length 1..80.')
    }
    return spec
  }

  if (spec.type === 'swatch') {
    if (
      spec.key != null &&
      (typeof spec.key !== 'string' || spec.key.length > 80)
    ) {
      throw new Error('swatch fallback key must be a string length <=80.')
    }
    if (spec.colorHex != null && !/^#[0-9A-Fa-f]{6}$/.test(spec.colorHex)) {
      throw new Error('swatch fallback colorHex must be #RRGGBB.')
    }
    if (
      spec.label != null &&
      (typeof spec.label !== 'string' || spec.label.length > 20)
    ) {
      throw new Error('swatch fallback label must be a string length <=20.')
    }
    if (
      spec.effect != null &&
      spec.effect !== 'solid' &&
      spec.effect !== 'rainbow'
    ) {
      throw new Error('swatch fallback effect must be solid or rainbow.')
    }
    return spec
  }

  if (spec.type === 'text') {
    if (
      typeof spec.label !== 'string' ||
      spec.label.length < 1 ||
      spec.label.length > 4
    ) {
      throw new Error('text fallback requires label length 1..4.')
    }
    if (spec.fontSize != null && (spec.fontSize < 8 || spec.fontSize > 48)) {
      throw new Error('text fallback fontSize must be between 8 and 48.')
    }
    return spec
  }

  if (spec.type === 'remoteImage') {
    if (depth >= 1)
      throw new Error('fallback remoteImage chain is limited to 2 levels.')
    if (typeof spec.assetId !== 'string') {
      throw new Error('remoteImage fallback assetId must be a string.')
    }
    assertAssetId(spec.assetId)
    assertAllowedRemoteImageUrl(spec.url)
    if (
      typeof spec.contentHash !== 'string' ||
      !CONTENT_HASH_RE.test(spec.contentHash)
    ) {
      throw new Error('remoteImage fallback contentHash length must be 12..96.')
    }
    if (spec.mimeType !== 'image/webp' && spec.mimeType !== 'image/png') {
      throw new Error(
        'remoteImage fallback mimeType must be image/webp or image/png.',
      )
    }
    assertPositiveBoundedInteger(spec.width, 'width')
    assertPositiveBoundedInteger(spec.height, 'height')
    if (spec.fit != null && spec.fit !== 'contain') {
      throw new Error('remoteImage fallback fit must be contain.')
    }
    validateArtworkSpec(spec.fallback, depth + 1)
    return spec
  }

  throw new Error(`Unsupported fallback artwork type: ${String(spec.type)}`)
}

function sqlString(value) {
  return `'${String(value).replace(/'/g, "''")}'`
}

function buildSqlSnippet(args, artworkJson) {
  const target = args.target
  if (!target) return null

  const catalogVersion = args.catalogVersion ?? 'api-migration-v1'
  const json = sqlString(JSON.stringify(artworkJson, null, 2))

  if (target === 'mission_content') {
    const missionId = requiredArg(args, 'missionId')
    return `update public.mission_content
set artwork = ${json}::jsonb,
    required_capabilities = (
      select array_agg(distinct capability)
      from unnest(required_capabilities || array['${CAPABILITY}'::text]) as capability
    )
where catalog_version = ${sqlString(catalogVersion)}
  and mission_id = ${sqlString(missionId)};`
  }

  throw new Error('--target must be mission_content.')
}

function isNotFound(error) {
  return (
    error?.$metadata?.httpStatusCode === 404 ||
    error?.name === 'NotFound' ||
    error?.name === 'NoSuchKey'
  )
}

async function objectExists(client, bucket, key) {
  try {
    await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }))
    return true
  } catch (error) {
    if (isNotFound(error)) return false
    throw error
  }
}

async function main() {
  loadEnvFallback()

  const args = parseArgs(process.argv.slice(2))
  const file = requiredArg(args, 'file')
  const assetId = requiredArg(args, 'assetId')
  const fallback = validateArtworkSpec(
    JSON.parse(requiredArg(args, 'fallback')),
  )
  const paletteMode = args.paletteMode ?? 'mono'

  if (paletteMode !== 'mono' && paletteMode !== 'fullColor') {
    throw new Error('--palette-mode must be mono or fullColor.')
  }
  assertAssetId(assetId)

  const buffer = readFileSync(file)
  if (buffer.length > MAX_SIZE_BYTES) {
    throw new Error(`Image size exceeds ${MAX_SIZE_BYTES} bytes.`)
  }

  const image = inspectImage(buffer)
  const hash = createHash('sha256').update(buffer).digest('hex')
  const ext = image.mimeType === 'image/png' ? 'png' : 'webp'
  const objectKey = `mission-artwork/${assetId}.${hash.slice(0, 12)}.${ext}`
  const baseUrl = (
    process.env.R2_PUBLIC_ASSET_BASE_URL ?? DEFAULT_PUBLIC_BASE_URL
  ).replace(/\/+$/, '')
  const publicUrl = `${baseUrl}/${objectKey}`

  const artwork = {
    schemaVersion: 1,
    type: 'remoteImage',
    assetId,
    url: publicUrl,
    contentHash: `sha256:${hash}`,
    mimeType: image.mimeType,
    width: image.width,
    height: image.height,
    paletteMode,
    fit: 'contain',
    fallback,
  }

  const output = {
    file: basename(file),
    objectKey,
    sizeBytes: buffer.length,
    recommendedSize:
      RECOMMENDED_DIMENSIONS.has(image.width) && image.width === image.height,
    artwork,
  }

  if (!args.dryRun) {
    const accountId = requiredEnv('R2_ACCOUNT_ID')
    const bucket = requiredEnv('R2_PUBLIC_ASSET_BUCKET')
    const endpoint =
      process.env.R2_ENDPOINT ?? `https://${accountId}.r2.cloudflarestorage.com`
    const client = new S3Client({
      region: process.env.R2_REGION ?? DEFAULT_REGION,
      endpoint,
      credentials: {
        accessKeyId: requiredEnv('R2_ACCESS_KEY_ID'),
        secretAccessKey: requiredEnv('R2_SECRET_ACCESS_KEY'),
      },
    })

    if (await objectExists(client, bucket, objectKey)) {
      output.upload = 'skipped-existing-object'
    } else {
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: objectKey,
          Body: buffer,
          ContentType: image.mimeType,
          CacheControl: CACHE_CONTROL,
        }),
      )
      output.upload = 'uploaded'
    }
  } else {
    output.upload = 'dry-run'
  }

  const sql = buildSqlSnippet(args, artwork)
  if (sql) output.sql = sql

  console.log(JSON.stringify(output, null, 2))
}

main().catch((error) => {
  console.error(error?.message ?? error)
  console.error(usage())
  process.exit(1)
})
