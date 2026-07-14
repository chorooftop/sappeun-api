import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common'

import { BadgesService } from '@/badges/badges.service'
import type {
  BoardBadgeWithCatalog,
  EarnedBadge,
} from '@/badges/badges.service'
import type {
  BoardListQueryInput,
  BoardSessionInput,
  BoardSnapshotInput,
  EditBoardCellMissionInput,
  EndBoardInput,
  RestoreBoardCellMissionInput,
  UpdateBoardTitleInput,
} from '@/boards/boards.schemas'
import {
  boardSizeForMode,
  missionSnapshotSchema,
} from '@/boards/boards.schemas'
import { ClockService } from '@/common/time/clock.service'
import {
  computeLifecycle,
  kstDateOf,
  previousKstDate,
  type BoardLifecycle,
} from '@/common/time/kst'
import { StreakService } from '@/boards/streak.service'
import { SIGNED_PREVIEW_EXPIRES_SECONDS } from '@/media/media.constants'
import { signedUrlExpiresAt } from '@/media/media.utils'
import { R2Service } from '@/storage/r2.service'
import { SupabaseService } from '@/supabase/supabase.service'

export type BoardMode = '5x5' | '3x3'
export type BoardKind = 'mission' | 'custom'
export type BoardHistoryStatus = 'active' | 'completed'
export type CompletionType = 'photo' | 'no_photo' | 'clip' | 'no_media' | 'free'
export type BoardCustomizationStatus = 'official' | 'edited'
export type BoardEndReason = 'completed' | 'auto_grace_expired'

interface BoardIdRow {
  id: string
}

export interface LastBoardResult {
  boardId: string
  endReason: BoardEndReason | null
  completedCells: number
  dailyDate: string
  streakCount: number
}

export interface MissionSnapshot {
  id: string
  category: string
  label: string
  caption?: string
  captureLabel?: string
  hint?: string
  icon: string | null
  variant: string
}

export interface BoardRow {
  id: string
  user_id: string
  mode: BoardMode
  board_kind?: BoardKind | null
  client_session_id: string | null
  nickname: string | null
  title?: string | null
  description?: string | null
  free_position: number | null
  cell_ids: string[] | null
  created_at: string
  updated_at: string | null
  ended_at: string | null
  deleted_at?: string | null
  customization_status?: BoardCustomizationStatus | null
  daily_date?: string | null
  reroll_count?: number | null
  end_reason?: BoardEndReason | null
}

export interface BoardCellRow {
  board_id: string
  position: number
  cell_id: string
  photo_id: string | null
  clip_id?: string | null
  marked_at: string | null
  completed_at?: string | null
  completion_type?: CompletionType | null
  mission_label?: string | null
  mission_capture_label?: string | null
  mission_category?: string | null
  mission_snapshot?: MissionSnapshot | null
  mission_catalog_version?: string | null
  original_cell_id?: string | null
  original_mission_snapshot?: MissionSnapshot | null
  edited_at?: string | null
}

interface PhotoRow {
  id: string
  user_id: string
  board_id: string | null
  position: number | null
  cell_id: string | null
  storage_path: string
  storage_provider?: string | null
  bucket_name?: string | null
  uploaded_at: string | null
  captured_at?: string | null
  deleted_at: string | null
}

interface ClipRow {
  id: string
  user_id: string
  board_id: string
  position: number
  cell_id: string
  storage_path: string
  poster_storage_path: string | null
  storage_provider?: string | null
  bucket_name?: string | null
  duration_ms: number
  uploaded_at: string | null
  recorded_at: string | null
  description?: string | null
  deleted_at: string | null
}

const MISSION_CATALOG_VERSION = 'api-migration-v1'

const BOARD_CELL_EXTENDED_SELECT =
  'board_id, position, cell_id, photo_id, clip_id, marked_at, completed_at, completion_type, mission_label, mission_capture_label, mission_category, mission_snapshot, mission_catalog_version, original_cell_id, original_mission_snapshot, edited_at'

const PHOTO_HISTORY_SELECT =
  'id, user_id, board_id, position, cell_id, storage_path, storage_provider, bucket_name, uploaded_at, captured_at, deleted_at'

const CLIP_HISTORY_SELECT =
  'id, user_id, board_id, position, cell_id, storage_path, poster_storage_path, storage_provider, bucket_name, duration_ms, uploaded_at, recorded_at, description, deleted_at'

const BOARD_HISTORY_SELECT =
  'id, user_id, mode, board_kind, client_session_id, nickname, title, description, free_position, cell_ids, created_at, updated_at, ended_at, deleted_at, customization_status, daily_date, reroll_count, end_reason'

const COMPLETION_TYPES = new Set<CompletionType>([
  'photo',
  'no_photo',
  'clip',
  'no_media',
  'free',
])

const SUPPORTED_BOARD_MODE: BoardMode = '3x3'
const DAILY_REROLL_LIMIT = 3
const DAILY_BOARD_UNIQUE_INDEX = 'boards_user_daily_uidx'

function dailyBingoEnabled() {
  return process.env.DAILY_BINGO_ENABLED !== 'false'
}

function domainConflict(code: string, message: string) {
  return new ConflictException({ code, message })
}

function domainBadRequest(code: string, message: string) {
  return new BadRequestException({ code, message })
}

function boardDailyDate(board: Pick<BoardRow, 'daily_date' | 'created_at'>) {
  return board.daily_date ?? kstDateOf(new Date(board.created_at))
}

function boardRerollCount(board: Pick<BoardRow, 'reroll_count'>) {
  return board.reroll_count ?? 0
}

function isDailyUniqueConflict(error: { message?: string; details?: string }) {
  return [error.message, error.details].some((value) =>
    value?.includes(DAILY_BOARD_UNIQUE_INDEX),
  )
}

function boardKindFor(input: BoardSnapshotInput | BoardRow): BoardKind {
  const snapshot = input as Partial<BoardSnapshotInput>
  const row = input as Partial<BoardRow>
  return snapshot.boardKind ?? row.board_kind ?? 'mission'
}

function boardTitleFor(input: BoardSnapshotInput | BoardRow) {
  return input.title ?? input.nickname ?? '산책'
}

function boardDescriptionFor(input: BoardSnapshotInput | BoardRow) {
  return input.description?.trim() || undefined
}

function makeSeedRecipe(input: BoardSnapshotInput) {
  return JSON.stringify({
    version: 4,
    mode: input.mode,
    boardKind: boardKindFor(input),
    nickname: input.nickname,
    title: boardTitleFor(input),
    description: boardDescriptionFor(input),
    clientSessionId: input.clientBoardSessionId,
    freePosition: input.freePosition,
    cellIds: input.cellIds,
    missionSnapshots: input.missionSnapshots ?? [],
    missionCatalogVersion: MISSION_CATALOG_VERSION,
  })
}

function defaultMissionSnapshot(cellId: string): MissionSnapshot {
  return {
    id: cellId,
    category: 'special',
    label: cellId,
    icon: null,
    variant: 'rAdyJ',
  }
}

function boardCellSnapshotPayload(
  boardId: string,
  position: number,
  cellId: string,
  missionSnapshot?: MissionSnapshot,
) {
  const mission = missionSnapshot ?? null

  return {
    board_id: boardId,
    position,
    cell_id: cellId,
    mission_label: mission?.label ?? null,
    mission_capture_label: mission?.captureLabel ?? mission?.label ?? null,
    mission_category: mission?.category ?? null,
    mission_caption: mission?.caption ?? null,
    mission_hint: mission?.hint ?? null,
    mission_icon: mission?.icon ?? null,
    mission_snapshot: mission,
    mission_catalog_version: MISSION_CATALOG_VERSION,
  }
}

function boardUpdatedAt(board: BoardRow) {
  return board.updated_at ?? board.created_at
}

