import {
  BadRequestException,
  ConflictException,
} from '@nestjs/common'
import { describe, expect, it, vi } from 'vitest'

import type {
  AwardBoardBadgesResult,
  BadgesService,
} from '@/badges/badges.service'
import {
  BoardsService,
  type BoardCellRow,
  type BoardRow,
  summarizeBoardCompletion,
} from '@/boards/boards.service'

type QueryResult = {
  data: unknown
  error: Error | null
}

type QueryEvent =
  | { type: 'from'; table: string }
  | { type: 'update'; label: string; payload: unknown }

function baseBoard(overrides: Partial<BoardRow> = {}): BoardRow {
  return {
    id: 'board-1',
    user_id: 'user-1',
    mode: '3x3',
    board_kind: 'custom',
    client_session_id: 'session-1',
    nickname: '사뿐',
    title: '산책 빙고',
    description: null,
    free_position: 4,
    cell_ids: Array.from({ length: 9 }, (_, index) => `cell-${index}`),
    created_at: '2026-06-03T00:00:00.000Z',
    updated_at: '2026-06-03T00:10:00.000Z',
    ended_at: null,
    deleted_at: null,
    ...overrides,
  }
}

function cell(
  position: number,
  overrides: Partial<BoardCellRow> = {},
): BoardCellRow {
  return {
    board_id: 'board-1',
    position,
    cell_id: `cell-${position}`,
    photo_id: null,
    clip_id: null,
    marked_at: null,
    completed_at: null,
    completion_type: null,
    mission_label: null,
    mission_capture_label: null,
    mission_category: null,
    mission_snapshot: null,
    mission_catalog_version: null,
    ...overrides,
  }
}

function completedCells(): BoardCellRow[] {
  return Array.from({ length: 9 }, (_, position) =>
    cell(position, {
      completed_at: position === 4 ? null : '2026-06-03T00:20:00.000Z',
      completion_type: position === 4 ? null : 'no_media',
    }),
  )
}

function makeQuery(label: string, result: QueryResult, events: QueryEvent[]) {
  const query = {
    select() {
      return query
    },
    eq() {
      return query
    },
    in() {
      return query
    },
    is() {
      return query
    },
    not() {
      return query
    },
    order() {
      return query
    },
    limit() {
      return query
    },
    update(payload: unknown) {
      events.push({ type: 'update', label, payload })
      return query
    },
    maybeSingle() {
      return Promise.resolve(result)
    },
    then(
      resolve: (value: QueryResult) => unknown,
      reject?: (error: unknown) => unknown,
    ) {
      return Promise.resolve(result).then(resolve, reject)
    },
  }

  return query
}

function makeAdmin(
  queues: Record<string, ReturnType<typeof makeQuery>[]>,
  events: QueryEvent[],
) {
  return {
    from(table: string) {
      const query = queues[table]?.shift()
      if (!query) throw new Error(`Unexpected table query: ${table}`)
      events.push({ type: 'from', table })
      return query
    },
  }
}

type BadgesStub = Pick<BadgesService, 'awardBoardBadges' | 'getBoardBadges'>

function makeBadges(
  overrides: Partial<{
    awardResult: AwardBoardBadgesResult
    boardBadges: Map<string, unknown[]>
  }> = {},
): BadgesStub {
  const awardResult: AwardBoardBadgesResult = overrides.awardResult ?? {
    badgeEligible: false,
    badgeCount: 0,
    earnedBadges: [],
  }
  const boardBadges = overrides.boardBadges ?? new Map<string, unknown[]>()

  return {
    awardBoardBadges: vi.fn(() => Promise.resolve(awardResult)),
    getBoardBadges: vi.fn(() => Promise.resolve(boardBadges)),
  } as unknown as BadgesStub
}

