import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common'
import type { User } from '@supabase/supabase-js'
import { randomUUID } from 'node:crypto'

import { ClockService } from '@/common/time/clock.service'
import { computeLifecycle } from '@/common/time/kst'
import { ConnectionsService } from '@/connections/connections.service'
import type {
  ConfirmGroupClipUploadInput,
  ConfirmGroupPhotoUploadInput,
  PresignGroupClipUploadInput,
  PresignGroupPhotoUploadInput,
} from '@/group-boards/group-media.schemas'
import {
  GROUP_BOARD_SELECT,
  type GroupBoardRow,
} from '@/group-boards/group-board.types'
import { groupBingoEnabled } from '@/group-boards/group-boards.constants'
import {
  SIGNED_PREVIEW_EXPIRES_SECONDS,
  SIGNED_UPLOAD_EXPIRES_SECONDS,
} from '@/media/media.constants'
import {
  clipExtFromContentType,
  codecFromMimeType,
  photoExtFromContentType,
  posterExtFromContentType,
  signedUrlExpiresAt,
} from '@/media/media.utils'
import type { R2SignedUpload } from '@/storage/r2.service'
import { R2Service } from '@/storage/r2.service'
import { SupabaseService } from '@/supabase/supabase.service'

const STORAGE_PROVIDER_R2 = 'r2'

interface GroupPhotoRow {
  id: string
  user_id: string
  group_board_id: string | null
  position: number | null
  cell_id: string | null
  storage_path: string
  bucket_name: string | null
  content_type: string
  size_bytes: number | string
  uploaded_at: string | null
}

interface GroupClipRow extends GroupPhotoRow {
  poster_storage_path: string | null
  poster_content_type: string | null
  poster_size_bytes: number | string | null
}

function uploadPayload(upload: R2SignedUpload) {
  return {
    bucketName: upload.bucketName,
    objectKey: upload.objectKey,
    uploadUrl: upload.signedUrl,
    uploadHeaders: upload.uploadHeaders,
  }
}

function mapGroupConfirmRpcError(error: { message?: string }): Error {
  const message = error.message ?? ''
  if (message.includes('CELL_MISMATCH')) {
    return new ConflictException({
      code: 'CELL_MISMATCH',
      message: 'The board cell changed before the upload was confirmed.',
    })
  }
  if (message.includes('FREE_CELL_MEDIA')) {
    return new BadRequestException({
      code: 'FREE_CELL_MEDIA',
      message: 'The free cell cannot receive media uploads.',
    })
  }
  if (message.includes('NOT_GROUP_MEMBER')) {
    return new ForbiddenException('Not an active member of this group.')
  }
  if (message.includes('GROUP_BOARD_NOT_FOUND')) {
    return new NotFoundException('Group board not found.')
  }
  return error instanceof Error ? error : new Error(message)
}

function assertGroupBingoEnabled() {
  if (!groupBingoEnabled()) {
    throw new NotFoundException('Group bingo is disabled.')
  }
}

@Injectable()
export class GroupMediaService {
  constructor(
    private readonly supabase: SupabaseService,
    private readonly connections: ConnectionsService,
    private readonly r2: R2Service,
    private readonly clock: ClockService = new ClockService(),
  ) {}

  private get admin() {
    return this.supabase.adminClient
  }

  private now() {
    return this.clock.now()
  }

  async presignGroupPhotoUpload(user: User, input: PresignGroupPhotoUploadInput) {
    assertGroupBingoEnabled()
    await this.connections.assertActiveGroupMember(user.id, input.groupId)
    const board = await this.getTodayBoardForUpload(input.groupId, input)

    const photoId = randomUUID()
    const ext = photoExtFromContentType(input.contentType)
    const objectKey = this.r2.groupPhotoKey({
      userId: user.id,
      groupBoardId: board.id,
      position: input.position,
      id: photoId,
      ext,
    })
    const upload = await this.r2.createSignedUpload({
      objectKey,
      contentType: input.contentType,
      expiresInSeconds: SIGNED_UPLOAD_EXPIRES_SECONDS,
    })

    // XOR target (0024): group photos carry group_board_id and no board_id.
    const { error } = await this.admin.from('photos').insert({
      id: photoId,
      user_id: user.id,
      board_id: null,
      group_board_id: board.id,
      position: input.position,
      cell_id: input.cellId,
      storage_path: objectKey,
      storage_provider: STORAGE_PROVIDER_R2,
      bucket_name: upload.bucketName,
      content_type: input.contentType,
      size_bytes: input.sizeBytes,
      source: 'authenticated',
    })
    if (error) throw error

    return {
      ...uploadPayload(upload),
      photoId,
      ownerKind: 'user' as const,
      expiresAt: signedUrlExpiresAt(SIGNED_UPLOAD_EXPIRES_SECONDS),
    }
  }