function validateBoardSnapshotInput(input: BoardSnapshotInput) {
  if (input.mode !== SUPPORTED_BOARD_MODE) {
    throw domainBadRequest(
      'BOARD_MODE_UNSUPPORTED',
      'Only 3x3 boards are supported.',
    )
  }
  const boardSize = boardSizeForMode(input.mode)
  const requiresMissionSnapshots = boardKindFor(input) === 'mission'

  if (input.cellIds.length !== boardSize) {
    throw new BadRequestException(
      `${input.mode} board must contain exactly ${boardSize} cells.`,
    )
  }

  if (input.freePosition >= boardSize) {
    throw new BadRequestException('freePosition is outside the board.')
  }

  if (requiresMissionSnapshots && !input.missionSnapshots?.length) {
    throw new BadRequestException(
      'Mission boards require complete mission snapshots.',
    )
  }

  if (input.missionSnapshots?.length) {
    if (input.missionSnapshots.length !== boardSize) {
      throw new BadRequestException(
        'missionSnapshots length must match the board size.',
      )
    }

    input.missionSnapshots.forEach((snapshot, position) => {
      if (snapshot.id !== input.cellIds[position]) {
        throw new BadRequestException(
          'Mission snapshot id must match the cell id at the same position.',
        )
      }
    })
  }
}

function validateBoardMediaCell(params: {
  board: Pick<BoardRow, 'mode' | 'cell_ids' | 'free_position'>
  position: number
  cellId: string
}) {
  if (params.board.mode !== SUPPORTED_BOARD_MODE) {
    throw domainBadRequest(
      'BOARD_MODE_UNSUPPORTED',
      'Only 3x3 boards are supported.',
    )
  }
  const boardSize = boardSizeForMode(params.board.mode)
  const cellIds = params.board.cell_ids ?? []

  if (cellIds.length !== boardSize) {
    throw new BadRequestException('Board snapshot is incomplete.')
  }

  if (params.position >= boardSize || params.position < 0) {
    throw new BadRequestException('Position is outside the board.')
  }

  if (cellIds[params.position] !== params.cellId) {
    throw new BadRequestException('cellId must match the board position.')
  }
}

function isRestorableBoardMode(mode: BoardMode | undefined): mode is '3x3' {
  return mode === SUPPORTED_BOARD_MODE
}

export interface BoardCompletionSummary {
  completedAt: string | null
  completedCount: number
  totalTargetCount: number
  isFullyCompleted: boolean
  photoCount: number
  clipCount: number
  mediaCount: number
}

function isValidBoardPosition(position: number, boardSize: number) {
  return Number.isInteger(position) && position >= 0 && position < boardSize
}

function isValidBoardCell(
  board: BoardRow,
  cell: BoardCellRow,
  boardSize: number,
) {
  if (!isValidBoardPosition(cell.position, boardSize)) return false
  return board.cell_ids?.[cell.position] === cell.cell_id
}

function hasCompletionTypeEvidence(
  cell: BoardCellRow,
  isFreePosition: boolean,
) {
  if (!cell.completion_type || !COMPLETION_TYPES.has(cell.completion_type)) {
    return false
  }

  return cell.completion_type !== 'free' || isFreePosition
}

function hasCellCompletionEvidence(
  cell: BoardCellRow,
  isFreePosition: boolean,
) {
  return Boolean(
    cell.photo_id ||
    cell.clip_id ||
    cell.marked_at ||
    cell.completed_at ||
    hasCompletionTypeEvidence(cell, isFreePosition),
  )
}

export function summarizeBoardCompletion(
  board: BoardRow,
  cells: readonly BoardCellRow[],
): BoardCompletionSummary {
  const boardSize = boardSizeForMode(board.mode)
  const completedPositions = new Set<number>()
  let photoCount = 0
  let clipCount = 0

  const hasValidCellSnapshot = board.cell_ids?.length === boardSize
  const freePosition = board.free_position
  const hasValidFreePosition =
    typeof freePosition === 'number' &&
    isValidBoardPosition(freePosition, boardSize)

  if (hasValidCellSnapshot && hasValidFreePosition) {
    completedPositions.add(freePosition)
  }

  for (const cell of cells) {
    if (!hasValidCellSnapshot || !isValidBoardCell(board, cell, boardSize)) {
      continue
    }

    const isFreePosition = cell.position === board.free_position
    if (cell.photo_id) photoCount += 1
    if (cell.clip_id) clipCount += 1
    if (hasCellCompletionEvidence(cell, isFreePosition)) {
      completedPositions.add(cell.position)
    }
  }

  const completedCount = completedPositions.size

  return {
    completedAt: board.ended_at ?? null,
    completedCount,
    totalTargetCount: boardSize,
    isFullyCompleted:
      hasValidCellSnapshot &&
      hasValidFreePosition &&
      completedCount === boardSize,
    photoCount,
    clipCount,
    mediaCount: photoCount + clipCount,
  }
}

function countNonFreeCompletedCells(
  board: BoardRow,
  cells: readonly BoardCellRow[],
) {
  const boardSize = boardSizeForMode(board.mode)
  const hasValidCellSnapshot = board.cell_ids?.length === boardSize
  if (!hasValidCellSnapshot) return 0

  return cells.filter(
    (cell) =>
      cell.position !== board.free_position &&
      isValidBoardCell(board, cell, boardSize) &&
      hasCellCompletionEvidence(cell, false),
  ).length
}

export interface BoardCustomization {
  editedCellCount: number
  customizationStatus: BoardCustomizationStatus
  badgeEligible: boolean
}

function computeBoardCustomization(
  board: BoardRow,
  cells: readonly BoardCellRow[],
): BoardCustomization {
  const editedCellCount = cells.filter(
    (cell) => cell.original_mission_snapshot != null,
  ).length

  const customizationStatus: BoardCustomizationStatus =
    editedCellCount > 0
      ? 'edited'
      : board.customization_status === 'edited' ||
          boardKindFor(board) === 'custom'
        ? 'edited'
        : 'official'

  const summary = summarizeBoardCompletion(board, cells)
  const badgeEligible =
    boardKindFor(board) === 'mission' &&
    editedCellCount === 0 &&
    summary.isFullyCompleted

  return { editedCellCount, customizationStatus, badgeEligible }
}

function boardHistoryStatus(board: BoardRow): BoardHistoryStatus {
  return board.ended_at ? 'completed' : 'active'
}

function hasCompleteCompletionSnapshot(
  board: BoardRow,
  cells: readonly BoardCellRow[],
) {
  const boardSize = boardSizeForMode(board.mode)

  if (
    !board.client_session_id ||
    !board.cell_ids ||
    board.cell_ids.length !== boardSize ||
    typeof board.free_position !== 'number' ||
    !isValidBoardPosition(board.free_position, boardSize)
  ) {
    return false
  }

  if (boardKindFor(board) !== 'mission') return true

  const cellsByPosition = new Map(cells.map((cell) => [cell.position, cell]))

  return board.cell_ids.every((cellId, position) => {
    const cell = cellsByPosition.get(position)
    return Boolean(
      cell &&
      cell.cell_id === cellId &&
      isValidBoardPosition(cell.position, boardSize) &&
      cell.mission_snapshot,
    )
  })
}

function toHistoryItem(
  board: BoardRow,
  cells: readonly BoardCellRow[],
  badgeCount = 0,
  streakCount = 0,
) {
  const summary = summarizeBoardCompletion(board, cells)
  const customization = computeBoardCustomization(board, cells)
  const dailyDate = boardDailyDate(board)

  return {
    id: board.id,
    sessionId: board.client_session_id,
    status: boardHistoryStatus(board),
    mode: board.mode,
    boardKind: boardKindFor(board),
    dailyDate,
    rerollCount: boardRerollCount(board),
    rerollLimit: DAILY_REROLL_LIMIT,
    rerollsRemaining: Math.max(0, DAILY_REROLL_LIMIT - boardRerollCount(board)),
    endReason: board.end_reason ?? null,
    streakCount,
    completedCells: summary.completedCount,
    nickname: board.nickname ?? '산책',
    title: boardTitleFor(board),
    description: boardDescriptionFor(board),
    createdAt: board.created_at,
    updatedAt: boardUpdatedAt(board),
    endedAt: board.ended_at,
    thumbnailUrls: [],
    ...summary,
    customizationStatus: customization.customizationStatus,
    editedCellCount: customization.editedCellCount,
    badgeEligible: customization.badgeEligible,
    badgeCount,
    earnedBadgeCount: badgeCount,
  }
}