describe('summarizeBoardCompletion', () => {
  it('counts the free position and all completion evidence types', () => {
    const board = baseBoard()
    const cells = completedCells().map((row) => {
      if (row.position === 0) return { ...row, photo_id: 'photo-1' }
      if (row.position === 1) return { ...row, clip_id: 'clip-1' }
      if (row.position === 2) {
        return {
          ...row,
          completed_at: null,
          marked_at: '2026-06-03T00:20:00.000Z',
        }
      }
      return row
    })

    expect(summarizeBoardCompletion(board, cells)).toEqual({
      completedAt: null,
      completedCount: 9,
      totalTargetCount: 9,
      isFullyCompleted: true,
      photoCount: 1,
      clipCount: 1,
      mediaCount: 2,
    })
  })

  it('ignores cells that do not match the board snapshot', () => {
    const board = baseBoard()
    const summary = summarizeBoardCompletion(board, [
      cell(0, { photo_id: 'photo-1', cell_id: 'wrong-cell' }),
      cell(1, { clip_id: 'clip-1' }),
    ])

    expect(summary).toMatchObject({
      completedCount: 2,
      photoCount: 0,
      clipCount: 1,
      mediaCount: 1,
      isFullyCompleted: false,
    })
  })

  it('only trusts completion_type=free on the configured free position', () => {
    const board = baseBoard()
    const summary = summarizeBoardCompletion(board, [
      cell(0, { completion_type: 'free' }),
    ])

    expect(summary.completedCount).toBe(1)
    expect(summary.isFullyCompleted).toBe(false)
  })

  it('marks an incomplete board snapshot as not fully completed', () => {
    const board = baseBoard({ cell_ids: ['cell-0'] })
    const summary = summarizeBoardCompletion(board, completedCells())

    expect(summary).toMatchObject({
      completedCount: 0,
      totalTargetCount: 9,
      isFullyCompleted: false,
    })
  })
})

describe('BoardsService.endUserBoard', () => {
  it('closes a fully completed board and returns completion summary', async () => {
    const events: QueryEvent[] = []
    const board = baseBoard()
    const endedBoard = {
      ...board,
      ended_at: '2026-06-03T00:30:00.000Z',
      updated_at: '2026-06-03T00:30:00.000Z',
    }
    const admin = makeAdmin(
      {
        boards: [
          makeQuery('select-board', { data: board, error: null }, events),
          makeQuery('end-board', { data: endedBoard, error: null }, events),
        ],
        board_cells: [
          makeQuery(
            'select-cells',
            { data: completedCells(), error: null },
            events,
          ),
        ],
      },
      events,
    )
    const service = new BoardsService(
      {} as never,
      { adminClient: admin } as never,
      makeBadges() as never,
    )

    await expect(service.endUserBoard('user-1', 'board-1')).resolves.toEqual({
      id: 'board-1',
      title: '산책 빙고',
      endedAt: '2026-06-03T00:30:00.000Z',
      completedAt: '2026-06-03T00:30:00.000Z',
      completedCount: 9,
      totalTargetCount: 9,
      isFullyCompleted: true,
      photoCount: 0,
      clipCount: 0,
      mediaCount: 0,
      // custom-kind board → derived 'edited' status, never badge eligible.
      customizationStatus: 'edited',
      editedCellCount: 0,
      badgeEligible: false,
      badgeCount: 0,
      earnedBadges: [],
    })
    expect(events).toContainEqual({
      type: 'update',
      label: 'end-board',
      payload: expect.objectContaining({
        ended_at: expect.any(String),
        updated_at: expect.any(String),
      }),
    })
  })

  it('rejects an incomplete board before updating ended_at', async () => {
    const events: QueryEvent[] = []
    const admin = makeAdmin(
      {
        boards: [
          makeQuery('select-board', { data: baseBoard(), error: null }, events),
        ],
        board_cells: [
          makeQuery('select-cells', { data: [cell(0)], error: null }, events),
        ],
      },
      events,
    )
    const service = new BoardsService(
      {} as never,
      { adminClient: admin } as never,
      makeBadges() as never,
    )

    await expect(
      service.endUserBoard('user-1', 'board-1'),
    ).rejects.toBeInstanceOf(BadRequestException)
    expect(events.some((event) => event.type === 'update')).toBe(false)
  })
})

