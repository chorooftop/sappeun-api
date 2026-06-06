import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { BadgesService } from '@/badges/badges.service'
import type { BoardCellRow, BoardRow } from '@/boards/boards.service'

type QueryResult = {
  data: unknown
  error: Error | null
}

type EqCall = { column: string; value: unknown }

function makeQuery(result: QueryResult, onEq?: (call: EqCall) => void) {
  const query: Record<string, unknown> = {
    select: () => query,
    eq: (column: string, value: unknown) => {
      onEq?.({ column, value })
      return query
    },
    in: () => query,
    is: () => query,
    not: () => query,
    order: () => query,
    limit: () => query,
    maybeSingle: () => Promise.resolve(result),
    then: (
      resolve: (value: QueryResult) => unknown,
      reject?: (error: unknown) => unknown,
    ) => Promise.resolve(result).then(resolve, reject),
  }
  return query
}

function makeAdmin(
  queues: Record<string, QueryResult[]>,
  rpc?: { result: QueryResult; calls: unknown[] },
  eqCalls?: Record<string, EqCall[]>,
) {
  return {
    from(table: string) {
      const next = queues[table]?.shift()
      if (!next) throw new Error(`Unexpected table query: ${table}`)
      return makeQuery(next, (call) => {
        if (!eqCalls) return
        ;(eqCalls[table] ??= []).push(call)
      })
    },
    rpc(name: string, args: unknown) {
      rpc?.calls.push({ name, args })
      return Promise.resolve(rpc?.result ?? { data: [], error: null })
    },
  }
}

function makeService(
  admin: ReturnType<typeof makeAdmin>,
): BadgesService {
  return new BadgesService({ adminClient: admin } as never)
}

function catalogRow(
  overrides: Partial<{
    id: string
    mission_id: string
    catalog_version: string
    title: string
    category: string | null
    difficulty: string
    grade_label: string
    grade_color: string
    artwork_key: string | null
    sort_order: number
    active: boolean
  }> = {},
) {
  return {
    id: overrides.id ?? 'mission:n01:v1',
    mission_id: overrides.mission_id ?? 'n01',
    catalog_version: overrides.catalog_version ?? 'api-migration-v1',
    title: overrides.title ?? '꽃',
    category: overrides.category ?? 'nature',
    difficulty: overrides.difficulty ?? 'easy',
    grade_label: overrides.grade_label ?? '일상 배지',
    grade_color: overrides.grade_color ?? '#6ED6A0',
    artwork_key: overrides.artwork_key ?? 'mission/n01',
    sort_order: overrides.sort_order ?? 10,
    active: overrides.active ?? true,
  }
}

function userBadgeRow(
  overrides: Partial<{
    badge_id: string
    earned_count: number
    first_earned_at: string
    last_earned_at: string
    last_board_id: string | null
    first_board_id: string | null
  }> = {},
) {
  return {
    user_id: 'user-1',
    badge_id: overrides.badge_id ?? 'mission:n01:v1',
    first_board_id: overrides.first_board_id ?? 'board-1',
    last_board_id: overrides.last_board_id ?? 'board-1',
    first_earned_at: overrides.first_earned_at ?? '2026-06-03T00:00:00.000Z',
    last_earned_at: overrides.last_earned_at ?? '2026-06-03T00:00:00.000Z',
    earned_count: overrides.earned_count ?? 1,
  }
}

function board(overrides: Partial<BoardRow> = {}): BoardRow {
  return {
    id: 'board-1',
    user_id: 'user-1',
    mode: '3x3',
    board_kind: 'mission',
    client_session_id: 'session-1',
    nickname: '사뿐',
    title: '봄 산책',
    description: null,
    free_position: 4,
    cell_ids: Array.from({ length: 9 }, (_, index) => `m0${index}`),
    created_at: '2026-06-03T00:00:00.000Z',
    updated_at: '2026-06-03T00:10:00.000Z',
    ended_at: null,
    deleted_at: null,
    customization_status: 'official',
    ...overrides,
  }
}