  async confirmGroupPhotoUpload(user: User, input: ConfirmGroupPhotoUploadInput) {
    assertGroupBingoEnabled()
    await this.connections.assertActiveGroupMember(user.id, input.groupId)

    const row = await this.getGroupPhoto(input.photoId, user.id, input.groupId)
    const metadata = await this.r2.assertObjectMatches(
      { objectKey: row.storage_path, bucketName: row.bucket_name },
      { contentType: row.content_type, sizeBytes: Number(row.size_bytes) },
    )

    const { error } = await this.admin.rpc('confirm_group_photo_upload', {
      p_photo_id: row.id,
      p_user_id: user.id,
      p_object_etag: metadata.etag,
      p_confirmed_at: this.now().toISOString(),
    })
    if (error) throw mapGroupConfirmRpcError(error)

    return {
      photoId: row.id,
      ownerKind: 'user' as const,
      previewUrl: await this.r2.createPreviewUrl({
        objectKey: row.storage_path,
        bucketName: row.bucket_name,
        expiresInSeconds: SIGNED_PREVIEW_EXPIRES_SECONDS,
      }),
      previewUrlExpiresAt: signedUrlExpiresAt(SIGNED_PREVIEW_EXPIRES_SECONDS),
    }
  }

  async presignGroupClipUpload(user: User, input: PresignGroupClipUploadInput) {
    assertGroupBingoEnabled()
    await this.connections.assertActiveGroupMember(user.id, input.groupId)
    const board = await this.getTodayBoardForUpload(input.groupId, input)

    const clipId = randomUUID()
    const clipExt = clipExtFromContentType(input.contentType)
    const posterExt = posterExtFromContentType(input.posterContentType)
    const keyInput = {
      userId: user.id,
      groupBoardId: board.id,
      position: input.position,
      id: clipId,
    }
    const clipKey = this.r2.groupClipKey({ ...keyInput, ext: clipExt })
    const posterKey = this.r2.groupPosterKey({ ...keyInput, ext: posterExt })

    const [clipUpload, posterUpload] = await Promise.all([
      this.r2.createSignedUpload({
        objectKey: clipKey,
        contentType: input.contentType,
        expiresInSeconds: SIGNED_UPLOAD_EXPIRES_SECONDS,
      }),
      this.r2.createSignedUpload({
        objectKey: posterKey,
        contentType: input.posterContentType,
        expiresInSeconds: SIGNED_UPLOAD_EXPIRES_SECONDS,
      }),
    ])

    const { error } = await this.admin.from('clips').insert({
      id: clipId,
      user_id: user.id,
      board_id: null,
      group_board_id: board.id,
      position: input.position,
      cell_id: input.cellId,
      storage_path: clipKey,
      poster_storage_path: posterKey,
      storage_provider: STORAGE_PROVIDER_R2,
      bucket_name: clipUpload.bucketName,
      content_type: input.contentType,
      recorder_mime_type: input.recorderMimeType,
      codec: codecFromMimeType(input.recorderMimeType),
      size_bytes: input.sizeBytes,
      duration_ms: Math.round(input.durationMs),
      width: input.width ?? null,
      height: input.height ?? null,
      orientation: input.orientation ?? null,
      poster_content_type: input.posterContentType,
      poster_size_bytes: input.posterSizeBytes,
      poster_width: input.posterWidth ?? null,
      poster_height: input.posterHeight ?? null,
      description: input.clipDescription?.trim() || null,
      source: 'authenticated',
    })
    if (error) throw error

    return {
      clipId,
      ownerKind: 'user' as const,
      clip: uploadPayload(clipUpload),
      poster: uploadPayload(posterUpload),
      expiresAt: signedUrlExpiresAt(SIGNED_UPLOAD_EXPIRES_SECONDS),
    }
  }

