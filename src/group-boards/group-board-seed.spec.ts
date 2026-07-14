import { describe, expect, it } from 'vitest'

import { buildGroupBoardSeed } from '@/group-boards/group-board-seed'
import {
  GROUP_BOARD_FREE_POSITION,
  GROUP_BOARD_SIZE,
} from '@/group-boards/group-boards.constants'
import type { MissionCell } from '@/missions/missions.schemas'

function makeMission(id: string, overrides: Partial<MissionCell> = {}): MissionCell {
  return {
    id,
    category: 'nature',
    label: `mission-${id}`,
    icon: null,
    variant: 'QeQCU',
    ...overrides,
  }
}

const FREE_CELL = makeMission('free', {
  category: 'special',
  fixedPosition: 'center',
})

function makeCatalog(count = 12) {
  const missions: MissionCell[] = [FREE_CELL]
  for (let i = 0; i < count; i += 1) {
    missions.push(makeMission(`m${i}`))
  }
  return missions
}

describe('buildGroupBoardSeed', () => {
  it('builds 9 cells with the free cell fixed at the center', () => {
    const seed = buildGroupBoardSeed({
      groupId: 'group-1',
      dailyDate: '2026-07-14',
      missions: makeCatalog(),
      random: () => 0.5,
    })

    expect(seed.cellIds).toHaveLength(GROUP_BOARD_SIZE)
    expect(seed.cells).toHaveLength(GROUP_BOARD_SIZE)
    expect(seed.freePosition).toBe(GROUP_BOARD_FREE_POSITION)
    expect(seed.cellIds[GROUP_BOARD_FREE_POSITION]).toBe('free')
    expect(seed.cells[GROUP_BOARD_FREE_POSITION].mission_category).toBe(
      'special',
    )
  })

  it('picks 8 distinct regular missions and never duplicates the free cell', () => {
    const seed = buildGroupBoardSeed({
      groupId: 'group-1',
      dailyDate: '2026-07-14',
      missions: makeCatalog(),
      random: () => 0.1,
    })

    const regularIds = seed.cellIds.filter(
      (_, position) => position !== GROUP_BOARD_FREE_POSITION,
    )
    expect(new Set(regularIds).size).toBe(8)
    expect(regularIds).not.toContain('free')
  })

  it('is deterministic for a fixed random source', () => {
    const params = {
      groupId: 'group-1',
      dailyDate: '2026-07-14',
      missions: makeCatalog(),
    }
    const a = buildGroupBoardSeed({ ...params, random: () => 0.3 })
    const b = buildGroupBoardSeed({ ...params, random: () => 0.3 })
    expect(a.cellIds).toEqual(b.cellIds)
    expect(a.seedRecipe).toBe(b.seedRecipe)
  })

  it('mirrors boardCellSnapshotPayload column mapping', () => {
    const missions = [
      FREE_CELL,
      ...Array.from({ length: 8 }, (_, i) =>
        makeMission(`m${i}`, {
          caption: 'caption',
          captureLabel: 'capture',
          hint: 'hint',
          icon: 'icon',
        }),
      ),
    ]
    const seed = buildGroupBoardSeed({
      groupId: 'group-1',
      dailyDate: '2026-07-14',
      missions,
      random: () => 0,
    })

    const regular = seed.cells.find(
      (cell) => cell.position !== GROUP_BOARD_FREE_POSITION,
    )
    expect(regular).toMatchObject({
      mission_capture_label: 'capture',
      mission_caption: 'caption',
      mission_hint: 'hint',
      mission_icon: 'icon',
    })
    expect(regular?.mission_snapshot.id).toBe(regular?.cell_id)
  })

  it('throws when the catalog lacks the center free cell', () => {
    expect(() =>
      buildGroupBoardSeed({
        groupId: 'group-1',
        dailyDate: '2026-07-14',
        missions: Array.from({ length: 10 }, (_, i) => makeMission(`m${i}`)),
      }),
    ).toThrow(/free cell/)
  })

  it('throws when there are fewer than 8 regular missions', () => {
    expect(() =>
      buildGroupBoardSeed({
        groupId: 'group-1',
        dailyDate: '2026-07-14',
        missions: [FREE_CELL, makeMission('m0'), makeMission('m1')],
      }),
    ).toThrow(/too few/)
  })
})