function missionCell(
  position: number,
  overrides: Partial<BoardCellRow> = {},
): BoardCellRow {
  return {
    board_id: 'board-1',
    position,
    cell_id: `m0${position}`,
    photo_id: null,
    clip_id: null,
    marked_at: null,
    completed_at: position === 4 ? null : '2026-06-03T00:20:00.000Z',
    completion_type: position === 4 ? null : 'no_media',
    mission_label: null,
    mission_capture_label: null,
    mission_category: null,
    mission_snapshot: {
      id: `m0${position}`,
      category: 'nature',
      label: `m0${position}`,
      icon: null,
      variant: 'QeQCU',
    },
    mission_catalog_version: 'api-migration-v1',
    ...overrides,
  }
}

function eligibleCells(): BoardCellRow[] {
  return Array.from({ length: 9 }, (_, position) => missionCell(position))
}

describe('BadgesService.listCatalog', () => {
  it('maps mission_badges rows to the catalog response shape', async () => {
    const admin = makeAdmin({
      mission_badges: [
        {
          data: [
            catalogRow(),
            catalogRow({
              id: 'mission:sf06:v1',
              mission_id: 'sf06',
              title: '내 그림자',
              category: 'self',
              difficulty: 'medium',
              grade_label: '도전 배지',
              grade_color: '#F5A623',
              artwork_key: 'mission/sf06',
              sort_order: 360,
            }),
          ],
          error: null,
        },
      ],
    })

    const result = await makeService(admin).listCatalog()

    expect(result).toEqual([
      expect.objectContaining({
        badgeId: 'mission:n01:v1',
        missionId: 'n01',
        catalogVersion: 'api-migration-v1',
        title: '꽃',
        category: 'nature',
        difficulty: 'easy',
        gradeLabel: '일상 배지',
        gradeColor: '#6ED6A0',
        artworkKey: 'mission/n01',
        sortOrder: 10,
      }),
      expect.objectContaining({
        badgeId: 'mission:sf06:v1',
        difficulty: 'medium',
        gradeColor: '#F5A623',
      }),
    ])
  })

  it('scopes the catalog query to the active catalog version', async () => {
    const eqCalls: Record<string, EqCall[]> = {}
    const admin = makeAdmin(
      { mission_badges: [{ data: [catalogRow()], error: null }] },
      undefined,
      eqCalls,
    )

    await makeService(admin).listCatalog()

    expect(eqCalls.mission_badges).toContainEqual({
      column: 'catalog_version',
      value: 'api-migration-v1',
    })
    expect(eqCalls.mission_badges).toContainEqual({
      column: 'active',
      value: true,
    })
  })
})

describe('BadgesService.listUserBadges', () => {
  function catalogFixture() {
    return [
      catalogRow({ id: 'mission:n01:v1', mission_id: 'n01', difficulty: 'easy' }),
      catalogRow({ id: 'mission:n02:v1', mission_id: 'n02', difficulty: 'easy' }),
      catalogRow({
        id: 'mission:sf06:v1',
        mission_id: 'sf06',
        difficulty: 'medium',
      }),
      catalogRow({
        id: 'mission:hard:v1',
        mission_id: 'hard',
        difficulty: 'hard',
      }),
    ]
  }

  it('computes summary counts and respects difficulty + status filters', async () => {
    const admin = makeAdmin({
      mission_badges: [{ data: catalogFixture(), error: null }],
      user_badges: [
        {
          data: [
            userBadgeRow({ badge_id: 'mission:n01:v1', earned_count: 2 }),
            userBadgeRow({ badge_id: 'mission:sf06:v1', earned_count: 1 }),
          ],
          error: null,
        },
      ],
    })

    const result = await makeService(admin).listUserBadges('user-1', {
      difficulty: 'all',
      status: 'all',
    })

    expect(result.summary).toEqual({
      earnedCount: 2,
      totalCount: 4,
      easyEarnedCount: 1,
      mediumEarnedCount: 1,
      hardEarnedCount: 0,
    })
    expect(result.badges).toHaveLength(4)
  })

  it('filters to earned easy badges only', async () => {
    const admin = makeAdmin({
      mission_badges: [{ data: catalogFixture(), error: null }],
      user_badges: [
        {
          data: [
            userBadgeRow({ badge_id: 'mission:n01:v1', earned_count: 2 }),
            userBadgeRow({ badge_id: 'mission:sf06:v1', earned_count: 1 }),
          ],
          error: null,
        },
      ],
    })

    const result = await makeService(admin).listUserBadges('user-1', {
      difficulty: 'easy',
      status: 'earned',
    })

    expect(result.badges).toEqual([
      expect.objectContaining({
        badgeId: 'mission:n01:v1',
        earned: true,
        earnedCount: 2,
      }),
    ])
    // Summary is over the whole catalog, not the filtered slice.
    expect(result.summary.totalCount).toBe(4)
    expect(result.summary.earnedCount).toBe(2)
  })

  it('filters to locked badges only', async () => {
    const admin = makeAdmin({
      mission_badges: [{ data: catalogFixture(), error: null }],
      user_badges: [
        {
          data: [userBadgeRow({ badge_id: 'mission:n01:v1', earned_count: 1 })],
          error: null,
        },
      ],
    })

    const result = await makeService(admin).listUserBadges('user-1', {
      difficulty: 'all',
      status: 'locked',
    })

    expect(result.badges.map((badge) => badge.badgeId)).toEqual([
      'mission:n02:v1',
      'mission:sf06:v1',
      'mission:hard:v1',
    ])
    expect(result.badges.every((badge) => badge.earned === false)).toBe(true)
  })
})

