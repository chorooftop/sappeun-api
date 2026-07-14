import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common'

import { BadgesService } from '@/badges/badges.service'
import { writeStructuredLog } from '@/common/observability/structured-log'
import { ClockService } from '@/common/time/clock.service'
import { computeLifecycle, kstDateOf } from '@/common/time/kst'
import { ConnectionsService } from '@/connections/connections.service'
import { summarizeGroupBoardCompletion } from '@/group-boards/group-board-completion'
import { buildGroupBoardSeed } from '@/group-boards/group-board-seed'
import {
  GROUP_BOARD_CELL_MEDIA_SELECT,
  GROUP_BOARD_CELL_SELECT,
  GROUP_BOARD_SELECT,
  type GroupBoardCellMediaRow,
  type GroupBoardCellRow,
  type GroupBoardRow,
} from '@/group-boards/group-board.types'
import {
  GROUP_BOARD_SIZE,
  GROUP_REROLL_LIMIT,
  groupBingoEnabled,
} from '@/group-boards/group-boards.constants'
import { SIGNED_PREVIEW_EXPIRES_SECONDS } from '@/media/media.constants'
import { signedUrlExpiresAt } from '@/media/media.utils'
import { MissionsService } from '@/missions/missions.service'
import { R2Service } from '@/storage/r2.service'
import { SupabaseService } from '@/supabase/supabase.service'

interface MediaObjectRow {
  id: string
  storage_path: string
  poster_storage_path?: string | null
  bucket_name: string | null
  uploaded_at: string | null
}

export interface CellMediaDto {
  id: string
  userId: string
  kind: 'photo' | 'clip'
  photoId: string | null
  clipId: string | null
  previewUrl: string | null
  posterPreviewUrl: string | null
  previewUrlExpiresAt: string
}

const GROUP_RPC_ERROR_TOKENS = [
  'NOT_GROUP_MEMBER',
  'GROUP_DELETED',
  'GROUP_BOARD_NOT_FOUND',
  'GROUP_BOARD_NOT_COMPLETED',
  'REROLL_LOCKED',
  'INVALID_BOARD_SEED',
] as const

function mapGroupBoardRpcError(error: { message?: string }): Error {
  const message = error.message ?? ''
  const token = GROUP_RPC_ERROR_TOKENS.find((candidate) =>
    message.includes(candidate),
  )

  switch (token) {
    case 'NOT_GROUP_MEMBER':
      return new ForbiddenException('Not an active member of this group.')
    case 'GROUP_DELETED':
    case 'GROUP_BOARD_NOT_FOUND':
      return new NotFoundException('Group board not found.')
    case 'GROUP_BOARD_NOT_COMPLETED':
      return new BadRequestException('Group board is not completed.')
    case 'REROLL_LOCKED':
      return new ConflictException({
        code: 'REROLL_LOCKED',
        message: 'Reroll is locked for this board.',
      })
    case 'INVALID_BOARD_SEED':
      return new BadRequestException('Invalid board seed.')
    default:
      return error instanceof Error ? error : new Error(message)
  }
}

function assertGroupBingoEnabled() {
  if (!groupBingoEnabled()) {
    throw new NotFoundException('Group bingo is disabled.')
  }
}

function assertCellPosition(position: number) {
  if (
    !Number.isInteger(position) ||
    position < 0 ||
    position >= GROUP_BOARD_SIZE
  ) {
    throw new BadRequestException('Invalid position.')
  }
  return position
}

@Injectable()
export class GroupBoardsService {
  constructor(
    private readonly supabase: SupabaseService,
    private readonly connections: ConnectionsService,
    private readonly missions: MissionsService,
    private readonly badges: BadgesService,
    private readonly r2: R2Service,
    private readonly clock: ClockService = new ClockService(),
  ) {}

  private get admin() {
    return this.supabase.adminClient
  }

  private now() {
    return this.clock.now()
  }

  async getTodayBoard(userId: string, groupId: string) {
    assertGroupBingoEnabled()
    await this.connections.assertActiveGroupMember(userId, groupId)

    const board = await this.resolveCurrentBoard(userId, groupId, {
      createIfMissing: true,
    })
    if (!board) throw new NotFoundException('Group board not found.')

    const cells = await this.getBoardCells(board.id)
    await this.selfHealAward(board, cells)

    return { board: await this.toBoardDto(board, cells) }
  }

