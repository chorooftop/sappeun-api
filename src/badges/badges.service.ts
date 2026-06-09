import { Injectable } from '@nestjs/common'

import { badgeGradeForDifficulty } from '@/badges/badge-grade'
import { artworkSpecSchema, type ArtworkSpec } from '@/common/artwork.schemas'
import {
  isVisibleToClient,
  LEGACY_CLIENT_CAPABILITIES,
  type ClientCapabilities,
  type CapabilityGatedRow,
} from '@/common/client-capabilities'
import type { UserBadgesQueryInput } from '@/badges/badges.schemas'
import { MISSION_CATALOG_VERSION } from '@/missions/missions.constants'
import { SupabaseService } from '@/supabase/supabase.service'
import type { BoardCellRow, BoardRow } from '@/boards/boards.service'

const MISSION_BADGE_CATALOG_SELECT =
  'mission_id, catalog_version, label, category, difficulty, artwork, awards_badge, sort_order, active, min_app_build, required_capabilities, active_from, active_until'

const MISSION_BADGE_AWARD_SELECT =
  'mission_id, catalog_version, label, category, difficulty, artwork, awards_badge, active, min_app_build, required_capabilities, active_from, active_until'

interface MissionBadgeRow extends CapabilityGatedRow {
  mission_id: string
  catalog_version: string
  label: string
  category: string
  difficulty: string
  artwork: unknown
  awards_badge: boolean
  sort_order: number
  active: boolean
}

interface BoardBadgeRow {
  board_id: string
  mission_id: string
  user_id: string
  earned_at: string
}

interface UserBadgeRow {
  user_id: string
  mission_id: string
  earned_catalog_version: string | null
  first_board_id: string | null
  last_board_id: string | null
  first_earned_at: string
  last_earned_at: string
  earned_count: number
}

interface RpcAwardResult {
  badge_id: string
  is_first_earn: boolean
}

export interface EarnedBadge {
  badgeId: string
  missionId: string
  title: string
  difficulty: string
  gradeColor: string
  earnedAt: string
  isFirstEarn: boolean
}

export interface AwardBoardBadgesResult {
  badgeEligible: boolean
  badgeCount: number
  earnedBadges: EarnedBadge[]
}

function artworkFor(row: MissionBadgeRow): ArtworkSpec | undefined {
  return row.artwork != null ? artworkSpecSchema.parse(row.artwork) : undefined
}

function mapCatalogRow(row: MissionBadgeRow) {
  const artwork = artworkFor(row)
  const grade = badgeGradeForDifficulty(row.difficulty)

  return {
    badgeId: row.mission_id,
    missionId: row.mission_id,
    catalogVersion: row.catalog_version,
    title: row.label,
    category: row.category,
    difficulty: row.difficulty,
    gradeLabel: grade.label,
    gradeColor: grade.color,
    ...(artwork ? { artwork } : {}),
    sortOrder: row.sort_order,
  }
}

function isCatalogRowVisible(row: MissionBadgeRow, client: ClientCapabilities) {
  return (
    row.active !== false &&
    row.awards_badge !== false &&
    isVisibleToClient(row, client)
  )
}

function isFreeCell(board: BoardRow, cell: BoardCellRow): boolean {
  return cell.position === board.free_position
}

function isUneditedCell(cell: BoardCellRow): boolean {
  return (
    (cell as BoardCellRow & { original_mission_snapshot?: unknown })
      .original_mission_snapshot == null
  )
}

function isOfficialMissionCell(board: BoardRow, cell: BoardCellRow): boolean {
  return (
    !isFreeCell(board, cell) &&
    isUneditedCell(cell) &&
    Boolean(cell.mission_snapshot?.id)
  )
}

@Injectable()
export class BadgesService {
  constructor(private readonly supabase: SupabaseService) {}

  private get admin(): any {
    return this.supabase.adminClient
  }

  private async loadVisibleCatalogRows(
    client: ClientCapabilities,
  ): Promise<MissionBadgeRow[]> {
    const { data, error } = await this.admin
      .from('mission_content')
      .select(MISSION_BADGE_CATALOG_SELECT)
      .eq('catalog_version', MISSION_CATALOG_VERSION)
      .eq('active', true)
      .eq('awards_badge', true)
      .order('sort_order', { ascending: true })

    if (error) throw error

    return ((data ?? []) as MissionBadgeRow[]).filter((row) =>
      isCatalogRowVisible(row, client),
    )
  }

  async listCatalog(client: ClientCapabilities = LEGACY_CLIENT_CAPABILITIES) {
    const catalog = await this.loadVisibleCatalogRows(client)
    return catalog.map(mapCatalogRow)
  }

