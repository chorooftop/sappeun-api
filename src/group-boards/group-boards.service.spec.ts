import { describe, expect, it, vi } from 'vitest'

import type {
  GroupBoardCellRow,
  GroupBoardRow,
} from '@/group-boards/group-board.types'
import { GroupBoardsService } from '@/group-boards/group-boards.service'

type QueryResult = { data: unknown; error: Error | null }
type RpcCall = { name: string; args: Record<string, unknown> }

function makeQuery(result: QueryResult) {
  const query: Record<string, unknown> = {
    select: () => query,
    update: () => query,
    eq: () => query,
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
  rpcQueue: QueryResult[] = [],
  rpcCalls: RpcCall[] = [],
  tableCalls: string[] = [],
) {
  return {
    from(table: string) {
      tableCalls.push(table)
      const next = queues[table]?.shift()
      if (!next) throw new Error(`Unexpected table query: ${table}`)
      return makeQuery(next)
    },
    rpc(name: string, args: Record<string, unknown>) {
      rpcCalls.push({ name, args })
      const next = rpcQueue.shift()
      return Promise.resolve(next ?? { data: null, error: null })
    },
  }
}

const NOW = new Date('2026-07-14T03:00:00.000Z') // 2026-07-14 12:00 KST

function makeBoard(overrides: Partial<GroupBoardRow> = {}): GroupBoardRow {
  return {
    id: 'board-1',
    group_id: 'group-1',
    daily_date: '2026-07-14',
    mode: '3x3',
    seed_recipe: '{}',
    cell_ids: ['a', 'b', 'c', 'd', 'free', 'f', 'g', 'h', 'i'],
    free_position: 4,
    reroll_count: 0,
    first_media_at: null,
    created_by: 'user-1',
    created_at: NOW.toISOString(),
    updated_at: NOW.toISOString(),
    ended_at: null,
    end_reason: null,
    deleted_at: null,
    ...overrides,
  }
}

function makeCells(completed: boolean): GroupBoardCellRow[] {
  return [0, 1, 2, 3, 4, 5, 6, 7, 8].map((position) => ({
    group_board_id: 'board-1',
    position,
    cell_id: position === 4 ? 'free' : `m${position}`,
    mission_label: null,
    mission_capture_label: null,
    mission_category: null,
    mission_caption: null,
    mission_hint: null,
    mission_icon: null,
    mission_snapshot: position === 4 ? null : { id: `m${position}` },
    mission_catalog_version: 'api-migration-v1',
    completed_at:
      completed && position !== 4 ? '2026-07-14T01:00:00.000Z' : null,
    completed_by: null,
    completion_type: null,
  }))
}

function makeService(params: {
  admin: ReturnType<typeof makeAdmin>
  award?: ReturnType<typeof vi.fn>
  now?: Date
}) {
  const connections = {
    assertActiveGroupMember: vi.fn().mockResolvedValue({}),
  }
  const missions = { getMissionContent: vi.fn() }
  const badges = {
    awardGroupBoardBadges: params.award ?? vi.fn().mockResolvedValue([]),
  }
  const r2 = {
    createPreviewUrl: vi.fn().mockResolvedValue('https://preview'),
    deleteObjects: vi.fn().mockResolvedValue(undefined),
  }
  const clock = { now: () => params.now ?? NOW }
  const service = new GroupBoardsService(
    { adminClient: params.admin } as never,
    connections as never,
    missions as never,
    badges as never,
    r2 as never,
    clock,
  )
  return { service, connections, missions, badges, r2 }
}

const MISSION_CATALOG = {
  cells: [
    {
      id: 'free',
      category: 'special',
      label: 'FREE',
      icon: null,
      variant: 'rAdyJ',
      fixedPosition: 'center',
    },
    ...Array.from({ length: 8 }, (_, i) => ({
      id: `m${i}`,
      category: 'nature',
      label: `m${i}`,
      icon: null,
      variant: 'QeQCU',
    })),
  ],
}

describe('GroupBoardsService', () => {
  describe('getTodayBoard lazy close & day rollover (AC-12)', () => {
    it('lazy-closes an expired open board and rolls over to a new board without awarding', async () => {
      const staleBoard = makeBoard({ daily_date: '2026-07-10' })
      const closedBoard = makeBoard({
        daily_date: '2026-07-10',
        ended_at: '2026-07-11T01:00:00.000Z',
        end_reason: 'auto_grace_expired',
      })
      const newBoard = makeBoard({ id: 'board-2', daily_date: '2026-07-14' })
      const award = vi.fn().mockResolvedValue([])
      const rpcCalls: RpcCall[] = []
      const admin = makeAdmin(
        {
          group_boards: [{ data: staleBoard, error: null }],
          group_board_cells: [{ data: makeCells(false), error: null }],
          group_board_cell_media: [{ data: [], error: null }],
        },
        [
          { data: closedBoard, error: null },
          { data: newBoard, error: null },
        ],
        rpcCalls,
      )
      const { service, missions } = makeService({ admin, award })
      missions.getMissionContent.mockResolvedValue(MISSION_CATALOG)

      const result = await service.getTodayBoard('user-1', 'group-1')

      expect(rpcCalls[0]).toMatchObject({
        name: 'close_group_board',
        args: { p_reason: 'auto_grace_expired' },
      })
      expect(rpcCalls[1].name).toBe('get_or_create_group_board')
      expect(result.board.id).toBe('board-2')
      expect(result.board.dailyDate).toBe('2026-07-14')
      // auto_grace_expired must never award (AC-11 covers completed only).
      expect(award).not.toHaveBeenCalled()
    })

    it("keeps yesterday's open board current inside the KST grace window", async () => {
      // 2026-07-15 00:30 KST — board dated 07-14 is in grace, not expired.
      const graceNow = new Date('2026-07-14T15:30:00.000Z')
      const board = makeBoard({ daily_date: '2026-07-14' })
      const rpcCalls: RpcCall[] = []
      const admin = makeAdmin(
        {
          group_boards: [{ data: board, error: null }],
          group_board_cells: [{ data: makeCells(false), error: null }],
          group_board_cell_media: [{ data: [], error: null }],
        },
        [],
        rpcCalls,
      )
      const { service } = makeService({ admin, now: graceNow })

      const result = await service.getTodayBoard('user-1', 'group-1')

      expect(rpcCalls).toHaveLength(0)
      expect(result.board.id).toBe('board-1')
      expect(result.board.dailyDate).toBe('2026-07-14')
      expect(result.board.lifecycle).toBe('grace')
    })

    it("heals a completed prior-day board's lost award before rolling over", async () => {
      const endedYesterday = makeBoard({
        daily_date: '2026-07-13',
        ended_at: '2026-07-13T14:00:00.000Z',
        end_reason: 'completed',
      })
      const newBoard = makeBoard({ id: 'board-2', daily_date: '2026-07-14' })
      const award = vi.fn().mockResolvedValue([])
      const rpcCalls: RpcCall[] = []
      const admin = makeAdmin(
        {
          group_boards: [{ data: endedYesterday, error: null }],
          group_board_cells: [
            { data: makeCells(true), error: null },
            { data: makeCells(false), error: null },
          ],
          group_board_completions: [{ data: [], error: null }],
          group_board_cell_media: [{ data: [], error: null }],
        },
        [{ data: newBoard, error: null }],
        rpcCalls,
      )
      const { service, missions } = makeService({ admin, award })
      missions.getMissionContent.mockResolvedValue(MISSION_CATALOG)

      const result = await service.getTodayBoard('user-1', 'group-1')

      // Award recovery across midnight: the crashed fanout for yesterday's
      // completed board fires before today's board takes over.
      expect(award).toHaveBeenCalledWith(
        expect.objectContaining({ groupBoardId: 'board-1' }),
      )
      expect(rpcCalls[0].name).toBe('get_or_create_group_board')
      expect(result.board.id).toBe('board-2')
    })
  })

  describe('self-heal award (plan v4)', () => {
    it('re-awards a completed board whose completion ledger is empty', async () => {
      const award = vi.fn().mockResolvedValue([])
      const board = makeBoard({
        ended_at: '2026-07-14T02:00:00.000Z',
        end_reason: 'completed',
      })
      const admin = makeAdmin({
        group_boards: [{ data: board, error: null }],
        group_board_cells: [{ data: makeCells(true), error: null }],
        group_board_completions: [{ data: [], error: null }],
        group_board_cell_media: [{ data: [], error: null }],
      })
      const { service } = makeService({ admin, award })

      await service.getTodayBoard('user-1', 'group-1')

      expect(award).toHaveBeenCalledWith(
        expect.objectContaining({ groupBoardId: 'board-1', freePosition: 4 }),
      )
    })

    it('skips awarding when the ledger already has rows', async () => {
      const award = vi.fn().mockResolvedValue([])
      const board = makeBoard({
        ended_at: '2026-07-14T02:00:00.000Z',
        end_reason: 'completed',
      })
      const admin = makeAdmin({
        group_boards: [{ data: board, error: null }],
        group_board_cells: [{ data: makeCells(true), error: null }],
        group_board_completions: [
          { data: [{ group_board_id: 'board-1' }], error: null },
        ],
        group_board_cell_media: [{ data: [], error: null }],
      })
      const { service } = makeService({ admin, award })

      await service.getTodayBoard('user-1', 'group-1')
      expect(award).not.toHaveBeenCalled()
    })
  })

  describe('endBoard (AC-11)', () => {
    it('rejects an incomplete board with 400', async () => {
      const admin = makeAdmin({
        group_boards: [{ data: makeBoard(), error: null }],
        group_board_cells: [{ data: makeCells(false), error: null }],
      })
      const { service } = makeService({ admin })

      await expect(
        service.endBoard('user-1', 'group-1'),
      ).rejects.toMatchObject({ status: 400 })
    })

    it('closes a completed board and triggers the award fanout', async () => {
      const award = vi.fn().mockResolvedValue([])
      const closed = makeBoard({
        ended_at: '2026-07-14T03:00:00.000Z',
        end_reason: 'completed',
      })
      const rpcCalls: RpcCall[] = []
      const admin = makeAdmin(
        {
          group_boards: [{ data: makeBoard(), error: null }],
          group_board_cells: [{ data: makeCells(true), error: null }],
          group_board_completions: [{ data: [], error: null }],
          group_board_cell_media: [{ data: [], error: null }],
        },
        [{ data: closed, error: null }],
        rpcCalls,
      )
      const { service } = makeService({ admin, award })

      const result = await service.endBoard('user-1', 'group-1')

      expect(rpcCalls[0]).toMatchObject({
        name: 'close_group_board',
        args: { p_reason: 'completed' },
      })
      expect(award).toHaveBeenCalledTimes(1)
      expect(result.ok).toBe(true)
      expect(result.board.endReason).toBe('completed')
    })
  })

  describe('rerollBoard (AC-8)', () => {
    it('maps REROLL_LOCKED to 409', async () => {
      const missionsCatalog = {
        cells: [
          { id: 'free', category: 'special', label: 'FREE', icon: null, variant: 'rAdyJ', fixedPosition: 'center' },
          ...Array.from({ length: 8 }, (_, i) => ({
            id: `m${i}`,
            category: 'nature',
            label: `m${i}`,
            icon: null,
            variant: 'QeQCU',
          })),
        ],
      }
      const admin = makeAdmin(
        { group_boards: [{ data: makeBoard(), error: null }] },
        [{ data: null, error: new Error('REROLL_LOCKED') }],
      )
      const { service, missions } = makeService({ admin })
      missions.getMissionContent.mockResolvedValue(missionsCatalog)

      await expect(
        service.rerollBoard('user-1', 'group-1'),
      ).rejects.toMatchObject({ status: 409 })
    })
  })

  describe('deleteCellMedia (AC-14)', () => {
    const MEDIA_ROW = {
      id: 'media-1',
      group_board_id: 'board-1',
      position: 0,
      user_id: 'user-1',
      photo_id: 'photo-1',
      clip_id: null,
      created_at: NOW.toISOString(),
      deleted_at: null,
    }

    it('rejects deleting another member media with 403', async () => {
      const admin = makeAdmin({
        group_board_cell_media: [{ data: MEDIA_ROW, error: null }],
        group_boards: [
          { data: { id: 'board-1', group_id: 'group-1' }, error: null },
        ],
      })
      const { service } = makeService({ admin })

      await expect(
        service.deleteCellMedia('other-user', 'group-1', 'media-1'),
      ).rejects.toMatchObject({ status: 403 })
    })

    it('soft-deletes own media without touching group_board_cells', async () => {
      const tableCalls: string[] = []
      const admin = makeAdmin(
        {
          group_board_cell_media: [
            { data: MEDIA_ROW, error: null },
            { data: null, error: null },
          ],
          group_boards: [
            { data: { id: 'board-1', group_id: 'group-1' }, error: null },
          ],
          photos: [
            {
              data: {
                id: 'photo-1',
                user_id: 'user-1',
                storage_path: 'path/p.jpg',
                bucket_name: 'bucket',
              },
              error: null,
            },
            { data: null, error: null },
          ],
        },
        [],
        [],
        tableCalls,
      )
      const { service, r2 } = makeService({ admin })

      const result = await service.deleteCellMedia(
        'user-1',
        'group-1',
        'media-1',
      )

      expect(result).toEqual({ ok: true })
      expect(r2.deleteObjects).toHaveBeenCalledWith(['path/p.jpg'], 'bucket')
      // Monotonic completion (AC-14): the cells table is never written.
      expect(tableCalls).not.toContain('group_board_cells')
    })

    it('does not gate deletion on active membership (leavers keep the right)', async () => {
      const admin = makeAdmin({
        group_board_cell_media: [
          { data: MEDIA_ROW, error: null },
          { data: null, error: null },
        ],
        group_boards: [
          { data: { id: 'board-1', group_id: 'group-1' }, error: null },
        ],
        photos: [
          {
            data: {
              id: 'photo-1',
              user_id: 'user-1',
              storage_path: 'path/p.jpg',
              bucket_name: 'bucket',
            },
            error: null,
          },
          { data: null, error: null },
        ],
      })
      const { service, connections } = makeService({ admin })

      await service.deleteCellMedia('user-1', 'group-1', 'media-1')
      expect(connections.assertActiveGroupMember).not.toHaveBeenCalled()
    })
  })
})
