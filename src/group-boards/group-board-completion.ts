import type {
  GroupBoardCellRow,
  GroupBoardRow,
} from '@/group-boards/group-board.types'
import { GROUP_BOARD_SIZE } from '@/group-boards/group-boards.constants'

export interface GroupBoardCompletionSummary {
  completedCount: number
  isFullyCompleted: boolean
}

/**
 * Group counterpart of summarizeBoardCompletion. Unlike personal cells, a
 * group cell has no photo_id/clip_id — completion evidence is the monotonic
 * completed_at cache alone (AC-14: it survives even if every media row is
 * later deleted), plus the free center position.
 */
export function summarizeGroupBoardCompletion(
  board: Pick<GroupBoardRow, 'cell_ids' | 'free_position'>,
  cells: readonly Pick<GroupBoardCellRow, 'position' | 'completed_at'>[],
): GroupBoardCompletionSummary {
  const hasValidSnapshot = board.cell_ids?.length === GROUP_BOARD_SIZE
  const freePosition = board.free_position
  const hasValidFreePosition =
    typeof freePosition === 'number' &&
    Number.isInteger(freePosition) &&
    freePosition >= 0 &&
    freePosition < GROUP_BOARD_SIZE

  const completedPositions = new Set<number>()
  if (hasValidSnapshot && hasValidFreePosition) {
    completedPositions.add(freePosition)
  }

  for (const cell of cells) {
    if (!hasValidSnapshot) continue
    if (
      !Number.isInteger(cell.position) ||
      cell.position < 0 ||
      cell.position >= GROUP_BOARD_SIZE
    ) {
      continue
    }
    if (cell.completed_at != null || cell.position === freePosition) {
      completedPositions.add(cell.position)
    }
  }

  const completedCount = completedPositions.size
  return {
    completedCount,
    isFullyCompleted: hasValidSnapshot && completedCount >= GROUP_BOARD_SIZE,
  }
}
