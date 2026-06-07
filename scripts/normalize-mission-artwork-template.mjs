#!/usr/bin/env node
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  ARTWORK_IMAGE_DIR,
  EXPANSION_MISSIONS,
  RAW_NODE_EXPORT_DIR,
} from './gen-mission-expansion-seed.mjs'
import {
  normalizeTemplatePngBuffer,
  validateTemplatePngFile,
} from './mission-artwork-template-utils.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, '..')

function parseArgs(argv) {
  const args = {
    inputDir: RAW_NODE_EXPORT_DIR,
    outputDir: ARTWORK_IMAGE_DIR,
  }

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === '--') continue

    if (token === '--input') {
      args.inputDir = resolve(repoRoot, argv[index + 1] ?? '')
      index += 1
      continue
    }

    if (token === '--output') {
      args.outputDir = resolve(repoRoot, argv[index + 1] ?? '')
      index += 1
      continue
    }

    throw new Error(`Unexpected argument: ${token}`)
  }

  return args
}

function usage() {
  return `Usage:
  node scripts/normalize-mission-artwork-template.mjs [--input <dir>] [--output <dir>]

Default input:
  artifacts/mission-artwork/v1.4-pencil-export/raw-node-export

Default output:
  artifacts/mission-artwork/v1.4-pencil-export/png
`
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  mkdirSync(args.outputDir, { recursive: true })

  const results = []
  for (const mission of EXPANSION_MISSIONS) {
    const source = resolve(args.inputDir, `${mission.nodeId}.png`)
    const target = resolve(args.outputDir, `${mission.id}.png`)

    if (!existsSync(source)) {
      throw new Error(
        `Missing raw Pencil export for ${mission.id}: ${source}. Raw exports are local-only inputs; re-export the Pencil nodes before running normalize.`,
      )
    }

    const normalized = normalizeTemplatePngBuffer(readFileSync(source), source)
    writeFileSync(target, normalized)
    const analysis = validateTemplatePngFile(target)
    results.push({
      missionId: mission.id,
      source: source.replace(`${repoRoot}/`, ''),
      file: target.replace(`${repoRoot}/`, ''),
      hash: analysis.hash,
      bytes: analysis.byteLength,
      width: analysis.width,
      height: analysis.height,
      warnings: analysis.warnings,
    })
  }

  const warnings = results.flatMap((result) =>
    result.warnings.map((warning) => ({
      missionId: result.missionId,
      warning,
    })),
  )

  console.log(
    JSON.stringify(
      {
        normalized: results.length,
        totalBytes: results.reduce((sum, result) => sum + result.bytes, 0),
        outputDir: args.outputDir.replace(`${repoRoot}/`, ''),
        warnings,
      },
      null,
      2,
    ),
  )
}

try {
  main()
} catch (error) {
  console.error(error?.message ?? error)
  console.error(usage())
  process.exit(1)
}