describe('BadgesService.getUserBadgeDetail', () => {
  it('returns an earned badge with its user collection data', async () => {
    const admin = makeAdmin({
      mission_badges: [{ data: catalogRow(), error: null }],
      user_badges: [
        {
          data: userBadgeRow({
            badge_id: 'mission:n01:v1',
            earned_count: 2,
            first_board_id: 'board-first',
            last_board_id: 'board-last',
            first_earned_at: '2026-06-01T00:00:00.000Z',
            last_earned_at: '2026-06-03T00:00:00.000Z',
          }),
          error: null,
        },
      ],
    })

    const result = await makeService(admin).getUserBadgeDetail(
      'user-1',
      'mission:n01:v1',
    )

    expect(result).toEqual(
      expect.objectContaining({
        badgeId: 'mission:n01:v1',
        earned: true,
        earnedCount: 2,
        firstEarnedAt: '2026-06-01T00:00:00.000Z',
        lastEarnedAt: '2026-06-03T00:00:00.000Z',
        // sourceBoardId is unified with the list endpoint: most recent board.
        sourceBoardId: 'board-last',
      }),
    )
  })

  it('returns a locked badge when the user has not earned it', async () => {
    const admin = makeAdmin({
      mission_badges: [{ data: catalogRow(), error: null }],
      user_badges: [{ data: null, error: null }],
    })

    const result = await makeService(admin).getUserBadgeDetail(
      'user-1',
      'mission:n01:v1',
    )

    expect(result).toEqual(
      expect.objectContaining({
        badgeId: 'mission:n01:v1',
        earned: false,
        earnedCount: 0,
        sourceBoardId: null,
      }),
    )
  })
})

