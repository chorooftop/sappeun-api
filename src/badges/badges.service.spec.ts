import { describe, expect, it } from 'vitest'

import { BadgesService } from '@/badges/badges.service'
import type { BoardCellRow, BoardRow } from '@/boards/boards.service'

type QueryResult = {
  data: unknown
  error: Error | null
}

type EqCall = { column: string; value: unknown }
type SelectCall = { columns: string }

function makeQuery(
  result: QueryResult,
  onEq?: (call: EqCall) => void,
  onSelect?: (call: SelectCall) => void,
) {
  const query: Record<string, unknown> = {
    select: (columns = '*') => {
      onSelect?.({ columns: String(columns) })
      return query
    },
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
  selectCalls?: Record<string, SelectCall[]>,
) {
  return {
    from(table: string) {
      const next = queues[table]?.shift()
      if (!next) throw new Error(`Unexpected table query: ${table}`)
      return makeQuery(
        next,
        (call) => {
          if (!eqCalls) return
          ;(eqCalls[table] ??= []).push(call)
        },
        (call) => {
          if (!selectCalls) return
          ;(selectCalls[table] ??= []).push(call)
        },
      )
    },
    rpc(name: string, args: unknown) {
      rpc?.calls.push({ name, args })
      return Promise.resolve(rpc?.result ?? { data: [], error: null })
    },
  }
}

function makeService(admin: ReturnType<typeof makeAdmin>): BadgesService {
  return new BadgesService({ adminClient: admin } as never)
}

function expectMissionContentSelect(select: string) {
  expect(select).toContain('mission_id')
  expect(select).toContain('awards_badge')
  expect(select).toContain('artwork')
  expect(select).not.toContain('grade_label')
  expect(select).not.toContain('grade_color')
  expect(select).not.toContain('artwork_key')
}

function catalogRow(
  overrides: Partial<{
    mission_id: string
    catalog_version: string
    title: string
    category: string
    difficulty: string
    artwork: unknown
    awards_badge: boolean
    sort_order: number
    active: boolean
    min_app_build: number | null
    required_capabilities: string[]
    active_from: string | null
    active_until: string | null
  }> = {},
) {
  return {
    mission_id: overrides.mission_id ?? 'n01',
    catalog_version: overrides.catalog_version ?? 'api-migration-v1',
    label: overrides.title ?? '꽃',
    category: overrides.category ?? 'nature',
    difficulty: overrides.difficulty ?? 'easy',
    artwork: overrides.artwork ?? null,
    awards_badge: overrides.awards_badge ?? true,
    sort_order: overrides.sort_order ?? 10,
    active: overrides.active ?? true,
    min_app_build: overrides.min_app_build ?? null,
    required_capabilities: overrides.required_capabilities ?? [],
    active_from: overrides.active_from ?? null,
    active_until: overrides.active_until ?? null,
  }
}

function userBadgeRow(
  overrides: Partial<{
    mission_id: string
    earned_count: number
    first_earned_at: string
    last_earned_at: string
    last_board_id: string | null
    first_board_id: string | null
  }> = {},
) {
  return {
    user_id: 'user-1',
    mission_id: overrides.mission_id ?? 'n01',
    earned_catalog_version: 'api-migration-v1',
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
  it('maps mission_content rows to the catalog response shape', async () => {
    const admin = makeAdmin({
      mission_content: [
        {
          data: [
            catalogRow(),
            catalogRow({
              mission_id: 'sf06',
              title: '내 그림자',
              category: 'self',
              difficulty: 'medium',
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
        badgeId: 'n01',
        missionId: 'n01',
        catalogVersion: 'api-migration-v1',
        title: '꽃',
        category: 'nature',
        difficulty: 'easy',
        gradeLabel: '일상 배지',
        gradeColor: '#6ED6A0',
        sortOrder: 10,
      }),
      expect.objectContaining({
        badgeId: 'sf06',
        difficulty: 'medium',
        gradeLabel: '도전 배지',
        gradeColor: '#F5A623',
      }),
    ])
    expect(result[0]).not.toHaveProperty('artworkKey')
  })

  it('uses mission_content artwork directly', async () => {
    const artwork = {
      schemaVersion: 1,
      type: 'lucide',
      key: 'flower-2',
    }
    const admin = makeAdmin({
      mission_content: [
        {
          data: [catalogRow({ artwork })],
          error: null,
        },
      ],
    })

    const result = await makeService(admin).listCatalog()

    expect(result[0]).toMatchObject({ artwork })
  })

  it('filters gated catalog rows for legacy clients', async () => {
    const rows = [
      catalogRow({ mission_id: 'n01' }),
      catalogRow({
        mission_id: 'new',
        required_capabilities: ['runtime-artwork-v1'],
        min_app_build: 202606080001,
      }),
    ]
    const legacy = await makeService(
      makeAdmin({ mission_content: [{ data: rows, error: null }] }),
    ).listCatalog()
    expect(legacy.map((badge) => badge.badgeId)).toEqual(['n01'])

    const runtime = await makeService(
      makeAdmin({ mission_content: [{ data: rows, error: null }] }),
    ).listCatalog({
      appBuild: 202606080001,
      capabilities: new Set(['runtime-artwork-v1']),
    })
    expect(runtime.map((badge) => badge.badgeId)).toEqual(['n01', 'new'])
  })

  it('scopes the catalog query to active awardable mission_content', async () => {
    const eqCalls: Record<string, EqCall[]> = {}
    const selectCalls: Record<string, SelectCall[]> = {}
    const admin = makeAdmin(
      { mission_content: [{ data: [catalogRow()], error: null }] },
      undefined,
      eqCalls,
      selectCalls,
    )

    await makeService(admin).listCatalog()

    expect(eqCalls.mission_content).toContainEqual({
      column: 'catalog_version',
      value: 'api-migration-v1',
    })
    expect(eqCalls.mission_content).toContainEqual({
      column: 'active',
      value: true,
    })
    expect(eqCalls.mission_content).toContainEqual({
      column: 'awards_badge',
      value: true,
    })
    expectMissionContentSelect(selectCalls.mission_content[0].columns)
  })
})

describe('BadgesService.listUserBadges', () => {
  function catalogFixture() {
    return [
      catalogRow({ mission_id: 'n01', difficulty: 'easy' }),
      catalogRow({ mission_id: 'n02', difficulty: 'easy' }),
      catalogRow({ mission_id: 'sf06', difficulty: 'medium' }),
      catalogRow({ mission_id: 'hard', difficulty: 'hard' }),
    ]
  }

  it('computes summary counts and respects difficulty + status filters', async () => {
    const admin = makeAdmin({
      mission_content: [{ data: catalogFixture(), error: null }],
      user_badges: [
        {
          data: [
            userBadgeRow({ mission_id: 'n01', earned_count: 2 }),
            userBadgeRow({ mission_id: 'sf06', earned_count: 1 }),
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
      mission_content: [{ data: catalogFixture(), error: null }],
      user_badges: [
        {
          data: [
            userBadgeRow({ mission_id: 'n01', earned_count: 2 }),
            userBadgeRow({ mission_id: 'sf06', earned_count: 1 }),
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
        badgeId: 'n01',
        earned: true,
        earnedCount: 2,
      }),
    ])
    expect(result.summary.totalCount).toBe(4)
    expect(result.summary.earnedCount).toBe(2)
  })

  it('filters to locked badges only', async () => {
    const admin = makeAdmin({
      mission_content: [{ data: catalogFixture(), error: null }],
      user_badges: [
        {
          data: [userBadgeRow({ mission_id: 'n01', earned_count: 1 })],
          error: null,
        },
      ],
    })

    const result = await makeService(admin).listUserBadges('user-1', {
      difficulty: 'all',
      status: 'locked',
    })

    expect(result.badges.map((badge) => badge.badgeId)).toEqual([
      'n02',
      'sf06',
      'hard',
    ])
    expect(result.badges.every((badge) => badge.earned === false)).toBe(true)
  })
})

describe('BadgesService.getUserBadgeDetail', () => {
  it('returns an earned badge with its user collection data', async () => {
    const admin = makeAdmin({
      mission_content: [{ data: catalogRow(), error: null }],
      user_badges: [
        {
          data: userBadgeRow({
            mission_id: 'n01',
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

    const result = await makeService(admin).getUserBadgeDetail('user-1', 'n01')

    expect(result).toEqual(
      expect.objectContaining({
        badgeId: 'n01',
        earned: true,
        earnedCount: 2,
        firstEarnedAt: '2026-06-01T00:00:00.000Z',
        lastEarnedAt: '2026-06-03T00:00:00.000Z',
        sourceBoardId: 'board-last',
      }),
    )
  })

  it('returns a locked badge when the user has not earned it', async () => {
    const admin = makeAdmin({
      mission_content: [{ data: catalogRow(), error: null }],
      user_badges: [{ data: null, error: null }],
    })

    const result = await makeService(admin).getUserBadgeDetail('user-1', 'n01')

    expect(result).toEqual(
      expect.objectContaining({
        badgeId: 'n01',
        earned: false,
        earnedCount: 0,
        sourceBoardId: null,
      }),
    )
  })
})

describe('BadgesService.awardBoardBadges', () => {
  it('collects official mission ids, calls the RPC, and maps the result', async () => {
    const selectCalls: Record<string, SelectCall[]> = {}
    const rpc = {
      result: {
        data: [
          { badge_id: 'm00', is_first_earn: true },
          { badge_id: 'm01', is_first_earn: false },
        ],
        error: null,
      },
      calls: [] as unknown[],
    }
    const admin = makeAdmin(
      {
        mission_content: [
          {
            data: [
              catalogRow({
                mission_id: 'm00',
                title: '꽃',
                difficulty: 'easy',
              }),
              catalogRow({
                mission_id: 'm01',
                title: '나뭇잎',
                difficulty: 'medium',
              }),
            ],
            error: null,
          },
        ],
      },
      rpc,
      undefined,
      selectCalls,
    )

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
        p_badge_ids: expect.arrayContaining(['m00', 'm01']),
      }),
    })
    const args = (rpc.calls[0] as { args: { p_badge_ids: string[] } }).args
    expect(args.p_badge_ids).not.toContain('m04')

    expect(result.badgeEligible).toBe(true)
    expect(result.badgeCount).toBe(2)
    expectMissionContentSelect(selectCalls.mission_content[0].columns)
    expect(result.earnedBadges).toEqual([
      expect.objectContaining({
        badgeId: 'm00',
        difficulty: 'easy',
        gradeColor: '#6ED6A0',
        isFirstEarn: true,
      }),
      expect.objectContaining({
        badgeId: 'm01',
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

  it('issues one RPC per board for the shared mission id (cross-board contract)', async () => {
    const rpc = {
      result: {
        data: [{ badge_id: 'm00', is_first_earn: true }],
        error: null,
      },
      calls: [] as unknown[],
    }
    const sharedCatalog = {
      data: [
        catalogRow({
          mission_id: 'm00',
          title: '꽃',
          difficulty: 'easy',
        }),
      ],
      error: null,
    }
    const sharedBoard = (id: string): BoardRow =>
      board({ id, cell_ids: ['m00'], free_position: 1, mode: '3x3' })
    const sharedCells = (boardId: string): BoardCellRow[] => [
      missionCell(0, { board_id: boardId, cell_id: 'm00' }),
      missionCell(1, {
        board_id: boardId,
        cell_id: 'm01',
        completed_at: null,
        completion_type: null,
      }),
    ]
    const admin = makeAdmin(
      {
        mission_content: [sharedCatalog, sharedCatalog],
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

    expect(rpc.calls).toHaveLength(2)
    const boardIds = (rpc.calls as { args: { p_board_id: string } }[]).map(
      (call) => call.args.p_board_id,
    )
    expect(boardIds).toEqual(['board-a', 'board-b'])
    for (const call of rpc.calls as { args: { p_badge_ids: string[] } }[]) {
      expect(call.args.p_badge_ids).toContain('m00')
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
              mission_id: 'n01',
              user_id: 'user-1',
              earned_at: '2026-06-03T00:30:00.000Z',
            },
          ],
          error: null,
        },
      ],
      mission_content: [{ data: [catalogRow()], error: null }],
    })

    const result = await makeService(admin).getBoardBadges('user-1', [
      'board-1',
    ])

    expect(result.get('board-1')).toEqual([
      expect.objectContaining({
        badgeId: 'n01',
        missionId: 'n01',
        difficulty: 'easy',
        gradeColor: '#6ED6A0',
      }),
    ])
  })
})
