import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

// @ts-expect-error -- the .mjs generator is plain JS without a declaration file (classic node resolution); its runtime exports are the parity oracle.
import {
  buildSeedRows,
  CONTENT_COLUMNS,
  CATALOG_VERSION,
} from '../../scripts/gen-mission-seed.mjs'

// ---------------------------------------------------------------------------
// Parity contract: the committed 0010_mission_content.sql MUST equal what the
// generator produces from sheet.source.json. This is the drift gate — if the
// source or generator changes without re-running `pnpm gen:mission-seed`, the
// committed SQL diverges and these assertions fail. We compare by re-deriving
// the expected SQL-literal rows from the generator (single source of mapping
// logic) and matching them against rows parsed out of the committed SQL.
// ---------------------------------------------------------------------------

// vitest runs with cwd at the sappeun-api repo root.
const repoRoot = process.cwd()
const SOURCE_PATH = resolve(repoRoot, 'src/missions/sheet.source.json')
const SQL_PATH = resolve(
  repoRoot,
  'supabase/migrations/0010_mission_content.sql',
)
const BADGE_SQL_PATH = resolve(
  repoRoot,
  'supabase/migrations/0006_bingo_editable_badges.sql',
)

type Sheet = {
  version: string
  totalCells: number
  categories: Record<
    string,
    { label: string; tone?: string; count?: number; note?: string }
  >
  cells: Array<Record<string, unknown>>
}

const sheet: Sheet = JSON.parse(readFileSync(SOURCE_PATH, 'utf8'))
const sql = readFileSync(SQL_PATH, 'utf8')
const badgeSql = readFileSync(BADGE_SQL_PATH, 'utf8')

/**
 * Extract the parenthesized tuple rows from the `values ... ` block of a named
 * `insert into public.<table>` statement, stopping at `on conflict`.
 */
function extractValuesBlock(table: string): string {
  const insertRe = new RegExp(
    `insert into public\\.${table}\\s*\\([^)]*\\)\\s*values`,
    'i',
  )
  const m = insertRe.exec(sql)
  if (!m) throw new Error(`No insert found for table ${table}`)
  const start = m.index + m[0].length
  const rest = sql.slice(start)
  const end = rest.search(/on conflict/i)
  return end === -1 ? rest : rest.slice(0, end)
}

/**
 * Tokenize a single `(...)` SQL tuple into its column literals, respecting
 * single-quoted strings (which contain commas, e.g. Korean hint text) and
 * '' escapes. Returns literals normalized to the generator's literal form:
 * 'foo''bar' stays a quoted literal, null/true/false/123 stay bare.
 */
function splitTupleLiterals(tuple: string): string[] {
  const out: string[] = []
  let buf = ''
  let inStr = false
  for (let i = 0; i < tuple.length; i++) {
    const ch = tuple[i]
    if (inStr) {
      buf += ch
      if (ch === "'") {
        if (tuple[i + 1] === "'") {
          buf += "'"
          i++
        } else {
          inStr = false
        }
      }
    } else if (ch === "'") {
      inStr = true
      buf += ch
    } else if (ch === ',') {
      out.push(buf.trim())
      buf = ''
    } else {
      buf += ch
    }
  }
  if (buf.trim().length) out.push(buf.trim())
  return out
}

/** Parse the row tuples from a values block into arrays of column literals. */
function parseRows(block: string): string[][] {
  const rows: string[][] = []
  let depth = 0
  let inStr = false
  let buf = ''
  for (let i = 0; i < block.length; i++) {
    const ch = block[i]
    if (inStr) {
      buf += ch
      if (ch === "'") {
        if (block[i + 1] === "'") {
          buf += "'"
          i++
        } else {
          inStr = false
        }
      }
      continue
    }
    if (ch === "'") {
      inStr = true
      buf += ch
      continue
    }
    if (ch === '(') {
      depth++
      if (depth === 1) {
        buf = ''
        continue
      }
    }
    if (ch === ')') {
      depth--
      if (depth === 0) {
        rows.push(splitTupleLiterals(buf))
        buf = ''
        continue
      }
    }
    if (depth >= 1) buf += ch
  }
  return rows
}

const contentBlock = extractValuesBlock('mission_content')
const categoryBlock = extractValuesBlock('mission_categories')
const sqlContentRows = parseRows(contentBlock)
const sqlCategoryRows = parseRows(categoryBlock)

const expected = buildSeedRows(sheet) as {
  contentRows: string[][]
  categoryRows: string[][]
}

/** Column literal of a parsed content row, by generator column name. */
function col(row: string[], name: string): string {
  const idx = (CONTENT_COLUMNS as string[]).indexOf(name)
  if (idx === -1) throw new Error(`Unknown column ${name}`)
  return row[idx]
}

function findContentRow(missionId: string): string[] {
  const row = sqlContentRows.find(
    (r) => col(r, 'mission_id') === `'${missionId}'`,
  )
  if (!row) throw new Error(`mission ${missionId} not found in SQL`)
  return row
}

function unquoteSqlLiteral(value: string): string {
  if (!value.startsWith("'") || !value.endsWith("'")) return value
  return value.slice(1, -1).replace(/''/g, "'")
}

function readSeededBadgeMissionIds(): Set<string> {
  const ids = new Set<string>()
  const regex = /'mission:([a-z0-9]+):v1'\s*,\s*'([a-z0-9]+)'/g
  let match: RegExpExecArray | null
  while ((match = regex.exec(badgeSql)) !== null) {
    const [, idFromBadgeId, missionId] = match
    expect(idFromBadgeId).toBe(missionId)
    ids.add(missionId)
  }
  return ids
}

