import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

const migrationSql = readFileSync(
  join(process.cwd(), 'supabase/migrations/0017_badge_awards_mission_id_anchor.sql'),
  'utf8',
)

describe('badge award migration contract', () => {
  it('keeps the RPC award gate aligned with awardable active mission content', () => {
    expect(migrationSql).toContain('and m.awards_badge = true')
    expect(migrationSql).toContain('and m.active = true')
  })

  it('keeps idempotent award rollups on named constraints', () => {
    expect(migrationSql).toContain(
      'on conflict on constraint board_badges_pkey do nothing',
    )
    expect(migrationSql).toContain(
      'on conflict on constraint user_badges_pkey do update',
    )
  })
})