describe('BoardsService.listUserBoards', () => {
  it('filters completed history to fully completed ended boards', async () => {
    const events: QueryEvent[] = []
    const completedBoard = baseBoard({
      ended_at: '2026-06-03T00:30:00.000Z',
    })
    const incompleteBoard = baseBoard({
      id: 'board-2',
      ended_at: '2026-06-03T00:25:00.000Z',
    })
    const admin = makeAdmin(
      {
        boards: [
          makeQuery(
            'list-boards',
            { data: [completedBoard, incompleteBoard], error: null },
            events,
          ),
        ],
        board_cells: [
          makeQuery(
            'select-cells',
            {
              data: [
                ...completedCells(),
                cell(0, {
                  board_id: 'board-2',
                  completed_at: '2026-06-03T00:20:00.000Z',
                  completion_type: 'no_media',
                }),
              ],
              error: null,
            },
            events,
          ),
        ],
      },
      events,
    )
    const service = new BoardsService(
      {} as never,
      { adminClient: admin } as never,
      makeBadges() as never,
    )

    await expect(
      service.listUserBoards('user-1', {
        status: 'completed',
        limit: 50,
        includePreview: false,
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        id: 'board-1',
        sessionId: 'session-1',
        status: 'completed',
        completedAt: '2026-06-03T00:30:00.000Z',
        completedCount: 9,
        totalTargetCount: 9,
        isFullyCompleted: true,
        mediaCount: 0,
        thumbnailUrls: [],
      }),
    ])
  })

  it('adds a representative clip preview when requested', async () => {
    const events: QueryEvent[] = []
    const completedBoard = baseBoard({
      ended_at: '2026-06-03T00:30:00.000Z',
    })
    const cells = completedCells().map((row) =>
      row.position === 1 ? { ...row, clip_id: 'clip-1' } : row,
    )
    const admin = makeAdmin(
      {
        boards: [
          makeQuery(
            'list-boards',
            { data: [completedBoard], error: null },
            events,
          ),
        ],
        board_cells: [
          makeQuery('select-cells', { data: cells, error: null }, events),
        ],
        clips: [
          makeQuery(
            'select-clips',
            {
              data: [
                {
                  id: 'clip-1',
                  user_id: 'user-1',
                  board_id: 'board-1',
                  position: 1,
                  cell_id: 'cell-1',
                  storage_path: 'clip.mp4',
                  poster_storage_path: 'poster.jpg',
                  duration_ms: 1200,
                  uploaded_at: '2026-06-03T00:21:00.000Z',
                  recorded_at: '2026-06-03T00:20:00.000Z',
                  description: 'clip description',
                  deleted_at: null,
                },
              ],
              error: null,
            },
            events,
          ),
        ],
      },
      events,
    )
    const r2 = {
      createPreviewUrl: (input: { objectKey: string }) =>
        Promise.resolve(`https://preview.example/${input.objectKey}`),
    }
    const service = new BoardsService(
      r2 as never,
      { adminClient: admin } as never,
      makeBadges() as never,
    )

    await expect(
      service.listUserBoards('user-1', {
        status: 'completed',
        limit: 50,
        includePreview: true,
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        id: 'board-1',
        mediaPreview: expect.objectContaining({
          kind: 'clip',
          url: 'https://preview.example/clip.mp4',
          thumbnailUrl: 'https://preview.example/poster.jpg',
          clipUrl: 'https://preview.example/clip.mp4',
          posterUrl: 'https://preview.example/poster.jpg',
          position: 1,
          cellId: 'cell-1',
          durationMs: 1200,
        }),
      }),
    ])
  })
})

function missionSnapshot(
  id: string,
  overrides: Partial<{
    category: string
    label: string
    hint: string
    captureLabel: string
    icon: string | null
    variant: string
  }> = {},
) {
  return {
    id,
    category: overrides.category ?? 'nature',
    label: overrides.label ?? id,
    icon: overrides.icon === undefined ? null : overrides.icon,
    variant: overrides.variant ?? 'QeQCU',
    ...(overrides.hint !== undefined ? { hint: overrides.hint } : {}),
    ...(overrides.captureLabel !== undefined
      ? { captureLabel: overrides.captureLabel }
      : {}),
  }
}

function missionBoard(overrides: Partial<BoardRow> = {}): BoardRow {
  return baseBoard({
    board_kind: 'mission',
    customization_status: 'official',
    title: '봄 산책',
    cell_ids: Array.from({ length: 9 }, (_, index) => `m0${index}`),
    ...overrides,
  })
}

