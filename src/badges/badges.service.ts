import { Injectable } from '@nestjs/common'

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

const MISSION_BADGE_CONTENT_JOIN =
  'mission_content!mission_badges_mission_content_fkey(label, category, difficulty, artwork, active, min_app_build, required_capabilities, active_from, active_until)'

const MISSION_BADGE_CATALOG_SELECT = `id, mission_id, catalog_version, grade_label, grade_color, artwork_key, artwork, sort_order, active, min_app_build, required_capabilities, active_from, active_until, ${MISSION_BADGE_CONTENT_JOIN}`

const MISSION_BADGE_AWARD_SELECT = `id, mission_id, catalog_version, grade_color, grade_label, active, ${MISSION_BADGE_CONTENT_JOIN}`

interface MissionBadgeContentRow extends CapabilityGatedRow {
  label: string
  category: string
  difficulty: string | null
  artwork: unknown
  active: boolean | null
}

interface MissionBadgeRow extends CapabilityGatedRow {
  id: string
  mission_id: string
  catalog_version: string
  grade_label: string
  grade_color: string
  artwork_key: string | null
  artwork: unknown
  sort_order: number
  active: boolean
  mission_content: MissionBadgeContentRow | MissionBadgeContentRow[] | null
}

interface MissionBadgeContentOwner {
  id: string
  mission_id: string
  catalog_version: string
  mission_content: MissionBadgeContentRow | MissionBadgeContentRow[] | null
}

interface BoardBadgeRow {
  board_id: string
  badge_id: string
  user_id: string
  earned_at: string
}