  async rerollBoard(userId: string, groupId: string) {
    assertGroupBingoEnabled()
    await this.connections.assertActiveGroupMember(userId, groupId)

    const board = await this.resolveCurrentBoard(userId, groupId, {
      createIfMissing: false,
    })
    if (!board) throw new NotFoundException('Group board not found.')

    const dailyDate = kstDateOf(this.now())
    const { cells: missionCells } = await this.missions.getMissionContent()
    const seed = buildGroupBoardSeed({
      groupId,
      dailyDate,
      missions: missionCells,
    })

    const { data, error } = await this.admin.rpc('reroll_group_board', {
      p_user_id: userId,
      p_group_board_id: board.id,
      p_limit: GROUP_REROLL_LIMIT,
      p_seed_recipe: seed.seedRecipe,
      p_cell_ids: seed.cellIds,
      p_free_position: seed.freePosition,
      p_cells: seed.cells,
    })

    if (error) throw mapGroupBoardRpcError(error)
    const updated = (Array.isArray(data) ? data[0] : data) as GroupBoardRow

    return {
      rerollCount: updated.reroll_count,
      rerollLimit: GROUP_REROLL_LIMIT,
      rerollsRemaining: Math.max(0, GROUP_REROLL_LIMIT - updated.reroll_count),
    }
  }

  async getCell(userId: string, groupId: string, position: number) {
    assertGroupBingoEnabled()
    assertCellPosition(position)
    await this.connections.assertActiveGroupMember(userId, groupId)

    const board = await this.resolveCurrentBoard(userId, groupId, {
      createIfMissing: false,
    })
    if (!board) throw new NotFoundException('Group board not found.')

    const { data, error } = await this.admin
      .from('group_board_cells')
      .select(GROUP_BOARD_CELL_SELECT)
      .eq('group_board_id', board.id)
      .eq('position', position)
      .maybeSingle()

    if (error) throw error
    const cell = data as GroupBoardCellRow | null
    if (!cell) throw new NotFoundException('Cell not found.')

    const mediaRows = await this.getBoardCellMedia(board.id, position)
    const media = (await this.toCellMediaDtos(mediaRows)).filter(
      (dto): dto is CellMediaDto => dto !== null,
    )

    // API contract (AC-14): completedAt can be set while media is empty —
    // completion is monotonic and survives deleting every media row.
    return { cell: this.toCellDto(board, cell, media) }
  }

  async endBoard(userId: string, groupId: string) {
    assertGroupBingoEnabled()
    await this.connections.assertActiveGroupMember(userId, groupId)

    const board = await this.resolveCurrentBoard(userId, groupId, {
      createIfMissing: false,
    })
    if (!board) throw new NotFoundException('Group board not found.')

    const cells = await this.getBoardCells(board.id)
    if (!board.ended_at) {
      const summary = summarizeGroupBoardCompletion(board, cells)
      if (!summary.isFullyCompleted) {
        throw new BadRequestException('Board is not fully completed.')
      }
    }

    const closed = await this.closeBoard(board.id, 'completed')
    await this.selfHealAward(closed, cells)

    return { ok: true, board: await this.toBoardDto(closed, cells) }
  }

  /**
   * Home aggregation (AC-16): read-only summaries of today's board per
   * active-membership group. Never auto-creates or lazy-closes — that stays
   * on the board GET so the home list is cheap.
   */
  async getHomeSummaries(userId: string) {
    if (!groupBingoEnabled()) return []

    const { groups } = await this.connections.listGroups(userId)
    const today = kstDateOf(this.now())
    return Promise.all(
      groups.map(async (group) => {
        const latest = await this.findLatestBoard(group.id)
        // Current = today's board, or yesterday's still-open board inside its
        // grace window (matches resolveCurrentBoard without closing/creating).
        const isCurrent =
          latest != null &&
          (latest.daily_date === today ||
            (!latest.ended_at &&
              computeLifecycle(latest.daily_date, this.now()).state !==
                'expired'))
        const board = isCurrent ? latest : null
        if (!board) {
          return {
            groupId: group.id,
            groupName: group.name,
            memberCount: group.memberCount,
            board: null,
          }
        }

        const cells = await this.getBoardCells(board.id)
        const summary = summarizeGroupBoardCompletion(board, cells)
        return {
          groupId: group.id,
          groupName: group.name,
          memberCount: group.memberCount,
          board: {
            id: board.id,
            dailyDate: board.daily_date,
            lifecycle: board.ended_at
              ? 'expired'
              : computeLifecycle(board.daily_date, this.now()).state,
            endedAt: board.ended_at,
            endReason: board.end_reason,
            completedCount: summary.completedCount,
            isFullyCompleted: summary.isFullyCompleted,
          },
        }
      }),
    )
  }

