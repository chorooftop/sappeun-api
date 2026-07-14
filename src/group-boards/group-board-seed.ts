import type { MissionCell } from '@/missions/missions.schemas'
import { MISSION_CATALOG_VERSION } from '@/missions/missions.constants'

import {
  GROUP_BOARD_FREE_POSITION,
  GROUP_BOARD_MODE,
  GROUP_BOARD_SIZE,
} from '@/group-boards/group-boards.constants'

export interface GroupBoardCellSeedPayload {
  position: number
  cell_id: string
  mission_label: string | null
  mission_capture_label: string | null
  mission_category: string | null
  mission_caption: string | null
  mission_hint: string | null
  mission_icon: string | null
  mission_snapshot: MissionCell
  mission_catalog_version: string
}

export interface GroupBoardSeed {
  seedRecipe: string
  cellIds: string[]
  freePosition: number
  cells: GroupBoardCellSeedPayload[]
}

function cellSeedPayload(position: number, mission: MissionCell): GroupBoardCellSeedPayload {
  return {
    position,
    cell_id: mission.id,
    mission_label: mission.label ?? null,
    mission_capture_label: mission.captureLabel ?? mission.label ?? null,
    mission_category: mission.category ?? null,
    mission_caption: mission.caption ?? null,
    mission_hint: mission.hint ?? null,
    mission_icon: mission.icon ?? null,
    mission_snapshot: mission,
    mission_catalog_version: MISSION_CATALOG_VERSION,
  }
}

function sampleMissions(
  pool: readonly MissionCell[],
  count: number,
  random: () => number,
) {
  const copy = [...pool]
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1))
    ;[copy[i], copy[j]] = [copy[j], copy[i]]
  }
  return copy.slice(0, count)
}

/**
 * Server-side seed for a group daily board: 8 random regular missions plus
 * the fixed free cell at the 3x3 center. Pure — inject `random` for
 * deterministic tests.
 */
export function buildGroupBoardSeed(params: {
  groupId: string
  dailyDate: string
  missions: readonly MissionCell[]
  random?: () => number
}): GroupBoardSeed {
  const random = params.random ?? Math.random

  const freeCell = params.missions.find(
    (mission) => mission.fixedPosition === 'center',
  )
  if (!freeCell) {
    throw new Error('Mission catalog is missing the center free cell.')
  }

  const pool = params.missions.filter(
    (mission) => mission.id !== freeCell.id && mission.fixedPosition == null,
  )
  const regularCount = GROUP_BOARD_SIZE - 1
  if (pool.length < regularCount) {
    throw new Error('Mission catalog has too few missions for a group board.')
  }

  const picked = sampleMissions(pool, regularCount, random)
  const cellIds: string[] = []
  const cells: GroupBoardCellSeedPayload[] = []
  let pickedIndex = 0

  for (let position = 0; position < GROUP_BOARD_SIZE; position += 1) {
    const mission =
      position === GROUP_BOARD_FREE_POSITION ? freeCell : picked[pickedIndex++]
    cellIds.push(mission.id)
    cells.push(cellSeedPayload(position, mission))
  }

  return {
    seedRecipe: JSON.stringify({
      version: 'group-v1',
      mode: GROUP_BOARD_MODE,
      groupId: params.groupId,
      dailyDate: params.dailyDate,
      freePosition: GROUP_BOARD_FREE_POSITION,
      cellIds,
      catalogVersion: MISSION_CATALOG_VERSION,
    }),
    cellIds,
    freePosition: GROUP_BOARD_FREE_POSITION,
    cells,
  }
}