  async confirmGroupClipUpload(user: User, input: ConfirmGroupClipUploadInput) {
    assertGroupBingoEnabled()
    await this.connections.assertActiveGroupMember(user.id, input.groupId)

    const row = await this.getGroupClip(input.clipId, user.id, input.groupId)
    if (
      !row.poster_storage_path ||
      !row.poster_content_type ||
      !row.poster_size_bytes
    ) {
      throw new BadRequestException('Clip is missing poster metadata.')
    }

    const [clipMetadata, posterMetadata] = await Promise.all([
      this.r2.assertObjectMatches(
        { objectKey: row.storage_path, bucketName: row.bucket_name },
        { contentType: row.content_type, sizeBytes: Number(row.size_bytes) },
      ),
      this.r2.assertObjectMatches(
        { objectKey: row.poster_storage_path, bucketName: row.bucket_name },
        {
          contentType: row.poster_content_type,
          sizeBytes: Number(row.poster_size_bytes),
        },
      ),
    ])

    const { error } = await this.admin.rpc('confirm_group_clip_upload', {
      p_clip_id: row.id,
      p_user_id: user.id,
      p_object_etag: clipMetadata.etag,
      p_poster_object_etag: posterMetadata.etag,
      p_confirmed_at: this.now().toISOString(),
    })
    if (error) throw mapGroupConfirmRpcError(error)

    const [previewUrl, posterPreviewUrl] = await Promise.all([
      this.r2.createPreviewUrl({
        objectKey: row.storage_path,
        bucketName: row.bucket_name,
        expiresInSeconds: SIGNED_PREVIEW_EXPIRES_SECONDS,
      }),
      this.r2.createPreviewUrl({
        objectKey: row.poster_storage_path,
        bucketName: row.bucket_name,
        expiresInSeconds: SIGNED_PREVIEW_EXPIRES_SECONDS,
      }),
    ])

    return {
      clipId: row.id,
      ownerKind: 'user' as const,
      previewUrl,
      posterPreviewUrl,
      previewUrlExpiresAt: signedUrlExpiresAt(SIGNED_PREVIEW_EXPIRES_SECONDS),
    }
  }

  /**
   * Uploads target the group's current live board — the latest board, which
   * stays uploadable through its KST grace window (parity with the board
   * GET's resolveCurrentBoard). The cell must match the current board
   * snapshot (server-side counterpart of validateMediaBoardShape — group
   * boards have no client session), and the free center cell never accepts
   * media: it is auto-complete, and letting it set first_media_at would
   * lock the reroll via a cell that needs no mission evidence.
   */
  private async getTodayBoardForUpload(
    groupId: string,
    input: { position: number; cellId: string },
  ) {
    const { data, error } = await this.admin
      .from('group_boards')
      .select(GROUP_BOARD_SELECT)
      .eq('group_id', groupId)
      .is('deleted_at', null)
      .order('daily_date', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (error) throw error
    const board = data as GroupBoardRow | null
    if (!board) throw new NotFoundException('Group board not found.')

    if (
      board.ended_at ||
      computeLifecycle(board.daily_date, this.now()).state === 'expired'
    ) {
      throw new ConflictException({
        code: 'GROUP_BOARD_ENDED',
        message: 'This group board is already ended.',
      })
    }

    if (input.position === board.free_position) {
      throw new BadRequestException({
        code: 'FREE_CELL_MEDIA',
        message: 'The free cell cannot receive media uploads.',
      })
    }

    if (board.cell_ids?.[input.position] !== input.cellId) {
      throw new BadRequestException('cellId must match the board position.')
    }

    return board
  }

  private async getGroupPhoto(photoId: string, userId: string, groupId: string) {
    const { data, error } = await this.admin
      .from('photos')
      .select(
        'id, user_id, group_board_id, position, cell_id, storage_path, bucket_name, content_type, size_bytes, uploaded_at',
      )
      .eq('id', photoId)
      .eq('user_id', userId)
      .is('deleted_at', null)
      .maybeSingle()

    if (error) throw error
    const row = data as GroupPhotoRow | null
    if (!row) throw new NotFoundException('Photo not found.')
    if (!row.group_board_id || row.position === null || !row.cell_id) {
      throw new BadRequestException('Photo is missing group board metadata.')
    }
    await this.assertBoardBelongsToGroup(row.group_board_id, groupId)
    return row
  }

  private async getGroupClip(clipId: string, userId: string, groupId: string) {
    const { data, error } = await this.admin
      .from('clips')
      .select(
        'id, user_id, group_board_id, position, cell_id, storage_path, poster_storage_path, bucket_name, content_type, size_bytes, poster_content_type, poster_size_bytes, uploaded_at',
      )
      .eq('id', clipId)
      .eq('user_id', userId)
      .is('deleted_at', null)
      .maybeSingle()

    if (error) throw error
    const row = data as GroupClipRow | null
    if (!row) throw new NotFoundException('Clip not found.')
    if (!row.group_board_id || row.position === null || !row.cell_id) {
      throw new BadRequestException('Clip is missing group board metadata.')
    }
    await this.assertBoardBelongsToGroup(row.group_board_id, groupId)
    return row
  }

  private async assertBoardBelongsToGroup(groupBoardId: string, groupId: string) {
    const { data, error } = await this.admin
      .from('group_boards')
      .select('id, group_id')
      .eq('id', groupBoardId)
      .maybeSingle()

    if (error) throw error
    if (!data || (data as { group_id: string }).group_id !== groupId) {
      throw new NotFoundException('Group board not found.')
    }
  }
}