function completedMissionCells(): BoardCellRow[] {
  return Array.from({ length: 9 }, (_, position) =>
    cell(position, {
      cell_id: `m0${position}`,
      completed_at: position === 4 ? null : '2026-06-03T00:20:00.000Z',
      completion_type: position === 4 ? null : 'no_media',
      mission_snapshot: missionSnapshot(`m0${position}`),
    }),
  )
}

describe('BoardsService.endUserBoard with title + badges', () => {
  it('stores the title and returns the full close response shape for an eligible board', async () => {
    const events: QueryEvent[] = []
    const board = missionBoard({ title: '예전 제목' })
    const titledBoard = { ...board, title: '비 오는 날 산책' }
    const endedBoard = {
      ...titledBoard,
      ended_at: '2026-06-03T00:30:00.000Z',
      updated_at: '2026-06-03T00:30:00.000Z',
    }
    const admin = makeAdmin(
      {
        boards: [
          makeQuery('select-board', { data: board, error: null }, events),
          makeQuery(
            'apply-title',
            { data: titledBoard, error: null },
            events,
          ),
          makeQuery('end-board', { data: endedBoard, error: null }, events),
        ],
        board_cells: [
          makeQuery(
            'select-cells',
            { data: completedMissionCells(), error: null },
            events,
          ),
        ],
      },
      events,
    )
    const badges = makeBadges({
      awardResult: {
        badgeEligible: true,
        badgeCount: 2,
        earnedBadges: [
          {
            badgeId: 'mission:m00:v1',
            missionId: 'm00',
            title: '꽃',
            difficulty: 'easy',
            gradeColor: '#6ED6A0',
            earnedAt: '2026-06-03T00:30:00.000Z',
            isFirstEarn: true,
          },
        ],
      },
    })
    const service = new BoardsService(
      {} as never,
      { adminClient: admin } as never,
      badges as never,
    )

    const result = await service.endUserBoard('user-1', 'board-1', {
      title: '비 오는 날 산책',
    })

    expect(result).toMatchObject({
      id: 'board-1',
      title: '비 오는 날 산책',
      endedAt: '2026-06-03T00:30:00.000Z',
      isFullyCompleted: true,
      customizationStatus: 'official',
      editedCellCount: 0,
      badgeEligible: true,
      badgeCount: 2,
      earnedBadges: [
        expect.objectContaining({ badgeId: 'mission:m00:v1', missionId: 'm00' }),
      ],
    })
    expect(badges.awardBoardBadges).toHaveBeenCalledTimes(1)
    expect(events).toContainEqual({
      type: 'update',
      label: 'apply-title',
      payload: expect.objectContaining({ title: '비 오는 날 산책' }),
    })
  })

  it('does not mint badges for an edited board on close', async () => {
    const events: QueryEvent[] = []
    const board = missionBoard()
    const cells = completedMissionCells().map((row, index) =>
      index === 0
        ? {
            ...row,
            original_cell_id: row.cell_id,
            original_mission_snapshot: missionSnapshot(row.cell_id),
          }
        : row,
    )
    const endedBoard = {
      ...board,
      customization_status: 'edited' as const,
      ended_at: '2026-06-03T00:30:00.000Z',
      updated_at: '2026-06-03T00:30:00.000Z',
    }
    const admin = makeAdmin(
      {
        boards: [
          makeQuery('select-board', { data: board, error: null }, events),
          makeQuery('end-board', { data: endedBoard, error: null }, events),
        ],
        board_cells: [
          makeQuery('select-cells', { data: cells, error: null }, events),
        ],
      },
      events,
    )
    const badges = makeBadges()
    const service = new BoardsService(
      {} as never,
      { adminClient: admin } as never,
      badges as never,
    )

    const result = await service.endUserBoard('user-1', 'board-1')

    expect(result).toMatchObject({
      badgeEligible: false,
      badgeCount: 0,
      earnedBadges: [],
      editedCellCount: 1,
      customizationStatus: 'edited',
    })
    // Edited board is ineligible -> no minting attempt is issued.
    expect(badges.awardBoardBadges).not.toHaveBeenCalled()
  })

  it('reuses getBoardBadges for an already-ended eligible board without double counting', async () => {
    const events: QueryEvent[] = []
    const board = missionBoard({ ended_at: '2026-06-03T00:30:00.000Z' })
    const boardBadges = new Map<string, unknown[]>([
      [
        'board-1',
        [
          {
            badgeId: 'mission:m00:v1',
            missionId: 'm00',
            title: '꽃',
            difficulty: 'easy',
            gradeColor: '#6ED6A0',
            earnedAt: '2026-06-03T00:30:00.000Z',
          },
        ],
      ],
    ])
    const admin = makeAdmin(
      {
        boards: [
          makeQuery('select-board', { data: board, error: null }, events),
        ],
        board_cells: [
          makeQuery(
            'select-cells',
            { data: completedMissionCells(), error: null },
            events,
          ),
        ],
      },
      events,
    )
    const badges = makeBadges({
      awardResult: { badgeEligible: true, badgeCount: 1, earnedBadges: [] },
      boardBadges,
    })
    const service = new BoardsService(
      {} as never,
      { adminClient: admin } as never,
      badges as never,
    )

    const result = await service.endUserBoard('user-1', 'board-1')

    // Self-heal path: award is re-attempted idempotently, then the response is
    // populated from the persisted board_badges read (no count inflation).
    expect(badges.awardBoardBadges).toHaveBeenCalledTimes(1)
    expect(badges.getBoardBadges).toHaveBeenCalledWith('user-1', ['board-1'])
    expect(result).toMatchObject({
      id: 'board-1',
      isFullyCompleted: true,
      badgeEligible: true,
      badgeCount: 1,
      earnedBadges: [
        expect.objectContaining({
          badgeId: 'mission:m00:v1',
          isFirstEarn: false,
        }),
      ],
    })
    // No ended_at update is issued for an already-ended board.
    expect(events.some((event) => event.type === 'update')).toBe(false)
  })
})