  /**
   * Ownership-based deletion (AC-14): deliberately NOT gated on active
   * membership — a member who left the group can still delete their own
   * media. Cell completion, first_media_at, badges and streaks are monotonic
   * and stay untouched (unlike the personal path, which resets completed_at).
   */
  async deleteCellMedia(userId: string, groupId: string, mediaId: string) {
    assertGroupBingoEnabled()

    const { data, error } = await this.admin
      .from('group_board_cell_media')
      .select(GROUP_BOARD_CELL_MEDIA_SELECT)
      .eq('id', mediaId)
      .is('deleted_at', null)
      .maybeSingle()

    if (error) throw error
    const media = data as GroupBoardCellMediaRow | null
    if (!media) throw new NotFoundException('Media not found.')

    const { data: boardData, error: boardError } = await this.admin
      .from('group_boards')
      .select('id, group_id')
      .eq('id', media.group_board_id)
      .maybeSingle()

    if (boardError) throw boardError
    if (!boardData || (boardData as { group_id: string }).group_id !== groupId) {
      throw new NotFoundException('Media not found.')
    }

    if (media.user_id !== userId) {
      throw new ForbiddenException('Only the uploader can delete this media.')
    }

    const now = this.now().toISOString()

    if (media.photo_id) {
      const photo = await this.getOwnMediaObject('photos', media.photo_id, userId)
      if (photo) {
        await this.r2.deleteObjects([photo.storage_path], photo.bucket_name)
        const { error: photoError } = await this.admin
          .from('photos')
          .update({ deleted_at: now })
          .eq('id', media.photo_id)
        if (photoError) throw photoError
      }
    }

    if (media.clip_id) {
      const clip = await this.getOwnMediaObject('clips', media.clip_id, userId)
      if (clip) {
        const keys = [clip.storage_path, clip.poster_storage_path].filter(
          (key): key is string => Boolean(key),
        )
        await this.r2.deleteObjects(keys, clip.bucket_name)
        const { error: clipError } = await this.admin
          .from('clips')
          .update({ deleted_at: now })
          .eq('id', media.clip_id)
        if (clipError) throw clipError
      }
    }

    const { error: mediaError } = await this.admin
      .from('group_board_cell_media')
      .update({ deleted_at: now })
      .eq('id', media.id)
    if (mediaError) throw mediaError

    return { ok: true }
  }

  private async getOwnMediaObject(
    table: 'photos' | 'clips',
    id: string,
    userId: string,
  ) {
    const columns =
      table === 'clips'
        ? 'id, user_id, storage_path, poster_storage_path, bucket_name'
        : 'id, user_id, storage_path, bucket_name'

    const { data, error } = await this.admin
      .from(table)
      .select(columns)
      .eq('id', id)
      .eq('user_id', userId)
      .is('deleted_at', null)
      .maybeSingle()

    if (error) throw error
    return data as
      | (MediaObjectRow & { user_id: string; poster_storage_path?: string | null })
      | null
  }

