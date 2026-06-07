import { Injectable } from '@nestjs/common'

import {
  missionContentResponseSchema,
  type MissionCategory,
  type MissionCell,
  type MissionContentResponse,
} from '@/missions/missions.schemas'
import {
  MISSION_CATALOG_VERSION,
  MISSION_CONTENT_UPDATED_AT,
  MISSION_CONTENT_VERSION,
} from '@/missions/missions.constants'
import { SupabaseService } from '@/supabase/supabase.service'

const MISSION_CONTENT_SELECT =
  'mission_id, label, category, hint, caption, capture_label, icon, variant, difficulty, camera, text_only, font_size, swatch, swatch_label, no_photo, fixed_position, sort_order'

const MISSION_CATEGORY_SELECT = 'key, label, tone, count'

interface MissionContentRow {
  mission_id: string
  label: string
  category: string
  hint: string | null
  caption: string | null
  capture_label: string | null
  icon: string | null
  variant: string
  difficulty: string | null
  camera: string | null
  text_only: boolean | null
  font_size: number | null
  swatch: string | null
  swatch_label: string | null
  no_photo: boolean | null
  fixed_position: string | null
  sort_order: number | null
}

interface MissionCategoryRow {
  key: string
  label: string
  tone: string | null
  count: number | null
}

function toMissionCell(row: MissionContentRow): MissionCell {
  return {
    id: row.mission_id,
    category: row.category,
    label: row.label,
    icon: row.icon,
    variant: row.variant,
    ...(row.caption != null ? { caption: row.caption } : {}),
    ...(row.capture_label != null ? { captureLabel: row.capture_label } : {}),
    ...(row.hint != null ? { hint: row.hint } : {}),
    ...(row.text_only != null ? { textOnly: row.text_only } : {}),
    ...(row.font_size != null ? { fontSize: row.font_size } : {}),
    ...(row.swatch != null ? { swatch: row.swatch } : {}),
    ...(row.swatch_label != null ? { swatchLabel: row.swatch_label } : {}),
    ...(row.camera != null ? { camera: row.camera } : {}),
    ...(row.difficulty != null ? { difficulty: row.difficulty } : {}),
    ...(row.no_photo != null ? { noPhoto: row.no_photo } : {}),
    ...(row.fixed_position != null
      ? { fixedPosition: row.fixed_position }
      : {}),
  }
}

function toMissionCategory(row: MissionCategoryRow): MissionCategory {
  return {
    label: row.label,
    count: row.count ?? 0,
    tone: row.tone ?? '',
  }
}

@Injectable()
export class MissionsService {
  constructor(private readonly supabase: SupabaseService) {}

  private get admin(): any {
    return this.supabase.adminClient
  }

  async getMissionContent(
    catalogVersion: string = MISSION_CATALOG_VERSION,
  ): Promise<MissionContentResponse> {
    const { data: cellData, error: cellError } = await this.admin
      .from('mission_content')
      .select(MISSION_CONTENT_SELECT)
      .eq('catalog_version', catalogVersion)
      .eq('active', true)
      .order('sort_order', { ascending: true })

    if (cellError) throw cellError

    const { data: categoryData, error: categoryError } = await this.admin
      .from('mission_categories')
      .select(MISSION_CATEGORY_SELECT)
      .eq('catalog_version', catalogVersion)

    if (categoryError) throw categoryError

    const cells = ((cellData ?? []) as MissionContentRow[]).map(toMissionCell)
    const categories = ((categoryData ?? []) as MissionCategoryRow[]).reduce<
      Record<string, MissionCategory>
    >((acc, row) => {
      acc[row.key] = toMissionCategory(row)
      return acc
    }, {})

    // Runtime-validate the assembled payload so DB drift (e.g. an invalid
    // variant or category written outside the seed) is caught here rather than
    // surfacing as a client-side FormatException.
    return missionContentResponseSchema.parse({
      version: MISSION_CONTENT_VERSION,
      updatedAt: MISSION_CONTENT_UPDATED_AT,
      totalCells: cells.length,
      categories,
      cells,
    })
  }
}
