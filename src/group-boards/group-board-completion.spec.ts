import { describe, expect, it } from 'vitest'

import { summarizeGroupBoardCompletion } from '@/group-boards/group-board-completion'

const BOARD = {
  cell_ids: ['a', 'b', 'c', 'd', 'free', 'f', 'g', 'h', 'i'],
  free_position: 4,
}

function cell(position: number, completedAt: string | null) {
  return { position, completed_at: completedAt }
}

describe('summarizeGroupBoardCompletion', () => {
  it('counts the free position as completed with no cells', () => {
    const summary = summarizeGroupBoardCompletion(BOARD, [])
    expect(summary.completedCount).toBe(1)
    expect(summary.isFullyCompleted).toBe(false)
  })

  it('completes when all 8 regular cells carry completed_at', () => {
    const cells = [0, 1, 2, 3, 5, 6, 7, 8].map((position) =>
      cell(position, '2026-07-14T00:00:00.000Z'),
    )
    const summary = summarizeGroupBoardCompletion(BOARD, cells)
    expect(summary.completedCount).toBe(9)
    expect(summary.isFullyCompleted).toBe(true)
  })

  it('treats completed_at as monotonic evidence even with empty media (AC-14)', () => {
    // A cell whose media was all deleted still carries completed_at — the
    // summary must not care about media rows at all.
    const summary = summarizeGroupBoardCompletion(BOARD, [
      cell(0, '2026-07-14T00:00:00.000Z'),
    ])
    expect(summary.completedCount).toBe(2)
  })

  it('ignores out-of-range positions and incomplete snapshots', () => {
    const summary = summarizeGroupBoardCompletion(
      { cell_ids: ['a'], free_position: 4 },
      [cell(0, '2026-07-14T00:00:00.000Z'), cell(11, '2026-07-14T00:00:00.000Z')],
    )
    expect(summary.completedCount).toBe(0)
    expect(summary.isFullyCompleted).toBe(false)
  })
})