function representativeMediaCell(cells: readonly BoardCellRow[]) {
  const sorted = [...cells].sort(
    (left, right) => left.position - right.position,
  )
  return (
    sorted.find((cell) => Boolean(cell.clip_id)) ??
    sorted.find((cell) => Boolean(cell.photo_id)) ??
    null
  )
}

function toBoardCompletionCloseResponse(
  board: BoardRow,
  cells: readonly BoardCellRow[],
  badgeInfo: { badgeCount: number; earnedBadges: EarnedBadge[] },
  streakCount = 0,
) {
  const summary = summarizeBoardCompletion(board, cells)
  const customization = computeBoardCustomization(board, cells)

  return {
    id: board.id,
    title: boardTitleFor(board),
    dailyDate: boardDailyDate(board),
    endedAt: board.ended_at,
    endReason: board.end_reason ?? null,
    rerollCount: boardRerollCount(board),
    rerollLimit: DAILY_REROLL_LIMIT,
    rerollsRemaining: Math.max(0, DAILY_REROLL_LIMIT - boardRerollCount(board)),
    streakCount,
    completedCells: summary.completedCount,
    ...summary,
    customizationStatus: customization.customizationStatus,
    editedCellCount: customization.editedCellCount,
    badgeEligible: customization.badgeEligible,
    badgeCount: badgeInfo.badgeCount,
    earnedBadges: badgeInfo.earnedBadges,
  }
}

function missionWithCaptureFallback(
  snapshot: MissionSnapshot,
): MissionSnapshot {
  return {
    ...snapshot,
    captureLabel: snapshot.captureLabel ?? snapshot.label,
  }
}

function detailCellMission(board: BoardRow, row: BoardCellRow) {
  if (row.mission_snapshot) return row.mission_snapshot
  if (boardKindFor(board) === 'custom')
    return defaultMissionSnapshot(row.cell_id)
  return null
}

function detailCellFromRow(
  board: BoardRow,
  row: BoardCellRow,
  photo: unknown,
  clip: unknown,
) {
  const isFreePosition = row.position === board.free_position

  return {
    position: row.position,
    cellId: row.cell_id,
    mission: detailCellMission(board, row),
    markedAt: row.marked_at,
    completedAt: isFreePosition
      ? (row.completed_at ?? board.ended_at ?? boardUpdatedAt(board))
      : (row.completed_at ?? null),
    completionType: isFreePosition ? 'free' : (row.completion_type ?? null),
    photo,
    clip,
  }
}

@Injectable()
export class BoardsService {
  constructor(
    private readonly r2: R2Service,
    private readonly supabase: SupabaseService,
    private readonly badges: BadgesService,
    private readonly clock: ClockService = new ClockService(),
    private readonly streakService?: StreakService,
  ) {}

  private get admin(): any {
    return this.supabase.adminClient
  }

  private dailyBingoEnabled() {
    return dailyBingoEnabled()
  }

  private now() {
    return this.clock.now()
  }