  async listUserBadges(
    userId: string,
    query: UserBadgesQueryInput,
    client: ClientCapabilities = LEGACY_CLIENT_CAPABILITIES,
  ) {
    const catalog = await this.loadVisibleCatalogRows(client)

    const { data: userBadgeData, error: userBadgeError } = await this.admin
      .from('user_badges')
      .select(
        'user_id, mission_id, earned_catalog_version, first_board_id, last_board_id, first_earned_at, last_earned_at, earned_count',
      )
      .eq('user_id', userId)

    if (userBadgeError) throw userBadgeError

    const userBadgeMap = new Map<string, UserBadgeRow>()
    for (const row of (userBadgeData ?? []) as UserBadgeRow[]) {
      userBadgeMap.set(row.mission_id, row)
    }

    const difficultyFilter = query.difficulty
    const statusFilter = query.status

    const filteredCatalog = catalog.filter((badge) => {
      if (
        difficultyFilter !== 'all' &&
        badge.difficulty !== difficultyFilter
      ) {
        return false
      }
      const earned = userBadgeMap.has(badge.mission_id)
      if (statusFilter === 'earned' && !earned) return false
      if (statusFilter === 'locked' && earned) return false
      return true
    })

    const totalCount = catalog.length
    let earnedCount = 0
    let easyEarnedCount = 0
    let mediumEarnedCount = 0
    let hardEarnedCount = 0

    for (const badge of catalog) {
      if (userBadgeMap.has(badge.mission_id)) {
        earnedCount += 1
        if (badge.difficulty === 'easy') easyEarnedCount += 1
        else if (badge.difficulty === 'medium') mediumEarnedCount += 1
        else if (badge.difficulty === 'hard') hardEarnedCount += 1
      }
    }

    const badges = filteredCatalog.map((badge) => {
      const userBadge = userBadgeMap.get(badge.mission_id)
      const artwork = artworkFor(badge)
      const grade = badgeGradeForDifficulty(badge.difficulty)
      return {
        badgeId: badge.mission_id,
        missionId: badge.mission_id,
        title: badge.label,
        difficulty: badge.difficulty,
        gradeColor: grade.color,
        ...(artwork ? { artwork } : {}),
        earned: Boolean(userBadge),
        earnedCount: userBadge?.earned_count ?? 0,
        firstEarnedAt: userBadge?.first_earned_at ?? null,
        lastEarnedAt: userBadge?.last_earned_at ?? null,
        sourceBoardId: userBadge?.last_board_id ?? null,
      }
    })

    return {
      summary: {
        earnedCount,
        totalCount,
        easyEarnedCount,
        mediumEarnedCount,
        hardEarnedCount,
      },
      badges,
    }
  }

  async getUserBadgeDetail(
    userId: string,
    badgeId: string,
    client: ClientCapabilities = LEGACY_CLIENT_CAPABILITIES,
  ) {
    const { data: badgeData, error: badgeError } = await this.admin
      .from('mission_content')
      .select(MISSION_BADGE_CATALOG_SELECT)
      .eq('mission_id', badgeId)
      .eq('catalog_version', MISSION_CATALOG_VERSION)
      .eq('active', true)
      .eq('awards_badge', true)
      .maybeSingle()

    if (badgeError) throw badgeError

    const badge = badgeData as MissionBadgeRow | null
    if (!badge) return null
    if (!isCatalogRowVisible(badge, client)) return null

    const artwork = artworkFor(badge)
    const grade = badgeGradeForDifficulty(badge.difficulty)

    const { data: userBadgeData, error: userBadgeError } = await this.admin
      .from('user_badges')
      .select(
        'user_id, mission_id, earned_catalog_version, first_board_id, last_board_id, first_earned_at, last_earned_at, earned_count',
      )
      .eq('user_id', userId)
      .eq('mission_id', badgeId)
      .maybeSingle()

    if (userBadgeError) throw userBadgeError

    const userBadge = userBadgeData as UserBadgeRow | null

    return {
      badgeId: badge.mission_id,
      missionId: badge.mission_id,
      title: badge.label,
      difficulty: badge.difficulty,
      gradeLabel: grade.label,
      gradeColor: grade.color,
      ...(artwork ? { artwork } : {}),
      earned: Boolean(userBadge),
      earnedCount: userBadge?.earned_count ?? 0,
      firstEarnedAt: userBadge?.first_earned_at ?? null,
      lastEarnedAt: userBadge?.last_earned_at ?? null,
      // sourceBoardId follows the list endpoint: the most recent board that
      // earned the badge (last_board_id), so list and detail deep-link to the
      // same board for a given badge.
      sourceBoardId: userBadge?.last_board_id ?? null,
    }
  }

