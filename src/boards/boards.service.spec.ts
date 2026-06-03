import { BadRequestException } from '@nestjs/common'
import { describe, expect, it } from 'vitest'

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
    )

    await expect(service.endUserBoard('user-1', 'board-1')).resolves.toEqual({
      id: 'board-1',
      endedAt: '2026-06-03T00:30:00.000Z',
      completedAt: '2026-06-03T00:30:00.000Z',
      completedCount: 9,
      totalTargetCount: 9,
      isFullyCompleted: true,
      photoCount: 0,
      clipCount: 0,
      mediaCount: 0,
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
      createPreviewUrl: async (input: { objectKey: string }) =>
        `https://preview.example/${input.objectKey}`,
    }
    const service = new BoardsService(
      r2 as never,
      { adminClient: admin } as never,
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
