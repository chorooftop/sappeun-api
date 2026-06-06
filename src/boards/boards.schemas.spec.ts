import { describe, expect, it } from 'vitest'

import {
  boardListQuerySchema,
  boardSessionSchema,
  editBoardCellMissionSchema,
  endBoardSchema,
  restoreBoardCellMissionSchema,
  updateBoardTitleSchema,
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

describe('endBoardSchema', () => {
  it('accepts an empty object (title is optional)', () => {
    expect(endBoardSchema.parse({})).toEqual({})
  })

  it('accepts a valid title', () => {
    expect(endBoardSchema.parse({ title: 'Morning walk' })).toEqual({
      title: 'Morning walk',
    })
  })

  it('trims whitespace from title', () => {
    expect(endBoardSchema.parse({ title: '  Trimmed  ' })).toEqual({
      title: 'Trimmed',
    })
  })

  it('accepts a title at the 24-character boundary', () => {
    const title = 'a'.repeat(24)
    expect(endBoardSchema.parse({ title })).toEqual({ title })
  })

  it('rejects a title that exceeds 24 characters', () => {
    expect(
      endBoardSchema.safeParse({ title: 'a'.repeat(25) }).success,
    ).toBe(false)
  })

  it('rejects a title that is empty after trimming', () => {
    expect(endBoardSchema.safeParse({ title: '   ' }).success).toBe(false)
  })

  it('strips unknown keys without throwing (forward-compat)', () => {
    const result = endBoardSchema.safeParse({
      title: 'walk',
      unknownField: 'ignored',
    })
    expect(result.success).toBe(true)
    expect(result.data).not.toHaveProperty('unknownField')
  })
})

describe('updateBoardTitleSchema', () => {
  it('accepts a valid title', () => {
    expect(updateBoardTitleSchema.parse({ title: 'Evening walk' })).toEqual({
      title: 'Evening walk',
    })
  })

  it('trims whitespace from title', () => {
    expect(updateBoardTitleSchema.parse({ title: '  Padded  ' })).toEqual({
      title: 'Padded',
    })
  })

  it('accepts a title at the 24-character boundary', () => {
    const title = 'b'.repeat(24)
    expect(updateBoardTitleSchema.parse({ title })).toEqual({ title })
  })

  it('rejects a title that exceeds 24 characters', () => {
    expect(
      updateBoardTitleSchema.safeParse({ title: 'b'.repeat(25) }).success,
    ).toBe(false)
  })

  it('rejects a missing title', () => {
    expect(updateBoardTitleSchema.safeParse({}).success).toBe(false)
  })

  it('rejects an empty title after trimming', () => {
    expect(updateBoardTitleSchema.safeParse({ title: '' }).success).toBe(false)
    expect(updateBoardTitleSchema.safeParse({ title: '   ' }).success).toBe(
      false,
    )
  })
})

describe('editBoardCellMissionSchema', () => {
  it('accepts required fields only', () => {
    expect(
      editBoardCellMissionSchema.parse({ cellId: 'n01', title: 'Find a flower' }),
    ).toEqual({ cellId: 'n01', title: 'Find a flower' })
  })

  it('accepts all optional fields', () => {
    expect(
      editBoardCellMissionSchema.parse({
        cellId: 'n01',
        title: 'Find a flower',
        description: 'Look for flowers near the path.',
        captureLabel: 'Pink flower',
      }),
    ).toEqual({
      cellId: 'n01',
      title: 'Find a flower',
      description: 'Look for flowers near the path.',
      captureLabel: 'Pink flower',
    })
  })

  it('trims whitespace from title, description, and captureLabel', () => {
    const result = editBoardCellMissionSchema.parse({
      cellId: 'n01',
      title: '  Trimmed title  ',
      description: '  Trimmed desc  ',
      captureLabel: '  Label  ',
    })
    expect(result).toEqual({
      cellId: 'n01',
      title: 'Trimmed title',
      description: 'Trimmed desc',
      captureLabel: 'Label',
    })
  })

  it('accepts a title at the 40-character boundary', () => {
    const title = 'c'.repeat(40)
    expect(
      editBoardCellMissionSchema.parse({ cellId: 'n01', title }),
    ).toEqual({ cellId: 'n01', title })
  })

  it('rejects a title that exceeds 40 characters', () => {
    expect(
      editBoardCellMissionSchema.safeParse({
        cellId: 'n01',
        title: 'c'.repeat(41),
      }).success,
    ).toBe(false)
  })

  it('rejects a description that exceeds 160 characters', () => {
    expect(
      editBoardCellMissionSchema.safeParse({
        cellId: 'n01',
        title: 'Valid',
        description: 'd'.repeat(161),
      }).success,
    ).toBe(false)
  })

  it('rejects a captureLabel that exceeds 40 characters', () => {
    expect(
      editBoardCellMissionSchema.safeParse({
        cellId: 'n01',
        title: 'Valid',
        captureLabel: 'e'.repeat(41),
      }).success,
    ).toBe(false)
  })

  it('rejects a missing cellId', () => {
    expect(
      editBoardCellMissionSchema.safeParse({ title: 'Valid' }).success,
    ).toBe(false)
  })

  it('rejects an empty title after trimming', () => {
    expect(
      editBoardCellMissionSchema.safeParse({
        cellId: 'n01',
        title: '   ',
      }).success,
    ).toBe(false)
  })
})

describe('restoreBoardCellMissionSchema', () => {
  it('accepts a valid cellId', () => {
    expect(restoreBoardCellMissionSchema.parse({ cellId: 'n01' })).toEqual({
      cellId: 'n01',
    })
  })

  it('rejects a missing cellId', () => {
    expect(restoreBoardCellMissionSchema.safeParse({}).success).toBe(false)
  })

  it('rejects an empty cellId', () => {
    expect(
      restoreBoardCellMissionSchema.safeParse({ cellId: '' }).success,
    ).toBe(false)
  })

  it('rejects a cellId that exceeds 80 characters', () => {
    expect(
      restoreBoardCellMissionSchema.safeParse({ cellId: 'f'.repeat(81) })
        .success,
    ).toBe(false)
  })
})
