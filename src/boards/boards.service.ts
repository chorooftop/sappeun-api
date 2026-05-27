import { Injectable } from '@nestjs/common'

import type {
  BoardSessionInput,
  BoardSnapshotInput,
} from '@/boards/boards.schemas'
import { SupabaseService } from '@/supabase/supabase.service'

interface BoardIdRow {
  id: string
}

function boardKindFor(input: BoardSnapshotInput) {
  return input.boardKind ?? 'mission'
}

function boardTitleFor(input: BoardSnapshotInput) {
  return input.title ?? input.nickname ?? '산책'
}

function boardDescriptionFor(input: BoardSnapshotInput) {
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
    missionCatalogVersion: 'api-migration-v1',
  })
}

function boardCellRows(boardId: string, input: BoardSnapshotInput) {
  const snapshotsById = new Map(
    (input.missionSnapshots ?? []).map((snapshot) => [snapshot.id, snapshot]),
  )

  return input.cellIds.map((cellId, position) => {
    const snapshot = snapshotsById.get(cellId)
    return {
      board_id: boardId,
      position,
      cell_id: cellId,
      mission_label: snapshot?.label ?? cellId,
      mission_capture_label:
        snapshot?.captureLabel ?? snapshot?.label ?? cellId,
      mission_category: snapshot?.category ?? 'special',
      mission_caption: snapshot?.caption ?? null,
      mission_hint: snapshot?.hint ?? null,
      mission_icon: snapshot?.icon ?? null,
      mission_snapshot: snapshot ?? null,
      mission_catalog_version: 'api-migration-v1',
    }
  })
}

@Injectable()
export class BoardsService {
  constructor(private readonly supabase: SupabaseService) {}

  private get admin(): any {
    return this.supabase.adminClient
  }

  async ensureUserBoard(userId: string, input: BoardSnapshotInput) {
    const now = new Date().toISOString()
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
        updated_at: now,
      })
      .select('id')
      .single()
    const inserted = insertResult.data as BoardIdRow | null
    const insertError = insertResult.error

    if (insertError) {
      if (insertError.code === '23505') {
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
    return inserted.id
  }

  async ensureUserBoardFromSession(userId: string, session: BoardSessionInput) {
    const boardId = await this.ensureUserBoard(userId, {
      clientBoardSessionId: session.sessionId,
      mode: session.mode,
      boardKind: session.version === 4 ? session.boardKind : 'mission',
      nickname: session.nickname,
      title: session.version === 4 ? session.title : session.nickname,
      description: session.version === 4 ? session.description : undefined,
      freePosition: session.freePosition,
      cellIds: session.cellIds,
      missionSnapshots: session.version === 4 ? session.missionSnapshots : [],
    })

    return { boardId }
  }

  async upsertBoardCellSnapshots(boardId: string, input: BoardSnapshotInput) {
    const rows = boardCellRows(boardId, input)
    if (rows.length === 0) return

    const { error } = await this.admin
      .from('board_cells')
      .upsert(rows, { onConflict: 'board_id,position' })

    if (error) throw error
  }
}