describe('BadgesService.awardBoardBadges', () => {
  it('collects official mission badge ids, calls the RPC, and maps the result', async () => {
    const rpc = {
      result: {
        data: [
          { badge_id: 'mission:m00:v1', is_first_earn: true },
          { badge_id: 'mission:m01:v1', is_first_earn: false },
        ],
        error: null,
      },
      calls: [] as unknown[],
    }
    const admin = makeAdmin(
      {
        mission_badges: [
          {
            data: [
              {
                id: 'mission:m00:v1',
                mission_id: 'm00',
                title: '꽃',
                difficulty: 'easy',
                grade_color: '#6ED6A0',
                grade_label: '일상 배지',
                active: true,
              },
              {
                id: 'mission:m01:v1',
                mission_id: 'm01',
                title: '나뭇잎',
                difficulty: 'medium',
                grade_color: '#F5A623',
                grade_label: '도전 배지',
                active: true,
              },
            ],
            error: null,
          },
        ],
      },
      rpc,
    )

    // Free position (4) is excluded from minting; remaining 8 cells map to badges.
    const result = await makeService(admin).awardBoardBadges({
      userId: 'user-1',
      board: board(),
      cells: eligibleCells(),
    })

    expect(rpc.calls).toHaveLength(1)
    expect(rpc.calls[0]).toEqual({
      name: 'award_board_badges',
      args: expect.objectContaining({
        p_user_id: 'user-1',
        p_board_id: 'board-1',
        p_badge_ids: expect.arrayContaining([
          'mission:m00:v1',
          'mission:m01:v1',
        ]),
      }),
    })
    // Free cell (m04) must not be among the badge ids.
    const args = (rpc.calls[0] as { args: { p_badge_ids: string[] } }).args
    expect(args.p_badge_ids).not.toContain('mission:m04:v1')

    expect(result.badgeEligible).toBe(true)
    expect(result.badgeCount).toBe(2)
    expect(result.earnedBadges).toEqual([
      expect.objectContaining({
        badgeId: 'mission:m00:v1',
        difficulty: 'easy',
        gradeColor: '#6ED6A0',
        isFirstEarn: true,
      }),
      expect.objectContaining({
        badgeId: 'mission:m01:v1',
        difficulty: 'medium',
        gradeColor: '#F5A623',
        isFirstEarn: false,
      }),
    ])
  })

  it('does not call the RPC for an edited board', async () => {
    const rpc = { result: { data: [], error: null }, calls: [] as unknown[] }
    const cells = eligibleCells().map((cell, index) =>
      index === 0
        ? {
            ...cell,
            original_cell_id: cell.cell_id,
            original_mission_snapshot: cell.mission_snapshot ?? null,
          }
        : cell,
    )
    const admin = makeAdmin({}, rpc)

    const result = await makeService(admin).awardBoardBadges({
      userId: 'user-1',
      board: board(),
      cells,
    })

    expect(rpc.calls).toHaveLength(0)
    expect(result).toEqual({
      badgeEligible: false,
      badgeCount: 0,
      earnedBadges: [],
    })
  })

  it('does not call the RPC for a non-mission board', async () => {
    const rpc = { result: { data: [], error: null }, calls: [] as unknown[] }
    const admin = makeAdmin({}, rpc)

    const result = await makeService(admin).awardBoardBadges({
      userId: 'user-1',
      board: board({ board_kind: 'custom' }),
      cells: eligibleCells(),
    })

    expect(rpc.calls).toHaveLength(0)
    expect(result.badgeEligible).toBe(false)
  })

  it('does not call the RPC for an incomplete board', async () => {
    const rpc = { result: { data: [], error: null }, calls: [] as unknown[] }
    const cells = eligibleCells().map((cell, index) =>
      index === 0
        ? {
            ...cell,
            completed_at: null,
            marked_at: null,
            completion_type: null,
          }
        : cell,
    )
    const admin = makeAdmin({}, rpc)

    const result = await makeService(admin).awardBoardBadges({
      userId: 'user-1',
      board: board(),
      cells,
    })

    expect(rpc.calls).toHaveLength(0)
    expect(result.badgeEligible).toBe(false)
  })

  // CORR-4 / M2 — cross-board concurrency contract test.
  //
  // This repo has no Postgres integration harness (the service is unit-tested
  // against a mocked admin client + mocked rpc). We therefore assert the RPC
  // *contract* that guarantees earned_count == 2 when two distinct official
  // boards owned by the same user share a mission id: each board issues its own
  // independent `award_board_badges` rpc invocation carrying the shared badge id.
  //
  // The atomic increment itself (`earned_count = user_badges.earned_count + 1`,
  // chained data-modifying CTE with on-conflict) is enforced DB-side by the
  // RPC SQL in supabase/migrations/0006_bingo_editable_badges.sql §7 — two
  // sequential/concurrent invocations each flow exactly one new board_badges
  // row into the user_badges rollup, so the post-update earned_count is 2.
  it('issues one RPC per board for the shared mission id (cross-board contract)', async () => {
    const rpc = {
      result: {
        data: [{ badge_id: 'mission:m00:v1', is_first_earn: true }],
        error: null,
      },
      calls: [] as unknown[],
    }
    const sharedCatalog = {
      data: [
        {
          id: 'mission:m00:v1',
          mission_id: 'm00',
          title: '꽃',
          difficulty: 'easy',
          grade_color: '#6ED6A0',
          grade_label: '일상 배지',
          active: true,
        },
      ],
      error: null,
    }
    // Two boards, each a single official mission cell with the SAME mission id
    // (plus the free center) — fully completed, unedited.
    const sharedBoard = (id: string): BoardRow =>
      board({ id, cell_ids: ['m00'], free_position: 1, mode: '3x3' })
    const sharedCells = (boardId: string): BoardCellRow[] => [
      missionCell(0, { board_id: boardId, cell_id: 'm00' }),
      // free position
      missionCell(1, {
        board_id: boardId,
        cell_id: 'm01',
        completed_at: null,
        completion_type: null,
      }),
    ]
    const admin = makeAdmin(
      {
        mission_badges: [sharedCatalog, sharedCatalog],
      },
      rpc,
    )
    const service = makeService(admin)

    await service.awardBoardBadges({
      userId: 'user-1',
      board: sharedBoard('board-a'),
      cells: sharedCells('board-a'),
    })
    await service.awardBoardBadges({
      userId: 'user-1',
      board: sharedBoard('board-b'),
      cells: sharedCells('board-b'),
    })

    // Two independent RPC invocations, one per board, both carrying the shared
    // badge id. DB-side atomic increment (migration 0006 §7) makes the
    // resulting user_badges.earned_count == 2.
    expect(rpc.calls).toHaveLength(2)
    const boardIds = (rpc.calls as { args: { p_board_id: string } }[]).map(
      (call) => call.args.p_board_id,
    )
    expect(boardIds).toEqual(['board-a', 'board-b'])
    for (const call of rpc.calls as { args: { p_badge_ids: string[] } }[]) {
      expect(call.args.p_badge_ids).toContain('mission:m00:v1')
    }
  })
})