  private async getLatestOpenBoard(userId: string) {
    const { data, error } = await this.admin
      .from('boards')
      .select(BOARD_HISTORY_SELECT)
      .eq('user_id', userId)
      .eq('mode', SUPPORTED_BOARD_MODE)
      .is('ended_at', null)
      .is('deleted_at', null)
      .not('client_session_id', 'is', null)
      .not('cell_ids', 'is', null)
      .order('updated_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (error) throw error
    return data as BoardRow | null
  }

  private async getTodayBoard(userId: string, dailyDate: string) {
    const { data, error } = await this.admin
      .from('boards')
      .select('id')
      .eq('user_id', userId)
      .eq('daily_date', dailyDate)
      .eq('mode', SUPPORTED_BOARD_MODE)
      .is('deleted_at', null)
      .not('client_session_id', 'is', null)
      .limit(1)
      .maybeSingle()

    if (error) throw error
    return data as BoardIdRow | null
  }

  private async enforceDailyCreateGuard(userId: string) {
    const now = this.now()
    const today = kstDateOf(now)
    const latestOpen = await this.getLatestOpenBoard(userId)

    if (latestOpen) {
      const latestDailyDate = boardDailyDate(latestOpen)
      const lifecycle = computeLifecycle(latestDailyDate, now)

      if (lifecycle.state === 'expired') {
        await this.closeExpiredBoard(userId, latestOpen)
      } else if (latestDailyDate === today) {
        throw domainConflict(
          'DAILY_BOARD_EXISTS',
          'A board already exists for today.',
        )
      } else if (lifecycle.state === 'grace') {
        throw domainConflict(
          'PENDING_PREVIOUS_BOARD',
          'The previous daily board is still in its grace window.',
        )
      }
    }

    if (await this.getTodayBoard(userId, today)) {
      throw domainConflict(
        'DAILY_BOARD_EXISTS',
        'A board already exists for today.',
      )
    }

    return today
  }

  private async canStartToday(userId: string) {
    if (!this.dailyBingoEnabled()) return true

    const now = this.now()
    const today = kstDateOf(now)
    if (await this.getTodayBoard(userId, today)) return false

    const latestOpen = await this.getLatestOpenBoard(userId)
    if (!latestOpen) return true

    const lifecycle = computeLifecycle(boardDailyDate(latestOpen), now)
    return lifecycle.state === 'expired'
  }

  private async closeExpiredBoard(userId: string, board: BoardRow) {
    const cells = await this.getBoardCellsForBoard(board.id)
    const summary = summarizeBoardCompletion(board, cells)
    const userCompletedCells = countNonFreeCompletedCells(board, cells)
    const now = this.now().toISOString()

    if (userCompletedCells === 0) {
      const { error } = await this.admin
        .from('boards')
        .update({ deleted_at: now, updated_at: now })
        .eq('id', board.id)
        .eq('user_id', userId)
        .is('ended_at', null)
        .is('deleted_at', null)

      if (error) throw error
      console.info(
        JSON.stringify({
          event: 'daily_bingo_lazy_expire',
          boardId: board.id,
          endReason: null,
          completedCells: 0,
        }),
      )
      return null
    }

    const { data, error } = await this.admin
      .from('boards')
      .update({
        ended_at: now,
        updated_at: now,
        end_reason: 'auto_grace_expired',
      })
      .eq('id', board.id)
      .eq('user_id', userId)
      .is('ended_at', null)
      .is('deleted_at', null)
      .select(BOARD_HISTORY_SELECT)
      .maybeSingle()

    if (error) throw error
    const updated = (data as BoardRow | null) ?? {
      ...board,
      ended_at: now,
      updated_at: now,
      end_reason: 'auto_grace_expired' as const,
    }
    console.info(
      JSON.stringify({
        event: 'daily_bingo_lazy_expire',
        boardId: board.id,
        endReason: 'auto_grace_expired',
        completedCells: summary.completedCount,
      }),
    )
    return this.lastResultFromBoard(userId, updated, cells)
  }

  private async lastResultFromBoard(
    userId: string,
    board: BoardRow,
    cells: readonly BoardCellRow[],
  ): Promise<LastBoardResult> {
    const summary = summarizeBoardCompletion(board, cells)
    const dailyDate = boardDailyDate(board)
    const endReason = board.end_reason ?? null

    return {
      boardId: board.id,
      endReason,
      completedCells: summary.completedCount,
      dailyDate,
      streakCount:
        endReason === 'completed'
          ? await this.computeStreakEndingAt(userId, dailyDate)
          : 0,
    }
  }

  private async getLastBoardResult(
    userId: string,
  ): Promise<LastBoardResult | null> {
    const { data, error } = await this.admin
      .from('boards')
      .select(BOARD_HISTORY_SELECT)
      .eq('user_id', userId)
      .eq('mode', SUPPORTED_BOARD_MODE)
      .is('deleted_at', null)
      .not('ended_at', 'is', null)
      .not('client_session_id', 'is', null)
      .order('ended_at', { ascending: false })
      .order('updated_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (error) throw error
    const board = data as BoardRow | null
    if (!board) return null

    const cells = await this.getBoardCellsForBoard(board.id)
    return this.lastResultFromBoard(userId, board, cells)
  }

  private async deleteMalformedOpenBoard(userId: string, boardId: string) {
    const now = this.now().toISOString()
    const { error } = await this.admin
      .from('boards')
      .update({ deleted_at: now, updated_at: now })
      .eq('id', boardId)
      .eq('user_id', userId)
      .is('ended_at', null)
      .is('deleted_at', null)

    if (error) throw error
  }

  private async computeStreakEndingAt(userId: string, dailyDate: string) {
    // When wired via DI, streaks derive from personal boards UNION the group
    // completion ledger (StreakService). The inline personal-only path below
    // is the pre-group behavior, kept for direct construction without the
    // service — solo results are identical either way (golden-tested).
    if (this.streakService) {
      return this.streakService.computeStreakEndingAt(userId, dailyDate)
    }

    const { data, error } = await this.admin
      .from('boards')
      .select('daily_date')
      .eq('user_id', userId)
      .eq('mode', SUPPORTED_BOARD_MODE)
      .eq('end_reason', 'completed')
      .is('deleted_at', null)
      .not('daily_date', 'is', null)
      .lte('daily_date', dailyDate)
      .order('daily_date', { ascending: false })
      .limit(370)

    if (error) throw error

    let expected = dailyDate
    let streak = 0
    for (const row of (data ?? []) as { daily_date: string | null }[]) {
      if (row.daily_date !== expected) break
      streak += 1
      expected = previousKstDate(expected)
    }

    return streak
  }

  async ensureUserBoard(userId: string, input: BoardSnapshotInput) {
    validateBoardSnapshotInput(input)
    const now = this.now().toISOString()
    const existingResult = await this.admin
      .from('boards')
      .select('id')
      .eq('user_id', userId)
      .eq('client_session_id', input.clientBoardSessionId)
      .is('deleted_at', null)
      .maybeSingle()
    const existing = existingResult.data as BoardIdRow | null
    const selectError = existingResult.error

    if (selectError) throw selectError

    if (existing) {
      const { error: updateError } = await this.admin
        .from('boards')
        .update({
          nickname: input.nickname,
          board_kind: boardKindFor(input),
          title: boardTitleFor(input),
          description: boardDescriptionFor(input) ?? null,
          free_position: input.freePosition,
          cell_ids: input.cellIds,
          seed_recipe: makeSeedRecipe(input),
          updated_at: now,
        })
        .eq('id', existing.id)

      if (updateError) throw updateError
      await this.upsertBoardCellSnapshots(existing.id, input)
      return existing.id
    }

    const dailyDate = this.dailyBingoEnabled()
      ? await this.enforceDailyCreateGuard(userId)
      : null

    const insertResult = await this.admin
      .from('boards')
      .insert({
        user_id: userId,
        mode: input.mode,
        board_kind: boardKindFor(input),
        nickname: input.nickname,
        title: boardTitleFor(input),
        description: boardDescriptionFor(input) ?? null,
        client_session_id: input.clientBoardSessionId,
        free_position: input.freePosition,
        cell_ids: input.cellIds,
        seed_recipe: makeSeedRecipe(input),
        daily_date: dailyDate,
        reroll_count: 0,
        updated_at: now,
      })
      .select('id')
      .single()
    const inserted = insertResult.data as BoardIdRow | null
    const insertError = insertResult.error

    if (insertError) {
      if (insertError.code === '23505') {
        if (isDailyUniqueConflict(insertError)) {
          throw domainConflict(
            'DAILY_BOARD_EXISTS',
            'A board already exists for today.',
          )
        }

        const racedResult = await this.admin
          .from('boards')
          .select('id')
          .eq('user_id', userId)
          .eq('client_session_id', input.clientBoardSessionId)
          .maybeSingle()
        const racedExisting = racedResult.data as BoardIdRow | null
        const racedSelectError = racedResult.error

        if (racedSelectError) throw racedSelectError
        if (racedExisting) {
          await this.upsertBoardCellSnapshots(racedExisting.id, input)
          return racedExisting.id
        }
      }
      throw insertError
    }

    if (!inserted) throw new Error('Board insert did not return an id.')
    await this.upsertBoardCellSnapshots(inserted.id, input)
    await this.deleteOtherActiveUserBoards(
      userId,
      input.clientBoardSessionId,
      dailyDate,
    )
    return inserted.id
  }

  async ensureUserBoardForMedia(
    userId: string,
    input: {
      clientBoardSessionId: string
      mode: BoardMode
      position: number
      cellId: string
    },
  ) {
    const { data, error } = await this.admin
      .from('boards')
      .select('id, user_id, mode, cell_ids, free_position')
      .eq('user_id', userId)
      .eq('client_session_id', input.clientBoardSessionId)
      .is('deleted_at', null)
      .maybeSingle()

    if (error) throw error
    const board = data as BoardRow | null

    if (!board) {
      throw new BadRequestException(
        'Board session must be saved before media upload.',
      )
    }

    if (board.mode !== input.mode) {
      throw new BadRequestException('Board mode does not match the session.')
    }

    validateBoardMediaCell({
      board,
      position: input.position,
      cellId: input.cellId,
    })

    return board.id
  }

  async touchUserBoard(boardId: string) {
    const { error } = await this.admin
      .from('boards')
      .update({ updated_at: this.now().toISOString() })
      .eq('id', boardId)

    if (error) throw error
  }

  async ensureUserBoardFromSession(userId: string, session: BoardSessionInput) {
    const boardId = await this.ensureUserBoard(userId, {
      clientBoardSessionId: session.sessionId,
      mode: session.mode,
      boardKind: session.version === 4 ? session.boardKind : 'custom',
      nickname: session.nickname,
      title: session.version === 4 ? session.title : session.nickname,
      description: session.version === 4 ? session.description : undefined,
      freePosition: session.freePosition,
      cellIds: session.cellIds,
      missionSnapshots: session.version === 4 ? session.missionSnapshots : [],
    })

    await this.syncUserBoardMarkedPositions(boardId, session)
    return { boardId }
  }

  async upsertBoardCellSnapshots(
    boardId: string,
    input: Pick<BoardSnapshotInput, 'cellIds' | 'missionSnapshots'>,
  ) {
    const snapshotsById = new Map(
      (input.missionSnapshots ?? []).map((snapshot) => [
        snapshot.id,
        snapshot as MissionSnapshot,
      ]),
    )
    const rows = input.cellIds.map((cellId, position) =>
      boardCellSnapshotPayload(
        boardId,
        position,
        cellId,
        snapshotsById.get(cellId),
      ),
    )
    if (rows.length === 0) return

    const { error } = await this.admin
      .from('board_cells')
      .upsert(rows, { onConflict: 'board_id,position' })

    if (error) throw error
  }

  async listUserBoards(
    userId: string,
    options: BoardListQueryInput = {
      status: 'all',
      limit: 50,
      includePreview: false,
    },
  ) {
    let query = this.admin
      .from('boards')
      .select(BOARD_HISTORY_SELECT)
      .eq('user_id', userId)
      .eq('mode', SUPPORTED_BOARD_MODE)
      .is('deleted_at', null)
      .not('client_session_id', 'is', null)

    if (options.status === 'completed') {
      query = query
        .not('ended_at', 'is', null)
        .order('ended_at', { ascending: false })
        .order('updated_at', { ascending: false })
    } else {
      if (options.status === 'active') {
        query = query.is('ended_at', null)
      }
      query = query.order('updated_at', { ascending: false })
    }

    const { data: boards, error: boardError } = await query.limit(options.limit)

    if (boardError) throw boardError
    if (!boards?.length) return []

    const boardRows = boards as BoardRow[]
    const cells = await this.getBoardCellsForBoards(
      boardRows.map((board) => board.id),
    )
    const cellsByBoard = new Map<string, BoardCellRow[]>()

    cells.forEach((cell) => {
      const list = cellsByBoard.get(cell.board_id) ?? []
      list.push(cell)
      cellsByBoard.set(cell.board_id, list)
    })

    const badgesByBoard = await this.badges.getBoardBadges(
      userId,
      boardRows.map((board) => board.id),
    )

    const entries = boardRows
      .map((board) => {
        const boardCells = cellsByBoard.get(board.id) ?? []
        const badgeCount = badgesByBoard.get(board.id)?.length ?? 0
        return {
          board,
          cells: boardCells,
          item: toHistoryItem(board, boardCells, badgeCount),
        }
      })
      .filter(({ board, cells, item }) => {
        if (options.status !== 'completed') return true
        return (
          Boolean(board.ended_at) &&
          hasCompleteCompletionSnapshot(board, cells) &&
          item.isFullyCompleted
        )
      })
    if (!options.includePreview) {
      return entries.map(({ item }) => item)
    }

    const previews = await this.createHistoryMediaPreviews(userId, entries)
    return entries.map(({ item }) => ({
      ...item,
      mediaPreview: previews.get(item.id) ?? null,
    }))
  }

  async getUserBoardDetail(userId: string, boardId: string) {
    const board = await this.getBoardForUser(userId, boardId)

    if (
      !board ||
      !board.client_session_id ||
      !board.cell_ids ||
      board.free_position === null
    ) {
      return null
    }

    let cells = await this.getBoardCellsForBoard(board.id)

    if (!cells.length) {
      if (boardKindFor(board) === 'mission') return null

      await this.upsertBoardCellSnapshots(board.id, {
        cellIds: board.cell_ids,
        missionSnapshots: [],
      })
      cells = await this.getBoardCellsForBoard(board.id)
    }

    if (!hasCompleteCompletionSnapshot(board, cells)) {
      return null
    }

    const photosById = new Map<string, PhotoRow>()
    const clipsById = new Map<string, ClipRow>()
    const photoIds = cells
      .map((cell) => cell.photo_id)
      .filter((photoId): photoId is string => Boolean(photoId))
    const clipIds = cells
      .map((cell) => cell.clip_id)
      .filter((clipId): clipId is string => Boolean(clipId))

    if (photoIds.length) {
      const photos = await this.getHistoryPhotos(userId, photoIds)
      photos.forEach((photo) => photosById.set(photo.id, photo))
    }

    if (clipIds.length) {
      const clips = await this.getHistoryClips(userId, clipIds)
      clips.forEach((clip) => clipsById.set(clip.id, clip))
    }

    const badgesByBoard = await this.badges.getBoardBadges(userId, [board.id])
    const boardBadges = badgesByBoard.get(board.id) ?? []
    const customization = computeBoardCustomization(board, cells)
    const badgeByMissionId = new Map<string, BoardBadgeWithCatalog>()
    boardBadges.forEach((badge) => {
      badgeByMissionId.set(badge.missionId, badge)
    })

    const detailCells = await Promise.all(
      cells.map(async (cell) => {
        const photoPromise = (async () => {
          if (!cell.photo_id) return null
          const row = photosById.get(cell.photo_id)
          if (!row) return null

          return {
            photoId: row.id,
            uploadedAt: row.uploaded_at,
            capturedAt: row.captured_at ?? row.uploaded_at,
            ...(await this.createPhotoPreviewUrl(row.storage_path, row)),
          }
        })()

        const clipPromise = (async () => {
          if (!cell.clip_id) return null
          const row = clipsById.get(cell.clip_id)
          if (!row?.poster_storage_path) return null

          return {
            clipId: row.id,
            uploadedAt: row.uploaded_at,
            recordedAt: row.recorded_at ?? row.uploaded_at,
            durationMs: row.duration_ms,
            description: row.description ?? undefined,
            ...(await this.createClipPreviewUrls(
              row.storage_path,
              row.poster_storage_path,
              row,
            )),
          }
        })()

        const [photo, clip] = await Promise.all([photoPromise, clipPromise])
        const isEdited = cell.original_mission_snapshot != null
        const isFreePosition = cell.position === board.free_position
        const missionId = cell.mission_snapshot?.id
        const badge =
          customization.badgeEligible && !isFreePosition && missionId
            ? (badgeByMissionId.get(missionId) ?? null)
            : null

        return {
          ...detailCellFromRow(board, cell, photo, clip),
          isEdited,
          badge,
        }
      }),
    )
    const item = toHistoryItem(board, cells, boardBadges.length)

    return {
      ...item,
      sessionId: board.client_session_id,
      freePosition: board.free_position,
      cellIds: board.cell_ids,
      cells: detailCells,
    }
  }

  async markUserBoardCell(params: {
    userId: string
    boardId: string
    position: number
    cellId: string
    marked: boolean
  }) {
    const completedAt = params.marked ? this.now().toISOString() : null
    const { data: board, error: boardError } = await this.admin
      .from('boards')
      .select('id')
      .eq('id', params.boardId)
      .eq('user_id', params.userId)
      .maybeSingle()

    if (boardError) throw boardError
    if (!board) return false

    const { error } = await this.admin
      .from('board_cells')
      .update({
        cell_id: params.cellId,
        photo_id: null,
        clip_id: null,
        marked_at: completedAt,
        completed_at: completedAt,
        completion_type: params.marked ? 'no_media' : null,
      })
      .eq('board_id', params.boardId)
      .eq('position', params.position)
      .eq('cell_id', params.cellId)

    if (error) throw error

    const { error: updateError } = await this.admin
      .from('boards')
      .update({ updated_at: this.now().toISOString() })
      .eq('id', params.boardId)
      .eq('user_id', params.userId)
    if (updateError) throw updateError

    return true
  }

  async replaceUserBoardCell(params: {
    userId: string
    boardId: string
    position: number
    cellId: string
  }) {
    const { data: board, error: boardError } = await this.admin
      .from('boards')
      .select('id')
      .eq('id', params.boardId)
      .eq('user_id', params.userId)
      .maybeSingle()

    if (boardError) throw boardError
    if (!board) return false

    const { error } = await this.admin.from('board_cells').upsert(
      {
        ...boardCellSnapshotPayload(
          params.boardId,
          params.position,
          params.cellId,
        ),
        photo_id: null,
        clip_id: null,
        marked_at: null,
        completed_at: null,
        completion_type: null,
      },
      { onConflict: 'board_id,position' },
    )

    if (error) throw error

    const { error: updateError } = await this.admin
      .from('boards')
      .update({ updated_at: this.now().toISOString() })
      .eq('id', params.boardId)
      .eq('user_id', params.userId)
    if (updateError) throw updateError

    return true
  }

  async ackBoardReroll(userId: string, boardId: string) {
    const { data, error } = await this.admin.rpc('reroll_board', {
      p_board_id: boardId,
      p_user_id: userId,
      p_limit: DAILY_REROLL_LIMIT,
    })

    if (error) throw error
    const row = Array.isArray(data) ? data[0] : data
    const rerollCount = row?.reroll_count

    if (typeof rerollCount !== 'number') {
      throw domainConflict('REROLL_LIMIT_EXCEEDED', 'Reroll limit exceeded.')
    }

    return {
      rerollCount,
      rerollLimit: DAILY_REROLL_LIMIT,
      rerollsRemaining: Math.max(0, DAILY_REROLL_LIMIT - rerollCount),
    }
  }

  async endUserBoard(userId: string, boardId: string, input?: EndBoardInput) {
    let board = await this.getBoardForUser(userId, boardId)
    if (!board) throw new NotFoundException('Board not found.')

    let cells = await this.getBoardCellsForBoard(board.id)
    if (!cells.length && boardKindFor(board) === 'custom' && board.cell_ids) {
      await this.upsertBoardCellSnapshots(board.id, {
        cellIds: board.cell_ids,
        missionSnapshots: [],
      })
      cells = await this.getBoardCellsForBoard(board.id)
    }

    if (!hasCompleteCompletionSnapshot(board, cells)) {
      throw new BadRequestException('Board snapshot is incomplete.')
    }

    const summary = summarizeBoardCompletion(board, cells)
    if (!summary.isFullyCompleted) {
      throw new BadRequestException('Board is not fully completed.')
    }

    if (input?.title) {
      board = await this.applyBoardTitle(userId, board, input.title)
    }

    if (board.ended_at) {
      return this.resolveAlreadyEndedClose(userId, board, cells)
    }

    const now = this.now().toISOString()
    const { data, error } = await this.admin
      .from('boards')
      .update({ ended_at: now, updated_at: now, end_reason: 'completed' })
      .eq('id', boardId)
      .eq('user_id', userId)
      .is('ended_at', null)
      .select(BOARD_HISTORY_SELECT)
      .maybeSingle()

    if (error) throw error
    const updated = data as BoardRow | null
    if (updated) {
      return this.resolveFreshClose(userId, updated, cells)
    }

    const raced = await this.getBoardForUser(userId, boardId)
    if (raced?.ended_at) {
      return this.resolveAlreadyEndedClose(userId, raced, cells)
    }

    throw new NotFoundException('Board not found.')
  }

  private async applyBoardTitle(
    userId: string,
    board: BoardRow,
    title: string,
  ): Promise<BoardRow> {
    const { data, error } = await this.admin
      .from('boards')
      .update({ title, updated_at: this.now().toISOString() })
      .eq('id', board.id)
      .eq('user_id', userId)
      .select(BOARD_HISTORY_SELECT)
      .maybeSingle()

    if (error) throw error
    return (data as BoardRow | null) ?? { ...board, title }
  }

  private async resolveFreshClose(
    userId: string,
    board: BoardRow,
    cells: readonly BoardCellRow[],
  ) {
    const customization = computeBoardCustomization(board, cells)
    const streakCount = await this.computeStreakEndingAt(
      userId,
      boardDailyDate(board),
    )

    if (!customization.badgeEligible) {
      return toBoardCompletionCloseResponse(
        board,
        cells,
        {
          badgeCount: 0,
          earnedBadges: [],
        },
        streakCount,
      )
    }

    const awarded = await this.badges.awardBoardBadges({
      userId,
      board,
      cells,
    })

    return toBoardCompletionCloseResponse(
      board,
      cells,
      {
        badgeCount: awarded.badgeCount,
        earnedBadges: awarded.earnedBadges,
      },
      streakCount,
    )
  }

  private async resolveAlreadyEndedClose(
    userId: string,
    board: BoardRow,
    cells: readonly BoardCellRow[],
  ) {
    const customization = computeBoardCustomization(board, cells)
    const streakCount =
      board.end_reason === 'completed'
        ? await this.computeStreakEndingAt(userId, boardDailyDate(board))
        : 0

    if (!customization.badgeEligible) {
      return toBoardCompletionCloseResponse(
        board,
        cells,
        {
          badgeCount: 0,
          earnedBadges: [],
        },
        streakCount,
      )
    }

    // Self-heal: idempotently re-attempt minting (RPC on-conflict makes this
    // safe; already-minted board_badges never re-increment earned_count). Then
    // read the actual persisted badges to populate the response.
    await this.badges.awardBoardBadges({ userId, board, cells })

    const badgesByBoard = await this.badges.getBoardBadges(userId, [board.id])
    const boardBadges = badgesByBoard.get(board.id) ?? []

    return toBoardCompletionCloseResponse(
      board,
      cells,
      {
        badgeCount: boardBadges.length,
        earnedBadges: boardBadges.map((badge) => ({
          ...badge,
          isFirstEarn: false,
        })),
      },
      streakCount,
    )
  }

  async updateBoardTitle(
    userId: string,
    boardId: string,
    input: UpdateBoardTitleInput,
  ) {
    const board = await this.getBoardForUser(userId, boardId)
    if (!board) throw new NotFoundException('Board not found.')

    if (board.ended_at) {
      const cells = await this.getBoardCellsForBoard(board.id)
      const summary = summarizeBoardCompletion(board, cells)
      if (!summary.isFullyCompleted) {
        throw new ConflictException(
          'Ended boards can only be renamed when fully completed.',
        )
      }
    }

    const now = this.now().toISOString()
    const { data, error } = await this.admin
      .from('boards')
      .update({ title: input.title, updated_at: now })
      .eq('id', boardId)
      .eq('user_id', userId)
      .is('deleted_at', null)
      .select('id, title, updated_at')
      .maybeSingle()

    if (error) throw error
    const updated = data as {
      id: string
      title: string | null
      updated_at: string | null
    } | null
    if (!updated) throw new NotFoundException('Board not found.')

    return {
      id: updated.id,
      title: updated.title,
      updatedAt: updated.updated_at ?? now,
    }
  }

  async editBoardCellMission(
    userId: string,
    boardId: string,
    position: number,
    input: EditBoardCellMissionInput,
  ) {
    const board = await this.getBoardForUser(userId, boardId)
    if (!board) throw new NotFoundException('Board not found.')

    if (board.ended_at) {
      throw new ConflictException('Ended boards cannot be edited.')
    }

    if (position === board.free_position) {
      throw new ConflictException('Free cell cannot be edited.')
    }

    if (board.cell_ids?.[position] !== input.cellId) {
      throw new BadRequestException('cellId must match the board position.')
    }

    const cell = await this.getBoardCell(board.id, position)
    if (!cell) throw new NotFoundException('Board cell not found.')

    if (
      cell.photo_id ||
      cell.clip_id ||
      cell.marked_at ||
      cell.completed_at ||
      cell.completion_type
    ) {
      throw new ConflictException('Completed cells cannot be edited.')
    }

    const baseSnapshot: MissionSnapshot =
      cell.mission_snapshot ?? defaultMissionSnapshot(cell.cell_id)

    const mergedSnapshot: MissionSnapshot = {
      ...baseSnapshot,
      label: input.title,
      ...(input.description !== undefined ? { hint: input.description } : {}),
      ...(input.captureLabel !== undefined
        ? { captureLabel: input.captureLabel }
        : {}),
    }

    const parsed = missionSnapshotSchema.safeParse(mergedSnapshot)
    if (!parsed.success) {
      throw new BadRequestException('Invalid mission edit.')
    }
    const validatedSnapshot = parsed.data as MissionSnapshot

    const now = this.now().toISOString()
    const update: Record<string, unknown> = {
      mission_snapshot: validatedSnapshot,
      mission_label: input.title,
      edited_at: now,
    }
    if (input.description !== undefined) {
      update.mission_hint = input.description
    }
    if (input.captureLabel !== undefined) {
      update.mission_capture_label = input.captureLabel
    }
    if (cell.original_mission_snapshot == null) {
      update.original_cell_id = cell.cell_id
      update.original_mission_snapshot = cell.mission_snapshot ?? baseSnapshot
    }

    const { error: cellError } = await this.admin
      .from('board_cells')
      .update(update)
      .eq('board_id', board.id)
      .eq('position', position)

    if (cellError) throw cellError

    const { error: boardError } = await this.admin
      .from('boards')
      .update({ customization_status: 'edited', updated_at: now })
      .eq('id', board.id)
      .eq('user_id', userId)

    if (boardError) throw boardError

    const cells = await this.getBoardCellsForBoard(board.id)
    const updatedCell = cells.find((row) => row.position === position) ?? {
      ...cell,
      mission_snapshot: validatedSnapshot,
      edited_at: now,
    }
    const customization = computeBoardCustomization(
      { ...board, customization_status: 'edited' },
      cells,
    )

    return {
      ok: true,
      board: {
        id: board.id,
        customizationStatus: customization.customizationStatus,
        editedCellCount: customization.editedCellCount,
        badgeEligible: false,
      },
      cell: {
        position,
        cellId: updatedCell.cell_id,
        editedAt: updatedCell.edited_at ?? now,
        mission: missionWithCaptureFallback(validatedSnapshot),
      },
    }
  }

  async restoreBoardCellMission(
    userId: string,
    boardId: string,
    position: number,
    input: RestoreBoardCellMissionInput,
  ) {
    const board = await this.getBoardForUser(userId, boardId)
    if (!board) throw new NotFoundException('Board not found.')

    if (board.ended_at) {
      throw new ConflictException('Ended boards cannot be edited.')
    }

    if (position === board.free_position) {
      throw new ConflictException('Free cell cannot be edited.')
    }

    const cell = await this.getBoardCell(board.id, position)
    if (!cell) throw new NotFoundException('Board cell not found.')

    if (
      cell.photo_id ||
      cell.clip_id ||
      cell.marked_at ||
      cell.completed_at ||
      cell.completion_type
    ) {
      throw new ConflictException('Completed cells cannot be edited.')
    }

    if (cell.original_mission_snapshot == null) {
      throw new ConflictException('Original mission snapshot is unavailable.')
    }

    if (
      input.cellId !== cell.cell_id &&
      input.cellId !== cell.original_cell_id
    ) {
      throw new BadRequestException('cellId must match the board position.')
    }

    const restoredSnapshot = cell.original_mission_snapshot
    const restoredCellId = cell.original_cell_id ?? cell.cell_id
    const now = this.now().toISOString()

    const { error: cellError } = await this.admin
      .from('board_cells')
      .update({
        cell_id: restoredCellId,
        mission_snapshot: restoredSnapshot,
        mission_label: restoredSnapshot.label ?? null,
        mission_hint: restoredSnapshot.hint ?? null,
        mission_capture_label: restoredSnapshot.captureLabel ?? null,
        original_cell_id: null,
        original_mission_snapshot: null,
        edited_at: null,
      })
      .eq('board_id', board.id)
      .eq('position', position)

    if (cellError) throw cellError

    const cells = await this.getBoardCellsForBoard(board.id)
    const customization = computeBoardCustomization(
      { ...board, customization_status: 'edited' },
      cells,
    )
    const nextStatus: BoardCustomizationStatus =
      customization.editedCellCount === 0 ? 'official' : 'edited'

    const { error: boardError } = await this.admin
      .from('boards')
      .update({ customization_status: nextStatus, updated_at: now })
      .eq('id', board.id)
      .eq('user_id', userId)

    if (boardError) throw boardError

    const updatedCell = cells.find((row) => row.position === position) ?? {
      ...cell,
      cell_id: restoredCellId,
      mission_snapshot: restoredSnapshot,
      edited_at: null,
    }

    return {
      ok: true,
      board: {
        id: board.id,
        customizationStatus: nextStatus,
        editedCellCount: customization.editedCellCount,
        badgeEligible: false,
      },
      cell: {
        position,
        cellId: updatedCell.cell_id,
        editedAt: updatedCell.edited_at ?? null,
        mission: missionWithCaptureFallback(restoredSnapshot),
      },
    }
  }

  async deleteUserBoard(userId: string, boardId: string) {
    const now = this.now().toISOString()
    const { data, error } = await this.admin
      .from('boards')
      .update({ deleted_at: now, updated_at: now })
      .eq('id', boardId)
      .eq('user_id', userId)
      .select('id')
      .maybeSingle()

    if (error) throw error
    return Boolean(data)
  }

  async deleteActiveUserBoards(userId: string) {
    await this.deleteActiveUserBoardsForClient(userId)
  }

  async getActiveUserBoardState(userId: string) {
    const row = await this.getLatestOpenBoard(userId)
    if (
      !row ||
      !isRestorableBoardMode(row.mode) ||
      !row.client_session_id ||
      !row.nickname ||
      typeof row.free_position !== 'number' ||
      !row.cell_ids?.length
    ) {
      if (row) {
        await this.deleteMalformedOpenBoard(userId, row.id)
      }
      return {
        session: null,
        lastResult: await this.getLastBoardResult(userId),
        canStartToday: await this.canStartToday(userId),
      }
    }

    const dailyDate = boardDailyDate(row)
    const lifecycle = computeLifecycle(dailyDate, this.now())

    if (this.dailyBingoEnabled() && lifecycle.state === 'expired') {
      const lastResult = await this.closeExpiredBoard(userId, row)
      return {
        session: null,
        lastResult: lastResult ?? (await this.getLastBoardResult(userId)),
        canStartToday: await this.canStartToday(userId),
      }
    }

    const session = await this.getBoardSessionFromRow(userId, row, lifecycle)
    if (!session) {
      await this.deleteMalformedOpenBoard(userId, row.id)
      return {
        session: null,
        lastResult: await this.getLastBoardResult(userId),
        canStartToday: await this.canStartToday(userId),
      }
    }

    return {
      session,
      lastResult: null,
      canStartToday: false,
    }
  }

  async getLatestUserBoardSession(userId: string) {
    return (await this.getActiveUserBoardState(userId)).session
  }

  private async getBoardSessionFromRow(
    userId: string,
    row: BoardRow,
    lifecycle: { state: BoardLifecycle; graceUntil: Date },
  ) {
    const cells = await this.getBoardCellsForBoard(row.id)
    const clipIds = cells
      .map((cell) => cell.clip_id)
      .filter((clipId): clipId is string => Boolean(clipId))
    const clipsById = new Map<string, ClipRow>()

    if (clipIds.length) {
      const clips = await this.getHistoryClips(userId, clipIds)
      clips.forEach((clip) => clipsById.set(clip.id, clip))
    }

    const markedPositions = new Set<number>()
    const snapshotsByPosition = new Map(
      cells
        .filter((cell) => Boolean(cell.mission_snapshot))
        .map((cell) => [
          cell.position,
          cell.mission_snapshot as MissionSnapshot,
        ]),
    )
    const boardKind = boardKindFor(row)

    cells.forEach((cell) => {
      if (cell.marked_at && !cell.clip_id) markedPositions.add(cell.position)
    })

    const clips = (
      await Promise.all(
        cells.map(async (cell) => {
          if (!cell.clip_id) return null

          const clip = clipsById.get(cell.clip_id)
          if (!clip?.poster_storage_path) return null
          const preview = await this.createClipPreviewUrls(
            clip.storage_path,
            clip.poster_storage_path,
            clip,
          )

          return {
            position: cell.position,
            cellId: cell.cell_id,
            clipId: clip.id,
            ownerKind: 'user',
            clipUrl: preview.clipUrl,
            clipUrlExpiresAt: preview.clipUrlExpiresAt,
            posterUrl: preview.posterUrl,
            posterUrlExpiresAt: preview.posterUrlExpiresAt,
            durationMs: clip.duration_ms,
            description: clip.description ?? undefined,
            uploadStatus: 'uploaded',
          }
        }),
      )
    ).filter(Boolean)

    const cellIds = row.cell_ids ?? []
    if (!cellIds.length) return null

    if (
      boardKind === 'mission' &&
      cellIds.some((_, position) => !snapshotsByPosition.get(position))
    ) {
      return null
    }

    const summary = summarizeBoardCompletion(row, cells)
    const dailyDate = boardDailyDate(row)
    const streakDate = previousKstDate(dailyDate)
    const streakCount = await this.computeStreakEndingAt(userId, streakDate)

    return {
      version: 4,
      boardId: row.id,
      sessionId: row.client_session_id,
      mode: row.mode,
      boardKind,
      nickname: row.nickname,
      title: boardTitleFor(row),
      description: boardDescriptionFor(row),
      createdAt: row.created_at ?? this.now().toISOString(),
      updatedAt: row.updated_at ?? row.created_at ?? this.now().toISOString(),
      freePosition: row.free_position,
      cellIds,
      missionSnapshots: cellIds.map((cellId, position) =>
        boardKind === 'custom'
          ? (snapshotsByPosition.get(position) ??
            defaultMissionSnapshot(cellId))
          : snapshotsByPosition.get(position),
      ),
      markedPositions: Array.from(markedPositions).sort((a, b) => a - b),
      clips,
      endedAt: null,
      lifecycle: lifecycle.state,
      dailyDate,
      graceUntil: lifecycle.graceUntil.toISOString(),
      rerollCount: boardRerollCount(row),
      rerollLimit: DAILY_REROLL_LIMIT,
      rerollsRemaining: Math.max(0, DAILY_REROLL_LIMIT - boardRerollCount(row)),
      endReason: row.end_reason ?? null,
      streakCount,
      completedCells: summary.completedCount,
    }
  }

  private async createHistoryMediaPreviews(
    userId: string,
    entries: readonly { board: BoardRow; cells: readonly BoardCellRow[] }[],
  ) {
    const representativeCells = new Map<string, BoardCellRow>()
    const clipIds: string[] = []
    const photoIds: string[] = []

    entries.forEach(({ board, cells }) => {
      const cell = representativeMediaCell(cells)
      if (!cell) return

      representativeCells.set(board.id, cell)
      if (cell.clip_id) {
        clipIds.push(cell.clip_id)
      } else if (cell.photo_id) {
        photoIds.push(cell.photo_id)
      }
    })

    const [clips, photos] = await Promise.all([
      clipIds.length ? this.getHistoryClips(userId, clipIds) : [],
      photoIds.length ? this.getHistoryPhotos(userId, photoIds) : [],
    ])
    const clipsById = new Map(clips.map((clip) => [clip.id, clip]))
    const photosById = new Map(photos.map((photo) => [photo.id, photo]))
    const previews = new Map<string, unknown>()

    await Promise.all(
      entries.map(async ({ board }) => {
        const cell = representativeCells.get(board.id)
        if (!cell) return

        try {
          if (cell.clip_id) {
            const clip = clipsById.get(cell.clip_id)
            if (!clip?.poster_storage_path) return
            const preview = await this.createClipPreviewUrls(
              clip.storage_path,
              clip.poster_storage_path,
              clip,
            )
            previews.set(board.id, {
              kind: 'clip',
              url: preview.clipUrl,
              thumbnailUrl: preview.posterUrl,
              expiresAt: preview.clipUrlExpiresAt,
              position: cell.position,
              cellId: cell.cell_id,
              durationMs: clip.duration_ms,
              clipUrl: preview.clipUrl,
              clipUrlExpiresAt: preview.clipUrlExpiresAt,
              posterUrl: preview.posterUrl,
              posterUrlExpiresAt: preview.posterUrlExpiresAt,
            })
            return
          }

          if (cell.photo_id) {
            const photo = photosById.get(cell.photo_id)
            if (!photo) return
            const preview = await this.createPhotoPreviewUrl(
              photo.storage_path,
              photo,
            )
            previews.set(board.id, {
              kind: 'photo',
              url: preview.previewUrl,
              thumbnailUrl: preview.previewUrl,
              expiresAt: preview.previewUrlExpiresAt,
              position: cell.position,
              cellId: cell.cell_id,
              previewUrl: preview.previewUrl,
              previewUrlExpiresAt: preview.previewUrlExpiresAt,
            })
          }
        } catch {
          previews.set(board.id, null)
        }
      }),
    )

    return previews
  }

  private async getBoardForUser(userId: string, boardId: string) {
    const { data, error } = await this.admin
      .from('boards')
      .select(BOARD_HISTORY_SELECT)
      .eq('id', boardId)
      .eq('user_id', userId)
      .eq('mode', SUPPORTED_BOARD_MODE)
      .is('deleted_at', null)
      .maybeSingle()

    if (error) throw error
    return data as BoardRow | null
  }

  private async getBoardCellsForBoards(boardIds: readonly string[]) {
    const { data, error } = await this.admin
      .from('board_cells')
      .select(BOARD_CELL_EXTENDED_SELECT)
      .in('board_id', boardIds)

    if (error) throw error
    return (data ?? []) as BoardCellRow[]
  }

  private async getBoardCellsForBoard(boardId: string) {
    const { data, error } = await this.admin
      .from('board_cells')
      .select(BOARD_CELL_EXTENDED_SELECT)
      .eq('board_id', boardId)
      .order('position', { ascending: true })

    if (error) throw error
    return (data ?? []) as BoardCellRow[]
  }

  private async getBoardCell(boardId: string, position: number) {
    const { data, error } = await this.admin
      .from('board_cells')
      .select(BOARD_CELL_EXTENDED_SELECT)
      .eq('board_id', boardId)
      .eq('position', position)
      .maybeSingle()

    if (error) throw error
    return data as BoardCellRow | null
  }

  private async getHistoryPhotos(userId: string, photoIds: readonly string[]) {
    const { data, error } = await this.admin
      .from('photos')
      .select(PHOTO_HISTORY_SELECT)
      .eq('user_id', userId)
      .in('id', photoIds)
      .not('uploaded_at', 'is', null)
      .is('deleted_at', null)

    if (error) throw error
    return (data ?? []) as PhotoRow[]
  }

  private async getHistoryClips(userId: string, clipIds: readonly string[]) {
    const { data, error } = await this.admin
      .from('clips')
      .select(CLIP_HISTORY_SELECT)
      .eq('user_id', userId)
      .in('id', clipIds)
      .not('uploaded_at', 'is', null)
      .is('deleted_at', null)

    if (error) throw error
    return (data ?? []) as ClipRow[]
  }

  private async createPhotoPreviewUrl(
    path: string,
    object?: { storage_provider?: string | null; bucket_name?: string | null },
  ) {
    return {
      previewUrl: await this.r2.createPreviewUrl({
        objectKey: path,
        bucketName: object?.bucket_name,
        expiresInSeconds: SIGNED_PREVIEW_EXPIRES_SECONDS,
      }),
      previewUrlExpiresAt: signedUrlExpiresAt(SIGNED_PREVIEW_EXPIRES_SECONDS),
    }
  }

  private async createClipPreviewUrls(
    clipPath: string,
    posterPath: string,
    object?: { storage_provider?: string | null; bucket_name?: string | null },
  ) {
    const [clipUrl, posterUrl] = await Promise.all([
      this.r2.createPreviewUrl({
        objectKey: clipPath,
        bucketName: object?.bucket_name,
        expiresInSeconds: SIGNED_PREVIEW_EXPIRES_SECONDS,
      }),
      this.r2.createPreviewUrl({
        objectKey: posterPath,
        bucketName: object?.bucket_name,
        expiresInSeconds: SIGNED_PREVIEW_EXPIRES_SECONDS,
      }),
    ])

    return {
      clipUrl,
      clipUrlExpiresAt: signedUrlExpiresAt(SIGNED_PREVIEW_EXPIRES_SECONDS),
      posterUrl,
      posterUrlExpiresAt: signedUrlExpiresAt(SIGNED_PREVIEW_EXPIRES_SECONDS),
    }
  }

  private async syncUserBoardMarkedPositions(
    boardId: string,
    session: BoardSessionInput,
  ) {
    if (!session.markedPositions.length) return

    const now = this.now().toISOString()
    const rows = session.markedPositions.flatMap((position) => {
      const cellId = session.cellIds[position]
      if (!cellId) return []

      return [
        {
          board_id: boardId,
          position,
          cell_id: cellId,
          marked_at: now,
          completed_at: now,
          completion_type: 'no_media',
        },
      ]
    })

    if (!rows.length) return

    const { error } = await this.admin
      .from('board_cells')
      .upsert(rows, { onConflict: 'board_id,position' })

    if (error) throw error
  }

  private async deleteActiveUserBoardsForClient(
    userId: string,
    exceptClientSessionId?: string,
  ) {
    const now = this.now().toISOString()
    let query = this.admin
      .from('boards')
      .update({ deleted_at: now, updated_at: now })
      .eq('user_id', userId)
      .eq('mode', SUPPORTED_BOARD_MODE)
      .is('ended_at', null)
      .is('deleted_at', null)
      .not('client_session_id', 'is', null)

    if (exceptClientSessionId) {
      query = query.neq('client_session_id', exceptClientSessionId)
    }

    const { error } = await query

    if (error) throw error
  }

  private async deleteOtherActiveUserBoards(
    userId: string,
    clientSessionId: string,
    dailyDate?: string | null,
  ) {
    if (!this.dailyBingoEnabled() || !dailyDate) {
      await this.deleteActiveUserBoardsForClient(userId, clientSessionId)
      return
    }

    const now = this.now().toISOString()
    const { error } = await this.admin
      .from('boards')
      .update({ deleted_at: now, updated_at: now })
      .eq('user_id', userId)
      .eq('daily_date', dailyDate)
      .is('ended_at', null)
      .is('deleted_at', null)
      .not('client_session_id', 'is', null)
      .neq('client_session_id', clientSessionId)

    if (error) throw error
  }
}
