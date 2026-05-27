import {
  BadRequestException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common'
import type { User } from '@supabase/supabase-js'
import { randomUUID } from 'node:crypto'

import { BoardsService } from '@/boards/boards.service'
import {
  GUEST_SESSION_MAX_AGE_SECONDS,
  SIGNED_PREVIEW_EXPIRES_SECONDS,
  SIGNED_UPLOAD_EXPIRES_SECONDS,
} from '@/media/media.constants'
import type {
  ClipPreviewInput,
  ConfirmClipUploadInput,
  ConfirmPhotoUploadInput,
  OwnerKind,
  PhotoPreviewInput,
  PresignClipUploadInput,
  PresignPhotoUploadInput,
  UpdateClipDescriptionInput,
} from '@/media/media.schemas'
import {
  clipExtFromContentType,
  codecFromMimeType,
  photoExtFromContentType,
  posterExtFromContentType,
  signedUrlExpiresAt,
} from '@/media/media.utils'
import { STORAGE_PROVIDER_R2 } from '@/storage/storage.constants'
import { R2Service, type R2SignedUpload } from '@/storage/r2.service'
import { SupabaseService } from '@/supabase/supabase.service'

interface PhotoRow {
  id: string
  user_id: string
  board_id: string | null
  position: number | null
  cell_id: string | null
  storage_path: string
  storage_provider?: string | null
  bucket_name?: string | null
  content_type: string
  size_bytes: number
}

interface GuestPhotoUploadRow {
  id: string
  guest_session_id: string
  storage_path: string
  storage_provider?: string | null
  bucket_name?: string | null
  content_type: string
  size_bytes: number
}

interface ClipRow {
  id: string
  user_id: string
  board_id: string | null
  position: number | null
  cell_id: string | null
  storage_path: string
  poster_storage_path: string | null
  storage_provider?: string | null
  bucket_name?: string | null
  content_type: string
  size_bytes: number
  duration_ms: number
  poster_content_type: string | null
  poster_size_bytes: number | null
  description?: string | null
}

interface GuestClipUploadRow {
  id: string
  guest_session_id: string
  storage_path: string
  poster_storage_path: string | null
  storage_provider?: string | null
  bucket_name?: string | null
  content_type: string
  size_bytes: number
  duration_ms: number
  poster_content_type: string | null
  poster_size_bytes: number | null
  description?: string | null
}

function uploadPayload(upload: R2SignedUpload) {
  return {
    path: upload.objectKey,
    uploadUrl: upload.signedUrl,
    token: '',
    storageProvider: STORAGE_PROVIDER_R2,
    bucketName: upload.bucketName,
    uploadHeaders: upload.uploadHeaders,
  }
}

function assertUserForOwnerKind(user: User | null, ownerKind: OwnerKind) {
  if (ownerKind === 'user' && !user) {
    throw new UnauthorizedException('Authentication required.')
  }
}

@Injectable()
export class MediaService {
  constructor(
    private readonly boardsService: BoardsService,
    private readonly r2: R2Service,
    private readonly supabase: SupabaseService,
  ) {}

  private get admin() {
    return this.supabase.adminClient
  }

  async preparePhotoUpload(params: {
    input: PresignPhotoUploadInput
    user: User | null
    guestSessionId: string
  }) {
    const { input, user, guestSessionId } = params
    const photoId = randomUUID()
    const ownerKind: OwnerKind = user ? 'user' : 'guest'
    const ext = photoExtFromContentType(input.contentType)
    const boardId = user
      ? await this.boardsService.ensureUserBoard(user.id, input)
      : null
    const objectKey = user
      ? this.r2.userPhotoKey({
          userId: user.id,
          boardId: boardId ?? '',
          position: input.position,
          id: photoId,
          ext,
        })
      : this.r2.guestPhotoKey({
          guestSessionId,
          clientBoardSessionId: input.clientBoardSessionId,
          position: input.position,
          id: photoId,
          ext,
        })
    const upload = await this.r2.createSignedUpload({
      objectKey,
      contentType: input.contentType,
      expiresInSeconds: SIGNED_UPLOAD_EXPIRES_SECONDS,
    })

    if (user) {
      const { error } = await this.admin.from('photos').insert({
        id: photoId,
        user_id: user.id,
        board_id: boardId,
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
    } else {
      const { error } = await this.admin.from('guest_photo_uploads').insert({
        id: photoId,
        guest_session_id: guestSessionId,
        client_board_session_id: input.clientBoardSessionId,
        mode: input.mode,
        nickname: input.nickname,
        free_position: input.freePosition,
        cell_ids: input.cellIds,
        position: input.position,
        cell_id: input.cellId,
        storage_path: objectKey,
        storage_provider: STORAGE_PROVIDER_R2,
        bucket_name: upload.bucketName,
        content_type: input.contentType,
        size_bytes: input.sizeBytes,
        upload_status: 'presigned',
        expires_at: signedUrlExpiresAt(GUEST_SESSION_MAX_AGE_SECONDS),
      })
      if (error) throw error
    }

    return {
      ...uploadPayload(upload),
      photoId,
      ownerKind,
      expiresAt: signedUrlExpiresAt(SIGNED_UPLOAD_EXPIRES_SECONDS),
      ...(user ? {} : { guestSessionId }),
    }
  }

  async confirmPhotoUpload(params: {
    input: ConfirmPhotoUploadInput
    user: User | null
    guestSessionId: string | null
  }) {
    const { input, user, guestSessionId } = params
    assertUserForOwnerKind(user, input.ownerKind)

    const row =
      input.ownerKind === 'user'
        ? await this.getUserPhoto(input.photoId, user!.id)
        : await this.getGuestPhoto(input.photoId, guestSessionId)

    const metadata = await this.r2.assertObjectMatches(
      { objectKey: row.storage_path, bucketName: row.bucket_name },
      { contentType: row.content_type, sizeBytes: Number(row.size_bytes) },
    )
    const now = new Date().toISOString()

    if (input.ownerKind === 'user') {
      const userPhoto = row as PhotoRow
      if (
        !userPhoto.board_id ||
        userPhoto.position === null ||
        !userPhoto.cell_id
      ) {
        throw new BadRequestException('Photo is missing board metadata.')
      }

      const { error: photoError } = await this.admin
        .from('photos')
        .update({ uploaded_at: now, object_etag: metadata.etag })
        .eq('id', userPhoto.id)
      if (photoError) throw photoError

      const { error: cellError } = await this.admin.from('board_cells').upsert(
        {
          board_id: userPhoto.board_id,
          position: userPhoto.position,
          cell_id: userPhoto.cell_id,
          photo_id: userPhoto.id,
          marked_at: now,
          completed_at: now,
          completion_type: 'photo',
        },
        { onConflict: 'board_id,position' },
      )
      if (cellError) throw cellError
    } else {
      const { error } = await this.admin
        .from('guest_photo_uploads')
        .update({
          uploaded_at: now,
          upload_status: 'uploaded',
          object_etag: metadata.etag,
        })
        .eq('id', row.id)
      if (error) throw error
    }

    return this.photoPreviewPayload(row, input.ownerKind)
  }

  async createPhotoPreviewUrls(params: {
    input: PhotoPreviewInput
    user: User | null
    guestSessionId: string | null
  }) {
    const photos = await Promise.all(
      params.input.photos.map(async (photo) => {
        assertUserForOwnerKind(params.user, photo.ownerKind)
        const row =
          photo.ownerKind === 'user'
            ? await this.getUserPhoto(photo.photoId, params.user!.id)
            : await this.getGuestPhoto(photo.photoId, params.guestSessionId)
        return this.photoPreviewPayload(row, photo.ownerKind, {
          requestedPhotoId: photo.photoId,
          requestedOwnerKind: photo.ownerKind,
        })
      }),
    )

    return { photos }
  }

  async deletePhoto(params: {
    photoId: string
    ownerKind: OwnerKind
    user: User | null
    guestSessionId: string | null
  }) {
    assertUserForOwnerKind(params.user, params.ownerKind)
    const row =
      params.ownerKind === 'user'
        ? await this.getUserPhoto(params.photoId, params.user!.id)
        : await this.getGuestPhoto(params.photoId, params.guestSessionId)

    await this.r2.deleteObjects([row.storage_path], row.bucket_name)
    const now = new Date().toISOString()

    if (params.ownerKind === 'user') {
      const { error: photoError } = await this.admin
        .from('photos')
        .update({ deleted_at: now })
        .eq('id', row.id)
      if (photoError) throw photoError

      const { error: cellError } = await this.admin
        .from('board_cells')
        .update({
          photo_id: null,
          marked_at: null,
          completed_at: null,
          completion_type: null,
        })
        .eq('photo_id', row.id)
      if (cellError) throw cellError
    } else {
      const { error } = await this.admin
        .from('guest_photo_uploads')
        .update({ deleted_at: now, upload_status: 'deleted' })
        .eq('id', row.id)
      if (error) throw error
    }

    return { ok: true }
  }

  async prepareClipUpload(params: {
    input: PresignClipUploadInput
    user: User | null
    guestSessionId: string
  }) {
    const { input, user, guestSessionId } = params
    const clipId = randomUUID()
    const ownerKind: OwnerKind = user ? 'user' : 'guest'
    const clipExt = clipExtFromContentType(input.contentType)
    const posterExt = posterExtFromContentType(input.posterContentType)
    const boardId = user
      ? await this.boardsService.ensureUserBoard(user.id, input)
      : null
    const clipKey = user
      ? this.r2.userClipKey({
          userId: user.id,
          boardId: boardId ?? '',
          position: input.position,
          id: clipId,
          ext: clipExt,
        })
      : this.r2.guestClipKey({
          guestSessionId,
          clientBoardSessionId: input.clientBoardSessionId,
          position: input.position,
          id: clipId,
          ext: clipExt,
        })
    const posterKey = user
      ? this.r2.userPosterKey({
          userId: user.id,
          boardId: boardId ?? '',
          position: input.position,
          id: clipId,
          ext: posterExt,
        })
      : this.r2.guestPosterKey({
          guestSessionId,
          clientBoardSessionId: input.clientBoardSessionId,
          position: input.position,
          id: clipId,
          ext: posterExt,
        })
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
    const codec = codecFromMimeType(input.recorderMimeType)

    if (user) {
      const { error } = await this.admin.from('clips').insert({
        id: clipId,
        user_id: user.id,
        board_id: boardId,
        position: input.position,
        cell_id: input.cellId,
        storage_path: clipKey,
        poster_storage_path: posterKey,
        storage_provider: STORAGE_PROVIDER_R2,
        bucket_name: clipUpload.bucketName,
        content_type: input.contentType,
        recorder_mime_type: input.recorderMimeType,
        codec,
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
    } else {
      const { error } = await this.admin.from('guest_clip_uploads').insert({
        id: clipId,
        guest_session_id: guestSessionId,
        client_board_session_id: input.clientBoardSessionId,
        mode: input.mode,
        board_kind: input.boardKind ?? 'mission',
        nickname: input.nickname,
        title: input.title ?? input.nickname,
        description: input.description ?? null,
        mission_snapshots: input.missionSnapshots ?? null,
        free_position: input.freePosition,
        cell_ids: input.cellIds,
        position: input.position,
        cell_id: input.cellId,
        storage_path: clipKey,
        poster_storage_path: posterKey,
        storage_provider: STORAGE_PROVIDER_R2,
        bucket_name: clipUpload.bucketName,
        content_type: input.contentType,
        recorder_mime_type: input.recorderMimeType,
        codec,
        size_bytes: input.sizeBytes,
        duration_ms: Math.round(input.durationMs),
        width: input.width ?? null,
        height: input.height ?? null,
        orientation: input.orientation ?? null,
        poster_content_type: input.posterContentType,
        poster_size_bytes: input.posterSizeBytes,
        poster_width: input.posterWidth ?? null,
        poster_height: input.posterHeight ?? null,
        upload_status: 'presigned',
        expires_at: signedUrlExpiresAt(GUEST_SESSION_MAX_AGE_SECONDS),
      })
      if (error) throw error
    }

    return {
      clipId,
      ownerKind,
      clip: uploadPayload(clipUpload),
      poster: uploadPayload(posterUpload),
      expiresAt: signedUrlExpiresAt(SIGNED_UPLOAD_EXPIRES_SECONDS),
      ...(user ? {} : { guestSessionId }),
    }
  }

  async confirmClipUpload(params: {
    input: ConfirmClipUploadInput
    user: User | null
    guestSessionId: string | null
  }) {
    const { input, user, guestSessionId } = params
    assertUserForOwnerKind(user, input.ownerKind)
    const row =
      input.ownerKind === 'user'
        ? await this.getUserClip(input.clipId, user!.id)
        : await this.getGuestClip(input.clipId, guestSessionId)

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
    const now = new Date().toISOString()

    if (input.ownerKind === 'user') {
      const userClip = row as ClipRow
      if (
        !userClip.board_id ||
        userClip.position === null ||
        !userClip.cell_id
      ) {
        throw new BadRequestException('Clip is missing board metadata.')
      }

      const { error: clipError } = await this.admin
        .from('clips')
        .update({
          uploaded_at: now,
          poster_uploaded_at: now,
          object_etag: clipMetadata.etag,
          poster_object_etag: posterMetadata.etag,
        })
        .eq('id', userClip.id)
      if (clipError) throw clipError

      const { error: cellError } = await this.admin.from('board_cells').upsert(
        {
          board_id: userClip.board_id,
          position: userClip.position,
          cell_id: userClip.cell_id,
          clip_id: userClip.id,
          marked_at: now,
          completed_at: now,
          completion_type: 'clip',
        },
        { onConflict: 'board_id,position' },
      )
      if (cellError) throw cellError
    } else {
      const { error } = await this.admin
        .from('guest_clip_uploads')
        .update({
          uploaded_at: now,
          poster_uploaded_at: now,
          upload_status: 'uploaded',
          object_etag: clipMetadata.etag,
          poster_object_etag: posterMetadata.etag,
        })
        .eq('id', row.id)
      if (error) throw error
    }

    return this.clipPreviewPayload(row, input.ownerKind)
  }

  async createClipPreviewUrls(params: {
    input: ClipPreviewInput
    user: User | null
    guestSessionId: string | null
  }) {
    const clips = await Promise.all(
      params.input.clips.map(async (clip) => {
        assertUserForOwnerKind(params.user, clip.ownerKind)
        const row =
          clip.ownerKind === 'user'
            ? await this.getUserClip(clip.clipId, params.user!.id)
            : await this.getGuestClip(clip.clipId, params.guestSessionId)
        return this.clipPreviewPayload(row, clip.ownerKind, {
          requestedClipId: clip.clipId,
          requestedOwnerKind: clip.ownerKind,
        })
      }),
    )

    return { clips }
  }

  async updateClipDescription(params: {
    clipId: string
    input: UpdateClipDescriptionInput
    user: User | null
    guestSessionId: string | null
  }) {
    assertUserForOwnerKind(params.user, params.input.ownerKind)
    const description = params.input.description?.trim() || null
    const table =
      params.input.ownerKind === 'user' ? 'clips' : 'guest_clip_uploads'
    const row =
      params.input.ownerKind === 'user'
        ? await this.getUserClip(params.clipId, params.user!.id)
        : await this.getGuestClip(params.clipId, params.guestSessionId)

    const { error } = await this.admin
      .from(table)
      .update({ description })
      .eq('id', row.id)
    if (error) throw error

    return { ok: true }
  }

  async deleteClip(params: {
    clipId: string
    ownerKind: OwnerKind
    user: User | null
    guestSessionId: string | null
  }) {
    assertUserForOwnerKind(params.user, params.ownerKind)
    const row =
      params.ownerKind === 'user'
        ? await this.getUserClip(params.clipId, params.user!.id)
        : await this.getGuestClip(params.clipId, params.guestSessionId)
    const keys = [row.storage_path, row.poster_storage_path].filter(
      (key): key is string => Boolean(key),
    )

    await this.r2.deleteObjects(keys, row.bucket_name)
    const now = new Date().toISOString()

    if (params.ownerKind === 'user') {
      const { error: clipError } = await this.admin
        .from('clips')
        .update({ deleted_at: now })
        .eq('id', row.id)
      if (clipError) throw clipError

      const { error: cellError } = await this.admin
        .from('board_cells')
        .update({
          clip_id: null,
          marked_at: null,
          completed_at: null,
          completion_type: null,
        })
        .eq('clip_id', row.id)
      if (cellError) throw cellError
    } else {
      const { error } = await this.admin
        .from('guest_clip_uploads')
        .update({ deleted_at: now, upload_status: 'deleted' })
        .eq('id', row.id)
      if (error) throw error
    }

    return { ok: true }
  }

  private async getUserPhoto(photoId: string, userId: string) {
    const result = await this.admin
      .from('photos')
      .select(
        'id, user_id, board_id, position, cell_id, storage_path, storage_provider, bucket_name, content_type, size_bytes',
      )
      .eq('id', photoId)
      .eq('user_id', userId)
      .is('deleted_at', null)
      .single()
    const data = result.data as PhotoRow | null
    const error = result.error

    if (error || !data) throw new NotFoundException('Photo not found.')
    return data
  }

  private async getGuestPhoto(photoId: string, guestSessionId: string | null) {
    if (!guestSessionId)
      throw new UnauthorizedException('Guest session required.')

    const result = await this.admin
      .from('guest_photo_uploads')
      .select(
        'id, guest_session_id, storage_path, storage_provider, bucket_name, content_type, size_bytes',
      )
      .eq('id', photoId)
      .eq('guest_session_id', guestSessionId)
      .is('deleted_at', null)
      .single()
    const data = result.data as GuestPhotoUploadRow | null
    const error = result.error

    if (error || !data) throw new NotFoundException('Photo not found.')
    return data
  }

  private async getUserClip(clipId: string, userId: string) {
    const result = await this.admin
      .from('clips')
      .select(
        'id, user_id, board_id, position, cell_id, storage_path, poster_storage_path, storage_provider, bucket_name, content_type, size_bytes, duration_ms, poster_content_type, poster_size_bytes, description',
      )
      .eq('id', clipId)
      .eq('user_id', userId)
      .is('deleted_at', null)
      .single()
    const data = result.data as ClipRow | null
    const error = result.error

    if (error || !data) throw new NotFoundException('Clip not found.')
    return data
  }

  private async getGuestClip(clipId: string, guestSessionId: string | null) {
    if (!guestSessionId)
      throw new UnauthorizedException('Guest session required.')

    const result = await this.admin
      .from('guest_clip_uploads')
      .select(
        'id, guest_session_id, storage_path, poster_storage_path, storage_provider, bucket_name, content_type, size_bytes, duration_ms, poster_content_type, poster_size_bytes, description',
      )
      .eq('id', clipId)
      .eq('guest_session_id', guestSessionId)
      .is('deleted_at', null)
      .single()
    const data = result.data as GuestClipUploadRow | null
    const error = result.error

    if (error || !data) throw new NotFoundException('Clip not found.')
    return data
  }

  private async photoPreviewPayload(
    row: PhotoRow | GuestPhotoUploadRow,
    ownerKind: OwnerKind,
    requested?: {
      requestedPhotoId: string
      requestedOwnerKind: OwnerKind
    },
  ) {
    return {
      photoId: row.id,
      ownerKind,
      previewUrl: await this.r2.createPreviewUrl({
        objectKey: row.storage_path,
        bucketName: row.bucket_name,
        expiresInSeconds: SIGNED_PREVIEW_EXPIRES_SECONDS,
      }),
      previewUrlExpiresAt: signedUrlExpiresAt(SIGNED_PREVIEW_EXPIRES_SECONDS),
      ...requested,
    }
  }

  private async clipPreviewPayload(
    row: ClipRow | GuestClipUploadRow,
    ownerKind: OwnerKind,
    requested?: {
      requestedClipId: string
      requestedOwnerKind: OwnerKind
    },
  ) {
    if (!row.poster_storage_path) {
      throw new BadRequestException('Clip is missing poster metadata.')
    }

    const [clipUrl, posterUrl] = await Promise.all([
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
      ownerKind,
      clipUrl,
      clipUrlExpiresAt: signedUrlExpiresAt(SIGNED_PREVIEW_EXPIRES_SECONDS),
      posterUrl,
      posterUrlExpiresAt: signedUrlExpiresAt(SIGNED_PREVIEW_EXPIRES_SECONDS),
      durationMs: row.duration_ms,
      ...(row.description ? { description: row.description } : {}),
      ...requested,
    }
  }
}