  async awardBoardBadges(params: {
    userId: string
    board: BoardRow
    cells: readonly BoardCellRow[]
  }): Promise<AwardBoardBadgesResult> {
    const { userId, board, cells } = params

    // 1. Eligibility re-check via derived predicate (flag-drift safe)
    const isMissionBoard = (board.board_kind ?? 'mission') === 'mission'
    const allCellsUnedited = cells.every(isUneditedCell)
    const boardSize = board.cell_ids?.length ?? 0
    const completedCount = cells.filter(
      (cell) =>
        cell.completed_at != null ||
        cell.marked_at != null ||
        cell.photo_id != null ||
        cell.clip_id != null ||
        cell.position === board.free_position,
    ).length
    const isFullyCompleted = boardSize > 0 && completedCount >= boardSize

    const badgeEligible = isMissionBoard && allCellsUnedited && isFullyCompleted

    if (!badgeEligible) {
      return { badgeEligible: false, badgeCount: 0, earnedBadges: [] }
    }

    // 2. Collect non-free official mission_ids from cells
    const missionIds = [
      ...new Set(
        cells
          .filter((cell) => isOfficialMissionCell(board, cell))
          .map((cell) => cell.mission_snapshot!.id)
          .filter((id): id is string => Boolean(id)),
      ),
    ]

    if (missionIds.length === 0) {
      return { badgeEligible: true, badgeCount: 0, earnedBadges: [] }
    }

    // 3. Look up awardable mission_content rows by mission_id.
    const { data: catalogData, error: catalogError } = await this.admin
      .from('mission_content')
      .select(MISSION_BADGE_AWARD_SELECT)
      .eq('catalog_version', MISSION_CATALOG_VERSION)
      .in('mission_id', missionIds)
      .eq('active', true)
      .eq('awards_badge', true)

    if (catalogError) throw catalogError

    const catalogRows = (catalogData ?? []) as MissionBadgeRow[]
    const awardMissionIds = catalogRows.map((row) => row.mission_id)

    if (awardMissionIds.length === 0) {
      return { badgeEligible: true, badgeCount: 0, earnedBadges: [] }
    }

    const catalogByMissionId = new Map(
      catalogRows.map((row) => [row.mission_id, row]),
    )

    // 4. Call RPC: award_board_badges(p_user_id, p_board_id, p_badge_ids).
    // The SQL signature is preserved; p_badge_ids now carries mission_id[].
    const { data: rpcData, error: rpcError } = await this.admin.rpc(
      'award_board_badges',
      {
        p_user_id: userId,
        p_board_id: board.id,
        p_badge_ids: awardMissionIds,
      },
    )

    if (rpcError) throw rpcError

    // 5. Build earnedBadges from RPC return (badge_id=mission_id) + catalog.
    const rpcResults = (rpcData ?? []) as RpcAwardResult[]

    const boardBadgeEarnedAt = new Date().toISOString()
    const earnedBadges: EarnedBadge[] = rpcResults
      .map((result): EarnedBadge | null => {
        const catalog = catalogByMissionId.get(result.badge_id)
        if (!catalog) return null
        const grade = badgeGradeForDifficulty(catalog.difficulty)

        return {
          badgeId: result.badge_id,
          missionId: catalog.mission_id,
          title: catalog.label,
          difficulty: catalog.difficulty,
          gradeColor: grade.color,
          earnedAt: boardBadgeEarnedAt,
          isFirstEarn: result.is_first_earn,
        }
      })
      .filter((b): b is EarnedBadge => b !== null)

    return {
      badgeEligible: true,
      badgeCount: earnedBadges.length,
      earnedBadges,
    }
  }

  async getBoardBadges(
    userId: string,
    boardIds: string[],
  ): Promise<Map<string, BoardBadgeWithCatalog[]>> {
    if (boardIds.length === 0) return new Map()

    const { data: boardBadgeData, error: boardBadgeError } = await this.admin
      .from('board_badges')
      .select('board_id, mission_id, user_id, earned_at')
      .eq('user_id', userId)
      .in('board_id', boardIds)

    if (boardBadgeError) throw boardBadgeError

    const boardBadgeRows = (boardBadgeData ?? []) as BoardBadgeRow[]
    if (boardBadgeRows.length === 0) return new Map()

    const uniqueMissionIds = [
      ...new Set(boardBadgeRows.map((row) => row.mission_id)),
    ]

    // Earned badges are a permanent achievement record: look them up by
    // mission_id only, intentionally ignoring active/catalog_version so a
    // historically-earned badge still renders using the current mission row.
    const { data: catalogData, error: catalogError } = await this.admin
      .from('mission_content')
      .select(MISSION_BADGE_AWARD_SELECT)
      .in('mission_id', uniqueMissionIds)

    if (catalogError) throw catalogError

    const catalogMap = new Map(
      ((catalogData ?? []) as MissionBadgeRow[]).map((row) => [
        row.mission_id,
        row,
      ]),
    )

    const result = new Map<string, BoardBadgeWithCatalog[]>()

    for (const row of boardBadgeRows) {
      const catalog = catalogMap.get(row.mission_id)
      if (!catalog) continue
      const grade = badgeGradeForDifficulty(catalog.difficulty)

      const list = result.get(row.board_id) ?? []
      list.push({
        badgeId: row.mission_id,
        missionId: catalog.mission_id,
        title: catalog.label,
        difficulty: catalog.difficulty,
        gradeColor: grade.color,
        earnedAt: row.earned_at,
      })
      result.set(row.board_id, list)
    }

    return result
  }
}

export interface BoardBadgeWithCatalog {
  badgeId: string
  missionId: string
  title: string
  difficulty: string
  gradeColor: string
  earnedAt: string
}