describe('mission seed parity (sheet.source.json <-> 0010_mission_content.sql)', () => {
  it('emits one mission_content row per sheet cell (48) and one category row per category (7)', () => {
    expect(sheet.cells).toHaveLength(48)
    expect(Object.keys(sheet.categories)).toHaveLength(7)
    expect(sqlContentRows).toHaveLength(48)
    expect(sqlContentRows).toHaveLength(sheet.cells.length)
    expect(sqlCategoryRows).toHaveLength(7)
    expect(sqlCategoryRows).toHaveLength(Object.keys(sheet.categories).length)
    // totalCells declared in the sheet matches the emitted row count.
    expect(sheet.totalCells).toBe(sqlContentRows.length)
  })

  it('drift gate: every committed content row equals the generator output for that cell', () => {
    // The generator is the only mapping authority. Re-deriving from the sheet
    // and matching the committed SQL proves no manual edits / stale regen.
    expect(sqlContentRows).toEqual(expected.contentRows)
  })

  it('drift gate: every committed category row equals the generator output', () => {
    expect(sqlCategoryRows).toEqual(expected.categoryRows)
  })

  it('stamps the v1 catalog_version on every content and category row', () => {
    for (const row of sqlContentRows) {
      expect(col(row, 'catalog_version')).toBe(`'${CATALOG_VERSION}'`)
    }
    for (const row of sqlCategoryRows) {
      // catalog_version is the first column in the category tuple.
      expect(row[0]).toBe(`'${CATALOG_VERSION}'`)
    }
  })

  it('backs every seeded mission_badges row with mission_content and keeps FREE badge-less', () => {
    const contentMissionIds = new Set(
      sqlContentRows.map((row) => unquoteSqlLiteral(col(row, 'mission_id'))),
    )
    const badgeMissionIds = readSeededBadgeMissionIds()

    expect(badgeMissionIds.size).toBe(47)
    expect(badgeMissionIds.has('free')).toBe(false)

    const missingContent = [...badgeMissionIds].filter(
      (missionId) => !contentMissionIds.has(missionId),
    )
    expect(missingContent).toEqual([])
    expect(contentMissionIds.has('free')).toBe(true)
  })

  it('maps the FREE cell (special, fixed center, rAdyJ variant)', () => {
    const free = findContentRow('free')
    expect(col(free, 'label')).toBe("'FREE'")
    expect(col(free, 'category')).toBe("'special'")
    expect(col(free, 'variant')).toBe("'rAdyJ'")
    expect(col(free, 'fixed_position')).toBe("'center'")
    expect(col(free, 'camera')).toBe("'back'")
    expect(col(free, 'capture_label')).toBe("'오늘의 FREE 클립'")
    expect(col(free, 'icon')).toBe("'camera'")
  })

  it('maps a color cell c01 (swatch name only, no_photo absent, icon null)', () => {
    const c01 = findContentRow('c01')
    expect(col(c01, 'label')).toBe("'빨간색'")
    expect(col(c01, 'category')).toBe("'color'")
    expect(col(c01, 'caption')).toBe("'색 찾기'")
    expect(col(c01, 'capture_label')).toBe("'빨간색'")
    expect(col(c01, 'swatch')).toBe("'red'") // name only, no hex
    expect(col(c01, 'swatch_label')).toBe("'빨강'")
    expect(col(c01, 'icon')).toBe('null') // explicit null icon, key preserved
  })

  it('maps a self cell sf01 (front camera, easy difficulty, k4Srv variant)', () => {
    const sf01 = findContentRow('sf01')
    expect(col(sf01, 'label')).toBe("'활짝 웃은 셀카'")
    expect(col(sf01, 'category')).toBe("'self'")
    expect(col(sf01, 'variant')).toBe("'k4Srv'")
    expect(col(sf01, 'camera')).toBe("'front'")
    expect(col(sf01, 'difficulty')).toBe("'easy'")
  })

  it('maps a number cell t01 (textOnly -> text_only, fontSize -> font_size, captureLabel -> capture_label, icon null)', () => {
    const t01 = findContentRow('t01')
    expect(col(t01, 'label')).toBe("'7'")
    expect(col(t01, 'category')).toBe("'time'")
    expect(col(t01, 'caption')).toBe("'숫자 찾기'")
    expect(col(t01, 'capture_label')).toBe("'숫자 7'") // captureLabel camel->snake
    expect(col(t01, 'text_only')).toBe('true') // textOnly camel->snake, boolean
    expect(col(t01, 'font_size')).toBe('34') // fontSize camel->snake, integer
    expect(col(t01, 'icon')).toBe('null')
  })

  it('keeps icon as a value when present (n01) and null when absent (c08)', () => {
    expect(col(findContentRow('n01'), 'icon')).toBe("'flower-2'")
    expect(col(findContentRow('c08'), 'icon')).toBe('null')
  })

  it('maps mission_categories label/tone/count for representative keys', () => {
    const byKey = new Map(sqlCategoryRows.map((r) => [r[1], r]))
    // category tuple order: catalog_version, key, label, tone, count
    expect(byKey.get("'self'")).toEqual([
      `'${CATALOG_VERSION}'`,
      "'self'",
      "'셀프'",
      "'cat-self'",
      '9',
    ])
    expect(byKey.get("'color'")).toEqual([
      `'${CATALOG_VERSION}'`,
      "'color'",
      "'색깔'",
      "'cat-color'",
      '8',
    ])
    expect(byKey.get("'special'")).toEqual([
      `'${CATALOG_VERSION}'`,
      "'special'",
      "'특수'",
      "'brand-accent'",
      '1',
    ])
  })

  it('preserves source cell order via sort_order = index * 10', () => {
    sqlContentRows.forEach((row, i) => {
      expect(col(row, 'sort_order')).toBe(String(i * 10))
    })
  })
})