  private async findLatestBoard(groupId: string) {
    const { data, error } = await this.admin
      .from('group_boards')
      .select(GROUP_BOARD_SELECT)
      .eq('group_id', groupId)
      .is('deleted_at', null)
      .order('daily_date', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (error) throw error
    return data as GroupBoardRow | null
  }

  /**
   * Resolves the group's current board across the KST day boundary,
   * mirroring the personal path's latest-open-board semantics (AC-12):
   * yesterday's board stays current through its 00:00-01:00 grace window,
   * an open board past grace is lazily closed as auto_grace_expired
   * (single-winner RPC), and a completed board whose award fanout was lost
   * to a crash is healed here even after the date rolled over — the
   * day-scoped flows can no longer see it, so this is the last retry point.
   */
  private async resolveCurrentBoard(
    userId: string,
    groupId: string,
    options: { createIfMissing: boolean },
  ): Promise<GroupBoardRow | null> {
    const today = kstDateOf(this.now())
    let latest = await this.findLatestBoard(groupId)

    if (latest && !latest.ended_at) {
      const lifecycle = computeLifecycle(latest.daily_date, this.now())
      if (lifecycle.state !== 'expired') return latest
      latest = await this.closeBoard(latest.id, 'auto_grace_expired')
    }

    if (latest?.ended_at) {
      if (latest.end_reason === 'completed' && latest.daily_date !== today) {
        await this.selfHealAward(latest, await this.getBoardCells(latest.id))
      }
      if (latest.daily_date === today) return latest
    }

    if (!options.createIfMissing) return null
    return this.createTodayBoard(userId, groupId)
  }

  private async createTodayBoard(userId: string, groupId: string) {
    const dailyDate = kstDateOf(this.now())
    const { cells: missionCells } = await this.missions.getMissionContent()
    const seed = buildGroupBoardSeed({
      groupId,
      dailyDate,
      missions: missionCells,
    })

    // AC-7: concurrent first visitors converge inside the RPC (unique index +
    // 23505 catch re-select).
    const { data, error } = await this.admin.rpc('get_or_create_group_board', {
      p_user_id: userId,
      p_group_id: groupId,
      p_daily_date: dailyDate,
      p_seed_recipe: seed.seedRecipe,
      p_cell_ids: seed.cellIds,
      p_free_position: seed.freePosition,
      p_cells: seed.cells,
    })

    if (error) throw mapGroupBoardRpcError(error)
    const board = (Array.isArray(data) ? data[0] : data) as GroupBoardRow
    writeStructuredLog('info', 'group_board_resolved', {
      groupId,
      groupBoardId: board.id,
      dailyDate: board.daily_date,
    })
    return board
  }

  private async closeBoard(
    groupBoardId: string,
    reason: 'completed' | 'auto_grace_expired',
  ) {
    const { data, error } = await this.admin.rpc('close_group_board', {
      p_group_board_id: groupBoardId,
      p_reason: reason,
    })

    if (error) throw mapGroupBoardRpcError(error)
    const board = (Array.isArray(data) ? data[0] : data) as GroupBoardRow
    writeStructuredLog('info', 'group_board_closed', {
      groupBoardId: board.id,
      endReason: board.end_reason,
      requestedReason: reason,
    })
    return board
  }

  /**
   * Self-heal award (plan v4): any active member who sees a completed board
   * without completion-ledger rows retries the idempotent fanout, so a
   * winner crashing between close and award can never permanently lose
   * badges or streak credits.
   */
  private async selfHealAward(
    board: GroupBoardRow,
    cells: readonly GroupBoardCellRow[],
  ) {
    if (!board.ended_at || board.end_reason !== 'completed') return

    const { data, error } = await this.admin
      .from('group_board_completions')
      .select('group_board_id')
      .eq('group_board_id', board.id)
      .limit(1)

    if (error) throw error
    if ((data ?? []).length > 0) return

    writeStructuredLog('info', 'group_board_award_self_heal', {
      groupBoardId: board.id,
      groupId: board.group_id,
      dailyDate: board.daily_date,
    })
    await this.badges.awardGroupBoardBadges({
      groupBoardId: board.id,
      cells,
      freePosition: board.free_position,
    })
  }

  private async getBoardCells(groupBoardId: string) {
    const { data, error } = await this.admin
      .from('group_board_cells')
      .select(GROUP_BOARD_CELL_SELECT)
      .eq('group_board_id', groupBoardId)
      .order('position', { ascending: true })

    if (error) throw error
    return (data ?? []) as GroupBoardCellRow[]
  }

  private async getBoardCellMedia(groupBoardId: string, position?: number) {
    let query = this.admin
      .from('group_board_cell_media')
      .select(GROUP_BOARD_CELL_MEDIA_SELECT)
      .eq('group_board_id', groupBoardId)
      .is('deleted_at', null)
      .order('created_at', { ascending: true })

    if (position != null) {
      query = query.eq('position', position)
    }

    const { data, error } = await query
    if (error) throw error
    return (data ?? []) as GroupBoardCellMediaRow[]
  }

  private async toBoardDto(
    board: GroupBoardRow,
    cells: readonly GroupBoardCellRow[],
  ) {
    const mediaRows = await this.getBoardCellMedia(board.id)
    const mediaDtos = await this.toCellMediaDtos(mediaRows)
    const mediaByPosition = new Map<number, CellMediaDto[]>()
    for (let i = 0; i < mediaRows.length; i += 1) {
      const dto = mediaDtos[i]
      if (!dto) continue
      const list = mediaByPosition.get(mediaRows[i].position) ?? []
      mediaByPosition.set(mediaRows[i].position, [...list, dto])
    }

    const summary = summarizeGroupBoardCompletion(board, cells)
    const lifecycle = board.ended_at
      ? 'expired'
      : computeLifecycle(board.daily_date, this.now()).state

    return {
      id: board.id,
      groupId: board.group_id,
      dailyDate: board.daily_date,
      mode: board.mode,
      cellIds: board.cell_ids,
      freePosition: board.free_position,
      rerollCount: board.reroll_count,
      rerollLimit: GROUP_REROLL_LIMIT,
      rerollsRemaining: Math.max(0, GROUP_REROLL_LIMIT - board.reroll_count),
      rerollLocked:
        board.first_media_at != null ||
        board.ended_at != null ||
        board.reroll_count >= GROUP_REROLL_LIMIT,
      firstMediaAt: board.first_media_at,
      lifecycle,
      endedAt: board.ended_at,
      endReason: board.end_reason,
      completedCount: summary.completedCount,
      isFullyCompleted: summary.isFullyCompleted,
      cells: cells.map((cell) =>
        this.toCellDto(board, cell, mediaByPosition.get(cell.position) ?? []),
      ),
    }
  }

  private toCellDto(
    board: GroupBoardRow,
    cell: GroupBoardCellRow,
    media: CellMediaDto[],
  ) {
    return {
      position: cell.position,
      cellId: cell.cell_id,
      isFree: cell.position === board.free_position,
      missionLabel: cell.mission_label,
      missionCaptureLabel: cell.mission_capture_label,
      missionCategory: cell.mission_category,
      missionSnapshot: cell.mission_snapshot,
      completedAt: cell.completed_at,
      completedBy: cell.completed_by,
      completionType: cell.completion_type,
      media,
    }
  }

  private async toCellMediaDtos(
    rows: readonly GroupBoardCellMediaRow[],
  ): Promise<(CellMediaDto | null)[]> {
    const photoIds = rows
      .map((row) => row.photo_id)
      .filter((id): id is string => Boolean(id))
    const clipIds = rows
      .map((row) => row.clip_id)
      .filter((id): id is string => Boolean(id))

    const [photos, clips] = await Promise.all([
      this.getMediaObjects('photos', photoIds),
      this.getMediaObjects('clips', clipIds),
    ])

    return Promise.all(
      rows.map(async (row): Promise<CellMediaDto | null> => {
        if (row.photo_id) {
          const photo = photos.get(row.photo_id)
          if (!photo) return null
          return {
            id: row.id,
            userId: row.user_id,
            kind: 'photo',
            photoId: row.photo_id,
            clipId: null,
            previewUrl: await this.r2.createPreviewUrl({
              objectKey: photo.storage_path,
              bucketName: photo.bucket_name,
              expiresInSeconds: SIGNED_PREVIEW_EXPIRES_SECONDS,
            }),
            posterPreviewUrl: null,
            previewUrlExpiresAt: signedUrlExpiresAt(
              SIGNED_PREVIEW_EXPIRES_SECONDS,
            ),
          }
        }

        if (row.clip_id) {
          const clip = clips.get(row.clip_id)
          if (!clip) return null
          const [previewUrl, posterPreviewUrl] = await Promise.all([
            this.r2.createPreviewUrl({
              objectKey: clip.storage_path,
              bucketName: clip.bucket_name,
              expiresInSeconds: SIGNED_PREVIEW_EXPIRES_SECONDS,
            }),
            clip.poster_storage_path
              ? this.r2.createPreviewUrl({
                  objectKey: clip.poster_storage_path,
                  bucketName: clip.bucket_name,
                  expiresInSeconds: SIGNED_PREVIEW_EXPIRES_SECONDS,
                })
              : Promise.resolve(null),
          ])
          return {
            id: row.id,
            userId: row.user_id,
            kind: 'clip',
            photoId: null,
            clipId: row.clip_id,
            previewUrl,
            posterPreviewUrl,
            previewUrlExpiresAt: signedUrlExpiresAt(
              SIGNED_PREVIEW_EXPIRES_SECONDS,
            ),
          }
        }

        return null
      }),
    )
  }

  private async getMediaObjects(
    table: 'photos' | 'clips',
    ids: readonly string[],
  ) {
    const objects = new Map<string, MediaObjectRow>()
    if (ids.length === 0) return objects

    const columns =
      table === 'clips'
        ? 'id, storage_path, poster_storage_path, bucket_name, uploaded_at'
        : 'id, storage_path, bucket_name, uploaded_at'

    const { data, error } = await this.admin
      .from(table)
      .select(columns)
      .in('id', [...ids])
      .not('uploaded_at', 'is', null)
      .is('deleted_at', null)

    if (error) throw error
    for (const row of (data ?? []) as MediaObjectRow[]) {
      objects.set(row.id, row)
    }
    return objects
  }
}