describe('BoardsService.editBoardCellMission', () => {
  function editAdmin(
    events: QueryEvent[],
    board: BoardRow,
    existingCell: BoardCellRow,
    cellsAfter: BoardCellRow[],
  ) {
    return makeAdmin(
      {
        boards: [
          makeQuery('select-board', { data: board, error: null }, events),
          makeQuery('edit-board', { data: null, error: null }, events),
        ],
        board_cells: [
          makeQuery('select-cell', { data: existingCell, error: null }, events),
          makeQuery('edit-cell', { data: null, error: null }, events),
          makeQuery(
            'reselect-cells',
            { data: cellsAfter, error: null },
            events,
          ),
        ],
      },
      events,
    )
  }

  it('merges label/hint/captureLabel while preserving id/category/variant', async () => {
    const events: QueryEvent[] = []
    const board = missionBoard()
    const existing = cell(0, {
      cell_id: 'm00',
      mission_snapshot: missionSnapshot('m00', {
        category: 'animal',
        variant: 'k4Srv',
        label: '고양이',
      }),
    })
    const edited = {
      ...existing,
      original_cell_id: 'm00',
      original_mission_snapshot: missionSnapshot('m00', {
        category: 'animal',
        variant: 'k4Srv',
        label: '고양이',
      }),
      mission_snapshot: missionSnapshot('m00', {
        category: 'animal',
        variant: 'k4Srv',
        label: '우리 동네 고양이',
        hint: '골목에서 고양이를 찾아요',
        captureLabel: '고양이',
      }),
      edited_at: '2026-06-03T00:25:00.000Z',
    }
    const cellsAfter = completedMissionCells().map((row) =>
      row.position === 0 ? edited : row,
    )
    const admin = editAdmin(events, board, existing, cellsAfter)
    const service = new BoardsService(
      {} as never,
      { adminClient: admin } as never,
      makeBadges() as never,
    )

    const result = await service.editBoardCellMission('user-1', 'board-1', 0, {
      cellId: 'm00',
      title: '우리 동네 고양이',
      description: '골목에서 고양이를 찾아요',
      captureLabel: '고양이',
    })

    expect(result).toMatchObject({
      ok: true,
      board: {
        customizationStatus: 'edited',
        editedCellCount: 1,
        badgeEligible: false,
      },
      cell: {
        position: 0,
        cellId: 'm00',
        mission: expect.objectContaining({
          id: 'm00',
          category: 'animal',
          variant: 'k4Srv',
          label: '우리 동네 고양이',
          hint: '골목에서 고양이를 찾아요',
          captureLabel: '고양이',
        }),
      },
    })

    const editEvent = events.find(
      (event) => event.type === 'update' && event.label === 'edit-cell',
    ) as { payload: Record<string, unknown> } | undefined
    const persisted = editEvent?.payload.mission_snapshot as Record<
      string,
      unknown
    >
    expect(persisted).toMatchObject({
      id: 'm00',
      category: 'animal',
      variant: 'k4Srv',
      label: '우리 동네 고양이',
      hint: '골목에서 고양이를 찾아요',
    })
  })

  it('rejects an edit whose merged snapshot fails missionSnapshotSchema', async () => {
    const events: QueryEvent[] = []
    const board = missionBoard()
    // Base snapshot is missing the required `variant` field, so the merged
    // result cannot satisfy missionSnapshotSchema and must be rejected.
    const existing = cell(0, {
      cell_id: 'm00',
      mission_snapshot: {
        id: 'm00',
        category: 'nature',
        label: '꽃',
        icon: null,
      } as never,
    })
    const admin = makeAdmin(
      {
        boards: [
          makeQuery('select-board', { data: board, error: null }, events),
        ],
        board_cells: [
          makeQuery('select-cell', { data: existing, error: null }, events),
        ],
      },
      events,
    )
    const service = new BoardsService(
      {} as never,
      { adminClient: admin } as never,
      makeBadges() as never,
    )

    await expect(
      service.editBoardCellMission('user-1', 'board-1', 0, {
        cellId: 'm00',
        title: '새 미션',
      }),
    ).rejects.toBeInstanceOf(BadRequestException)
    expect(events.some((event) => event.type === 'update')).toBe(false)
  })

  it('rejects editing a cell on an ended board', async () => {
    const events: QueryEvent[] = []
    const board = missionBoard({ ended_at: '2026-06-03T00:30:00.000Z' })
    const admin = makeAdmin(
      {
        boards: [
          makeQuery('select-board', { data: board, error: null }, events),
        ],
      },
      events,
    )
    const service = new BoardsService(
      {} as never,
      { adminClient: admin } as never,
      makeBadges() as never,
    )

    await expect(
      service.editBoardCellMission('user-1', 'board-1', 0, {
        cellId: 'm00',
        title: '새 미션',
      }),
    ).rejects.toBeInstanceOf(ConflictException)
  })

  it('rejects editing the free position', async () => {
    const events: QueryEvent[] = []
    const board = missionBoard()
    const admin = makeAdmin(
      {
        boards: [
          makeQuery('select-board', { data: board, error: null }, events),
        ],
      },
      events,
    )
    const service = new BoardsService(
      {} as never,
      { adminClient: admin } as never,
      makeBadges() as never,
    )

    await expect(
      service.editBoardCellMission('user-1', 'board-1', 4, {
        cellId: 'm04',
        title: '새 미션',
      }),
    ).rejects.toBeInstanceOf(ConflictException)
  })

  it('rejects editing a cell that already has completion evidence', async () => {
    const events: QueryEvent[] = []
    const board = missionBoard()
    const existing = cell(0, {
      cell_id: 'm00',
      photo_id: 'photo-1',
      completed_at: '2026-06-03T00:20:00.000Z',
      mission_snapshot: missionSnapshot('m00'),
    })
    const admin = makeAdmin(
      {
        boards: [
          makeQuery('select-board', { data: board, error: null }, events),
        ],
        board_cells: [
          makeQuery('select-cell', { data: existing, error: null }, events),
        ],
      },
      events,
    )
    const service = new BoardsService(
      {} as never,
      { adminClient: admin } as never,
      makeBadges() as never,
    )

    await expect(
      service.editBoardCellMission('user-1', 'board-1', 0, {
        cellId: 'm00',
        title: '새 미션',
      }),
    ).rejects.toBeInstanceOf(ConflictException)
  })

  it('rejects a cellId that does not match the board position', async () => {
    const events: QueryEvent[] = []
    const board = missionBoard()
    const admin = makeAdmin(
      {
        boards: [
          makeQuery('select-board', { data: board, error: null }, events),
        ],
      },
      events,
    )
    const service = new BoardsService(
      {} as never,
      { adminClient: admin } as never,
      makeBadges() as never,
    )

    await expect(
      service.editBoardCellMission('user-1', 'board-1', 0, {
        cellId: 'wrong-cell',
        title: '새 미션',
      }),
    ).rejects.toBeInstanceOf(BadRequestException)
  })
})