describe('BadgesService.getBoardBadges', () => {
  it('returns an empty map when there are no board ids', async () => {
    const admin = makeAdmin({})
    const result = await makeService(admin).getBoardBadges('user-1', [])
    expect(result.size).toBe(0)
  })

  it('groups board_badges rows by board with catalog metadata', async () => {
    const admin = makeAdmin({
      board_badges: [
        {
          data: [
            {
              board_id: 'board-1',
              badge_id: 'mission:n01:v1',
              user_id: 'user-1',
              earned_at: '2026-06-03T00:30:00.000Z',
            },
          ],
          error: null,
        },
      ],
      mission_badges: [{ data: [catalogRow()], error: null }],
    })

    const result = await makeService(admin).getBoardBadges('user-1', ['board-1'])

    expect(result.get('board-1')).toEqual([
      expect.objectContaining({
        badgeId: 'mission:n01:v1',
        missionId: 'n01',
        difficulty: 'easy',
        gradeColor: '#6ED6A0',
      }),
    ])
  })
})

// Seed coverage guard (CORR-10): every non-free official mission id present in
// the frontend sheet.json must have a corresponding seed row in migration 0006.
// This protects against catalog drift that would silently drop official badges.
describe('badge catalog seed coverage', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const repoRoot = resolve(here, '..', '..')
  // Cross-repo authoritative mission catalog. Present locally (sibling repo),
  // may be absent in CI — skip the drift guard there rather than fail on ENOENT.
  const sheetPath = resolve(
    repoRoot,
    '..',
    'sappeun-frontend',
    'apps',
    'mobile',
    'assets',
    'data',
    'sheet.json',
  )
  const sheetAvailable = existsSync(sheetPath)

  function readMissionIdsFromSheet(): string[] {
    const sheet = JSON.parse(readFileSync(sheetPath, 'utf8')) as {
      cells: { id: string; category?: string }[]
    }
    return sheet.cells
      .filter((cell) => cell.id !== 'free' && cell.category !== 'special')
      .map((cell) => cell.id)
  }

  function readSeededMissionIds(): Set<string> {
    const migrationPath = resolve(
      repoRoot,
      'supabase',
      'migrations',
      '0006_bingo_editable_badges.sql',
    )
    const sql = readFileSync(migrationPath, 'utf8')
    const ids = new Set<string>()
    // badge id format: mission:<id>:v1
    const regex = /'mission:([a-z0-9]+):v1'/g
    let match: RegExpExecArray | null
    while ((match = regex.exec(sql)) !== null) {
      ids.add(match[1])
    }
    return ids
  }

  it.skipIf(!sheetAvailable)('seeds every official mission id from sheet.json (47 missions, free excluded)', () => {
    const missionIds = readMissionIdsFromSheet()
    const seeded = readSeededMissionIds()

    expect(missionIds).toHaveLength(47)
    expect(missionIds).not.toContain('free')

    const missing = missionIds.filter((id) => !seeded.has(id))
    expect(missing).toEqual([])
  })

  it('does not seed a badge for the free cell', () => {
    const seeded = readSeededMissionIds()
    expect(seeded.has('free')).toBe(false)
  })
})
