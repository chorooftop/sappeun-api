export interface GroupBoardRow {
  id: string
  group_id: string
  daily_date: string
  mode: string
  seed_recipe: string
  cell_ids: string[] | null
  free_position: number | null
  reroll_count: number
  first_media_at: string | null
  created_by: string | null
  created_at: string
  updated_at: string
  ended_at: string | null
  end_reason: 'completed' | 'auto_grace_expired' | null
  deleted_at: string | null
}

export interface GroupBoardCellRow {
  group_board_id: string
  position: number
  cell_id: string
  mission_label: string | null
  mission_capture_label: string | null
  mission_category: string | null
  mission_caption: string | null
  mission_hint: string | null
  mission_icon: string | null
  mission_snapshot: Record<string, unknown> | null
  mission_catalog_version: string | null
  completed_at: string | null
  completed_by: string | null
  completion_type: string | null
}

export interface GroupBoardCellMediaRow {
  id: string
  group_board_id: string
  position: number
  user_id: string
  photo_id: string | null
  clip_id: string | null
  created_at: string
  deleted_at: string | null
}

export const GROUP_BOARD_SELECT =
  'id, group_id, daily_date, mode, seed_recipe, cell_ids, free_position, reroll_count, first_media_at, created_by, created_at, updated_at, ended_at, end_reason, deleted_at'

export const GROUP_BOARD_CELL_SELECT =
  'group_board_id, position, cell_id, mission_label, mission_capture_label, mission_category, mission_caption, mission_hint, mission_icon, mission_snapshot, mission_catalog_version, completed_at, completed_by, completion_type'

export const GROUP_BOARD_CELL_MEDIA_SELECT =
  'id, group_board_id, position, user_id, photo_id, clip_id, created_at, deleted_at'