describe('BoardsService.restoreBoardCellMission', () => {
  it('restores the original snapshot and returns official status once all edits are reverted', async () => {
    const events: QueryEvent[] = []
    const board = missionBoard({ customization_status: 'edited' })
    const original = missionSnapshot('m00', {
      category: 'animal',
      variant: 'k4Srv',
      label: '고양이',
    })
    const existing = cell(0, {
      cell_id: 'm00',
      original_cell_id: 'm00',
      original_mission_snapshot: original,
      edited_at: '2026-06-03T00:25:00.000Z',
      mission_snapshot: missionSnapshot('m00', {
        category: 'animal',
        variant: 'k4Srv',
        label: '편집된 라벨',
      }),
    })
    // After restore there are no edited cells left.
    const cellsAfter = completedMissionCells().map((row) =>
      row.position === 0
        ? cell(0, { cell_id: 'm00', mission_snapshot: original })
        : row,
    )
    const admin = makeAdmin(
      {
        boards: [
          makeQuery('select-board', { data: board, error: null }, events),
          makeQuery('restore-board', { data: null, error: null }, events),
        ],
        board_cells: [
          makeQuery('select-cell', { data: existing, error: null }, events),
          makeQuery('restore-cell', { data: null, error: null }, events),
          makeQuery(
            'reselect-cells',
            { data: cellsAfter, error: null },
            events,
          ),
        ],
      },
      events,
    )
    const service = new BoardsService(
      {} as never,
      { adminClient: admin } as never,
      makeBadges() as never,
    )

    const result = await service.restoreBoardCellMission(
      'user-1',
      'board-1',
      0,
      { cellId: 'm00' },
    )

    expect(result).toMatchObject({
      ok: true,
      board: {
        customizationStatus: 'official',
        editedCellCount: 0,
        badgeEligible: false,
      },
      cell: {
        position: 0,
        cellId: 'm00',
        editedAt: null,
        mission: expect.objectContaining({ label: '고양이' }),
      },
    })

    const restoreEvent = events.find(
      (event) => event.type === 'update' && event.label === 'restore-cell',
    ) as { payload: Record<string, unknown> } | undefined
    expect(restoreEvent?.payload).toMatchObject({
      original_cell_id: null,
      original_mission_snapshot: null,
      edited_at: null,
    })
    const boardEvent = events.find(
      (event) => event.type === 'update' && event.label === 'restore-board',
    ) as { payload: Record<string, unknown> } | undefined
    expect(boardEvent?.payload).toMatchObject({
      customization_status: 'official',
    })
  })

  it('rejects restoring a cell that has no original snapshot', async () => {
    const events: QueryEvent[] = []
    const board = missionBoard()
    const existing = cell(0, {
      cell_id: 'm00',
      mission_snapshot: missionSnapshot('m00'),
    })
    const admin = makeAdmin(
      {
        boards: [
          makeQuery('select-board', { data: board, error: null }, events),
        ],
        board_cells: [
          makeQuery('select-cell', { data: existing, error: null }, events),
        ],
      },
      events,
    )
    const service = new BoardsService(
      {} as never,
      { adminClient: admin } as never,
      makeBadges() as never,
    )

    await expect(
      service.restoreBoardCellMission('user-1', 'board-1', 0, {
        cellId: 'm00',
      }),
    ).rejects.toBeInstanceOf(ConflictException)
  })
})