interface UserBadgeRow {
  user_id: string
  badge_id: string
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

function mapCatalogRow(row: MissionBadgeRow) {
  const content = missionContentFor(row)
  const artwork = artworkFor(row, content)
  return {
    badgeId: row.id,
    missionId: row.mission_id,
    catalogVersion: row.catalog_version,
    title: content.label,
    category: content.category,
    difficulty: effectiveDifficulty(content),
    gradeLabel: row.grade_label,
    gradeColor: row.grade_color,
    artworkKey: row.artwork_key,
    ...(artwork ? { artwork } : {}),
    sortOrder: row.sort_order,
  }
}

function missionContentFor(
  row: MissionBadgeContentOwner,
): MissionBadgeContentRow {
  const content = Array.isArray(row.mission_content)
    ? row.mission_content[0]
    : row.mission_content
  if (!content) {
    throw new Error(
      `Mission content missing for badge ${row.id} (${row.catalog_version}/${row.mission_id}).`,
    )
  }
  return content
}

function effectiveDifficulty(content: MissionBadgeContentRow): string {
  return content.difficulty ?? 'easy'
}

function artworkFor(
  row: MissionBadgeRow,
  content: MissionBadgeContentRow,
): ArtworkSpec | undefined {
  const artwork = row.artwork ?? content.artwork
  return artwork != null ? artworkSpecSchema.parse(artwork) : undefined
}

function isCatalogRowVisible(row: MissionBadgeRow, client: ClientCapabilities) {
  const content = missionContentFor(row)
  return (
    isVisibleToClient(row, client) &&
    content.active !== false &&
    isVisibleToClient(content, client)
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

  async listCatalog(client: ClientCapabilities = LEGACY_CLIENT_CAPABILITIES) {
    const { data, error } = await this.admin
      .from('mission_badges')
      .select(MISSION_BADGE_CATALOG_SELECT)
      .eq('catalog_version', MISSION_CATALOG_VERSION)
      .eq('active', true)
      .order('sort_order', { ascending: true })

    if (error) throw error

    return ((data ?? []) as MissionBadgeRow[])
      .filter((row) => isCatalogRowVisible(row, client))
      .map(mapCatalogRow)
  }

  async listUserBadges(
    userId: string,
    query: UserBadgesQueryInput,
    client: ClientCapabilities = LEGACY_CLIENT_CAPABILITIES,
  ) {
    const { data: catalogData, error: catalogError } = await this.admin
      .from('mission_badges')
      .select(MISSION_BADGE_CATALOG_SELECT)
      .eq('catalog_version', MISSION_CATALOG_VERSION)
      .eq('active', true)
      .order('sort_order', { ascending: true })

    if (catalogError) throw catalogError

    const catalog = ((catalogData ?? []) as MissionBadgeRow[]).filter((row) =>
      isCatalogRowVisible(row, client),
    )

    const { data: userBadgeData, error: userBadgeError } = await this.admin
      .from('user_badges')
      .select(
        'user_id, badge_id, first_board_id, last_board_id, first_earned_at, last_earned_at, earned_count',
      )
      .eq('user_id', userId)

    if (userBadgeError) throw userBadgeError

    const userBadgeMap = new Map<string, UserBadgeRow>()
    for (const row of (userBadgeData ?? []) as UserBadgeRow[]) {
      userBadgeMap.set(row.badge_id, row)
    }

    const difficultyFilter = query.difficulty
    const statusFilter = query.status

    const filteredCatalog = catalog.filter((badge) => {
      const difficulty = effectiveDifficulty(missionContentFor(badge))
      if (difficultyFilter !== 'all' && difficulty !== difficultyFilter) {
        return false
      }
      const earned = userBadgeMap.has(badge.id)
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
      if (userBadgeMap.has(badge.id)) {
        const difficulty = effectiveDifficulty(missionContentFor(badge))
        earnedCount += 1
        if (difficulty === 'easy') easyEarnedCount += 1
        else if (difficulty === 'medium') mediumEarnedCount += 1
        else if (difficulty === 'hard') hardEarnedCount += 1
      }
    }

    const badges = filteredCatalog.map((badge) => {
      const userBadge = userBadgeMap.get(badge.id)
      const content = missionContentFor(badge)
      const artwork = artworkFor(badge, content)
      return {
        badgeId: badge.id,
        missionId: badge.mission_id,
        title: content.label,
        difficulty: effectiveDifficulty(content),
        gradeColor: badge.grade_color,
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
      .from('mission_badges')
      .select(MISSION_BADGE_CATALOG_SELECT)
      .eq('id', badgeId)
      .eq('catalog_version', MISSION_CATALOG_VERSION)
      .eq('active', true)
      .maybeSingle()

    if (badgeError) throw badgeError

    const badge = badgeData as MissionBadgeRow | null
    if (!badge) return null
    if (!isCatalogRowVisible(badge, client)) return null

    const content = missionContentFor(badge)
    const artwork = artworkFor(badge, content)

    const { data: userBadgeData, error: userBadgeError } = await this.admin
      .from('user_badges')
      .select(
        'user_id, badge_id, first_board_id, last_board_id, first_earned_at, last_earned_at, earned_count',
      )
      .eq('user_id', userId)
      .eq('badge_id', badgeId)
      .maybeSingle()

    if (userBadgeError) throw userBadgeError

    const userBadge = userBadgeData as UserBadgeRow | null

    return {
      badgeId: badge.id,
      missionId: badge.mission_id,
      title: content.label,
      difficulty: effectiveDifficulty(content),
      gradeLabel: badge.grade_label,
      gradeColor: badge.grade_color,
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
    const missionIds = cells
      .filter((cell) => isOfficialMissionCell(board, cell))
      .map((cell) => cell.mission_snapshot!.id)
      .filter((id): id is string => Boolean(id))

    if (missionIds.length === 0) {
      return { badgeEligible: true, badgeCount: 0, earnedBadges: [] }
    }

    // 3. Look up mission_badges by (catalog_version, mission_id) → badge ids + catalog info
    const { data: catalogData, error: catalogError } = await this.admin
      .from('mission_badges')
      .select(MISSION_BADGE_AWARD_SELECT)
      .eq('catalog_version', MISSION_CATALOG_VERSION)
      .in('mission_id', missionIds)
      .eq('active', true)

    if (catalogError) throw catalogError

    const catalogRows = (catalogData ?? []) as Array<{
      id: string
      mission_id: string
      catalog_version: string
      grade_color: string
      grade_label: string
      active: boolean
      mission_content: MissionBadgeContentRow | MissionBadgeContentRow[] | null
    }>

    const badgeIds = catalogRows.map((row) => row.id)

    if (badgeIds.length === 0) {
      return { badgeEligible: true, badgeCount: 0, earnedBadges: [] }
    }

    const catalogById = new Map(catalogRows.map((row) => [row.id, row]))

    // 4. Call RPC: award_board_badges(p_user_id, p_board_id, p_badge_ids)
    const { data: rpcData, error: rpcError } = await this.admin.rpc(
      'award_board_badges',
      {
        p_user_id: userId,
        p_board_id: board.id,
        p_badge_ids: badgeIds,
      },
    )

    if (rpcError) throw rpcError

    // 5. Build earnedBadges from RPC return (badge_id, is_first_earn) + catalog
    const rpcResults = (rpcData ?? []) as RpcAwardResult[]

    const boardBadgeEarnedAt = new Date().toISOString()
    const earnedBadges: EarnedBadge[] = rpcResults
      .map((result) => {
        const catalog = catalogById.get(result.badge_id)
        if (!catalog) return null
        const content = missionContentFor(catalog)

        return {
          badgeId: result.badge_id,
          missionId: catalog.mission_id,
          title: content.label,
          difficulty: effectiveDifficulty(content),
          gradeColor: catalog.grade_color,
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
      .select('board_id, badge_id, user_id, earned_at')
      .eq('user_id', userId)
      .in('board_id', boardIds)

    if (boardBadgeError) throw boardBadgeError

    const boardBadgeRows = (boardBadgeData ?? []) as BoardBadgeRow[]
    if (boardBadgeRows.length === 0) return new Map()

    const uniqueBadgeIds = [
      ...new Set(boardBadgeRows.map((row) => row.badge_id)),
    ]

    // Earned badges are a permanent achievement record: look them up by id only,
    // intentionally ignoring active/catalog_version so a historically-earned
    // badge still renders even if its catalog row is later deactivated or
    // superseded by a new catalog version. Do not add an active/version filter.
    const { data: catalogData, error: catalogError } = await this.admin
      .from('mission_badges')
      .select(MISSION_BADGE_AWARD_SELECT)
      .in('id', uniqueBadgeIds)

    if (catalogError) throw catalogError

    const catalogMap = new Map(
      ((catalogData ?? []) as MissionBadgeRow[]).map((row) => [row.id, row]),
    )

    const result = new Map<string, BoardBadgeWithCatalog[]>()

    for (const row of boardBadgeRows) {
      const catalog = catalogMap.get(row.badge_id)
      if (!catalog) continue
      const content = missionContentFor(catalog)

      const list = result.get(row.board_id) ?? []
      list.push({
        badgeId: row.badge_id,
        missionId: catalog.mission_id,
        title: content.label,
        difficulty: effectiveDifficulty(content),
        gradeColor: catalog.grade_color,
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
