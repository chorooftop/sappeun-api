#!/usr/bin/env node
import {
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { validateManifestTemplateImages } from './mission-artwork-template-utils.mjs'

const repoRoot = new URL('..', import.meta.url)
const repoRootPath = fileURLToPath(repoRoot)
const MANIFEST_PATH = new URL(
  '../artifacts/mission-artwork/v1.4-pencil-export/manifest.json',
  import.meta.url,
)
const CACHE_CONTROL = 'public, max-age=31536000, immutable'
const DEFAULT_REGION = 'auto'

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
    // Shell-provided env is preferred; .env is only a local fallback.
  }
}

function usage() {
  return `Usage:
  node --env-file=.env scripts/upload-mission-expansion-artwork.mjs [--dry-run]

Required env for real upload:
  R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY,
  R2_PUBLIC_ASSET_BUCKET
`
}

function parseArgs(argv) {
  const args = { dryRun: false }
  for (const token of argv) {
    if (token === '--') continue
    if (token === '--dry-run') {
      args.dryRun = true
      continue
    }
    throw new Error(`Unexpected argument: ${token}`)
  }
  return args
}

function requiredEnv(key) {
  const value = process.env[key]
  if (!value) throw new Error(`Missing env ${key}`)
  return value
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

function readManifest() {
  return JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'))
}

async function main() {
  loadEnvFallback()
  const args = parseArgs(process.argv.slice(2))
  const manifest = readManifest()
  const validation = validateManifestTemplateImages(manifest, repoRootPath)

  const prepared = manifest.images.map((image) => {
    const file = resolve(repoRootPath, image.file)
    const body = readFileSync(file)
    return { ...image, body }
  })

  if (args.dryRun) {
    console.log(
      JSON.stringify(
        {
          upload: 'dry-run',
          count: prepared.length,
          totalBytes: validation.totalBytes,
          firstObjectKey: validation.firstObjectKey,
          lastObjectKey: validation.lastObjectKey,
          templateWarnings: validation.warnings,
        },
        null,
        2,
      ),
    )
    return
  }

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

  let uploaded = 0
  let skipped = 0
  for (const image of prepared) {
    if (await objectExists(client, bucket, image.objectKey)) {
      skipped += 1
      continue
    }

    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: image.objectKey,
        Body: image.body,
        ContentType: image.artwork.mimeType,
        CacheControl: CACHE_CONTROL,
      }),
    )
    uploaded += 1
  }

  console.log(
    JSON.stringify(
      {
        upload: 'complete',
        bucket,
        uploaded,
        skipped,
        count: prepared.length,
        templateWarnings: validation.warnings,
      },
      null,
      2,
    ),
  )
}

main().catch((error) => {
  console.error(error?.message ?? error)
  console.error(usage())
  process.exit(1)
})
