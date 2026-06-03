import { describe, expect, it } from 'vitest'

import {
  boardListQuerySchema,
  boardSessionSchema,
} from '@/boards/boards.schemas'

function cells(count: number) {
  return Array.from({ length: count }, (_, index) => `cell-${index}`)
}

function missionSnapshots(cellIds: readonly string[]) {
  return cellIds.map((id) => ({
    id,
    category: 'nature' as const,
    label: `Mission ${id}`,
    icon: null,
    variant: 'QeQCU' as const,
  }))
}

function validV4Session() {
  const cellIds = cells(9)

  return {
    version: 4 as const,
    sessionId: 'session-1',
    mode: '3x3' as const,
    boardKind: 'mission' as const,
    nickname: 'tester',
    title: 'Morning walk',
    createdAt: '2026-05-31T00:00:00.000Z',
    updatedAt: '2026-05-31T00:00:00.000Z',
    freePosition: 4,
    cellIds,
    missionSnapshots: missionSnapshots(cellIds),
    markedPositions: [0],
    clips: [
      {
        position: 1,
        cellId: 'cell-1',
        clipId: '018f7d38-0dd4-4d77-981e-36e85f0b2a42',
        ownerKind: 'user' as const,
        durationMs: 1200,
        uploadStatus: 'uploaded' as const,
      },
    ],
    endedAt: null,
  }
}

describe('boardSessionSchema', () => {
  it('accepts a complete 3x3 v4 mission board', () => {
    expect(boardSessionSchema.safeParse(validV4Session()).success).toBe(true)
  })

  it('rejects a 3x3 board with 25 cells', () => {
    const cellIds = cells(25)
    const parsed = boardSessionSchema.safeParse({
      ...validV4Session(),
      cellIds,
      missionSnapshots: missionSnapshots(cellIds),
    })

    expect(parsed.success).toBe(false)
  })

  it('rejects mismatched clip position and cell id', () => {
    const parsed = boardSessionSchema.safeParse({
      ...validV4Session(),
      clips: [
        {
          position: 1,
          cellId: 'cell-2',
          clipId: '018f7d38-0dd4-4d77-981e-36e85f0b2a42',
          ownerKind: 'user',
          durationMs: 1200,
          uploadStatus: 'uploaded',
        },
      ],
    })

    expect(parsed.success).toBe(false)
  })

  it('rejects mission snapshots that do not align with cell ids', () => {
    const session = validV4Session()
    const parsed = boardSessionSchema.safeParse({
      ...session,
      missionSnapshots: [
        { ...session.missionSnapshots[0], id: 'wrong-cell' },
        ...session.missionSnapshots.slice(1),
      ],
    })

    expect(parsed.success).toBe(false)
  })
})

describe('boardListQuerySchema', () => {
  it('defaults to all boards with a limit of 50', () => {
    expect(boardListQuerySchema.parse({})).toEqual({
      status: 'all',
      limit: 50,
      includePreview: false,
    })
  })

  it('accepts completed status and coerces string limit', () => {
    expect(
      boardListQuerySchema.parse({
        status: 'completed',
        limit: '12',
        includePreview: 'true',
      }),
    ).toEqual({
      status: 'completed',
      limit: 12,
      includePreview: true,
    })
  })

  it('coerces false preview query strings without enabling previews', () => {
    expect(boardListQuerySchema.parse({ includePreview: 'false' })).toEqual({
      status: 'all',
      limit: 50,
      includePreview: false,
    })
  })

  it('rejects unknown status and out-of-range limits', () => {
    expect(boardListQuerySchema.safeParse({ status: 'unknown' }).success).toBe(
      false,
    )
    expect(boardListQuerySchema.safeParse({ limit: '0' }).success).toBe(false)
    expect(boardListQuerySchema.safeParse({ limit: '51' }).success).toBe(false)
  })
})
