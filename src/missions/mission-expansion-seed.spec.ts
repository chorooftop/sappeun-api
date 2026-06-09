import {
  readFileSync,
  readdirSync,
  statSync,
} from 'node:fs'
import { join, resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import { artworkSpecSchema } from '@/common/artwork.schemas'

// @ts-expect-error -- the .mjs generator is plain JS without a declaration file; its runtime exports are the expansion drift oracle.
import {
  ARTWORK_IMAGE_DIR,
  ARTWORK_MANIFEST_PATH,
  buildExpansionArtifacts,
  EXPANSION_MISSIONS,
  MIGRATION_PATH,
} from '../../scripts/gen-mission-expansion-seed.mjs'
// @ts-expect-error -- the .mjs helper is shared by Node scripts and these parity tests.
import { validateTemplatePngFile } from '../../scripts/mission-artwork-template-utils.mjs'

const repoRoot = process.cwd()
const SOURCE_PATH = resolve(repoRoot, 'src/missions/sheet.source.json')

const source = JSON.parse(readFileSync(SOURCE_PATH, 'utf8')) as {
  cells: Array<{ id: string }>
}

const generated = buildExpansionArtifacts() as {
  rows: Array<{
    id: string
    category: string
    sortOrder: number
    requiredCapabilities: string[]
    artwork: unknown
  }>
  migrationSql: string
  manifest: {
    count: number
    images: Array<{
      missionId: string
      file: string
      artwork: unknown
    }>
  }
}

const committedSql = readFileSync(MIGRATION_PATH, 'utf8')
const committedManifest = JSON.parse(
  readFileSync(ARTWORK_MANIFEST_PATH, 'utf8'),
) as typeof generated.manifest

function countByCategory(rows: typeof generated.rows) {
  return rows.reduce<Record<string, number>>((acc, row) => {
    acc[row.category] = (acc[row.category] ?? 0) + 1
    return acc
  }, {})
}

describe('mission expansion seed (v1.4)', () => {
  it('keeps committed SQL and artwork manifest in sync with the generator', () => {
    expect(committedSql).toBe(generated.migrationSql)
    expect(committedManifest).toEqual(generated.manifest)
  })

  it('does not regenerate deprecated mission_badges rows or stored category counts', () => {
    expect(committedSql).not.toContain('insert into public.mission_badges')
    expect(committedSql).not.toContain('grade_label')
    expect(committedSql).not.toContain('grade_color')
    expect(committedSql).not.toMatch(/catalog_version,\s*key,\s*label,\s*tone,\s*count/)
  })

  it('adds exactly the 102 planned expansion missions with no legacy id overlap', () => {
    expect(EXPANSION_MISSIONS).toHaveLength(102)
    expect(generated.rows).toHaveLength(102)

    const ids = generated.rows.map((row) => row.id)
    expect(new Set(ids).size).toBe(ids.length)

    const legacyIds = new Set(source.cells.map((cell) => cell.id))
    expect(ids.filter((id) => legacyIds.has(id))).toEqual([])
  })

  it('matches the planned category deltas and final catalog count', () => {
    expect(countByCategory(generated.rows)).toEqual({
      nature: 24,
      manmade: 32,
      animal: 12,
      time: 15,
      color: 7,
      self: 12,
    })

    expect(source.cells.length + generated.rows.length).toBe(150)
  })

  it('gates every new mission and adds swatch hex support for color rows', () => {
    for (const row of generated.rows) {
      expect(row.requiredCapabilities).toContain('runtime-artwork-v1')
      if (row.category === 'color') {
        expect(row.requiredCapabilities).toContain('swatch-hex-v1')
      } else {
        expect(row.requiredCapabilities).not.toContain('swatch-hex-v1')
      }
    }
  })

  it('uses deterministic sort order after the legacy FREE cell', () => {
    generated.rows.forEach((row, index) => {
      expect(row.sortOrder).toBe(480 + index * 10)
    })
  })

  it('stores valid local Pencil PNGs and valid remoteImage artwork specs', () => {
    const pngFiles = readdirSync(ARTWORK_IMAGE_DIR).filter((file) =>
      file.endsWith('.png'),
    )
    expect(pngFiles).toHaveLength(102)
    expect(committedManifest.count).toBe(102)

    for (const image of committedManifest.images) {
      const filePath = resolve(repoRoot, image.file)
      const stats = statSync(filePath)
      expect(stats.size).toBeGreaterThan(0)
      expect(stats.size).toBeLessThanOrEqual(200 * 1024)
      const template = validateTemplatePngFile(filePath)

      const spec = artworkSpecSchema.parse(image.artwork)
      expect(spec.type).toBe('remoteImage')
      expect(join(ARTWORK_IMAGE_DIR, `${image.missionId}.png`)).toBe(filePath)
      expect(spec.paletteMode).toBe('mono')
      expect(spec.contentHash).toBe(`sha256:${template.hash}`)
      expect(spec.width).toBe(template.width)
      expect(spec.height).toBe(template.height)
    }
  })
})
