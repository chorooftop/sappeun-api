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
  object_etag?: string | null
  content_type: string
  size_bytes: number
  uploaded_at?: string | null
}

interface GuestPhotoUploadRow {
  id: string
  guest_session_id: string
  client_board_session_id: string
  mode: '5x5' | '3x3'
  nickname: string
  free_position: number
  cell_ids: string[]
  position: number
  cell_id: string
  storage_path: string
  storage_provider?: string | null
  bucket_name?: string | null
  object_etag?: string | null
  content_type: string
  size_bytes: number
  uploaded_at?: string | null
  upload_status?: string
  expires_at?: string
  promoted_user_id?: string | null
  promoted_photo_id?: string | null
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
  object_etag?: string | null
  content_type: string
  size_bytes: number
  duration_ms: number
  poster_content_type: string | null
  poster_size_bytes: number | null
  uploaded_at?: string | null
  description?: string | null
}

interface GuestClipUploadRow {
  id: string
  guest_session_id: string
  client_board_session_id: string
  mode: '5x5' | '3x3'
  board_kind?: 'mission' | 'custom' | null
  nickname: string
  title?: string | null
  description?: string | null
  clip_description?: string | null
  free_position: number
  cell_ids: string[]
  mission_snapshots?: unknown[] | null
  position: number
  cell_id: string
  storage_path: string
  poster_storage_path: string | null
  storage_provider?: string | null
  bucket_name?: string | null
  object_etag?: string | null
  poster_object_etag?: string | null
  content_type: string
  recorder_mime_type?: string | null
  codec?: string | null
  size_bytes: number
  duration_ms: number
  width?: number | null
  height?: number | null
  orientation?: string | null
  poster_content_type: string | null
  poster_size_bytes: number | null
  poster_width?: number | null
  poster_height?: number | null
  uploaded_at?: string | null
  upload_status?: string
  expires_at?: string
  promoted_user_id?: string | null
  promoted_clip_id?: string | null
}

interface StoredPhotoObjectRow {
  storage_path: string
  bucket_name?: string | null
}

interface StoredClipObjectRow extends StoredPhotoObjectRow {
  poster_storage_path: string | null
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

function assertPreviewableUpload(row: {
  uploaded_at?: string | null
  upload_status?: string | null
  expires_at?: string | null
}) {
  if ('upload_status' in row) {
    if (row.upload_status !== 'uploaded') {
      throw new NotFoundException('Media not found.')
    }

    if (row.expires_at && new Date(row.expires_at).getTime() <= Date.now()) {
      throw new NotFoundException('Media not found.')
    }

    return
  }

  if (!row.uploaded_at) {
    throw new NotFoundException('Media not found.')
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
      ? await this.boardsService.ensureUserBoardForMedia(user.id, input)
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

      const { error: confirmError } = await this.admin.rpc(
        'confirm_user_photo_upload',
        {
          p_photo_id: userPhoto.id,
          p_user_id: user!.id,
          p_object_etag: metadata.etag,
          p_confirmed_at: now,
        },
      )
      if (confirmError) throw confirmError
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
        assertPreviewableUpload(row)
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
      const userPhoto = row as PhotoRow
      const { error: photoError } = await this.admin
        .from('photos')
        .update({ deleted_at: now })
        .eq('id', userPhoto.id)
      if (photoError) throw photoError

      const { error: cellError } = await this.admin
        .from('board_cells')
        .update({
          photo_id: null,
          marked_at: null,
          completed_at: null,
          completion_type: null,
        })
        .eq('photo_id', userPhoto.id)
      if (cellError) throw cellError
      if (userPhoto.board_id) {
        await this.boardsService.touchUserBoard(userPhoto.board_id)
      }
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
      ? await this.boardsService.ensureUserBoardForMedia(user.id, input)
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
        board_kind: input.boardKind,
        nickname: input.nickname,
        title: input.title,
        description: input.description ?? null,
        mission_snapshots: input.missionSnapshots,
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
        clip_description: input.clipDescription?.trim() || null,
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

      const { error: confirmError } = await this.admin.rpc(
        'confirm_user_clip_upload',
        {
          p_clip_id: userClip.id,
          p_user_id: user!.id,
          p_object_etag: clipMetadata.etag,
          p_poster_object_etag: posterMetadata.etag,
          p_confirmed_at: now,
        },
      )
      if (confirmError) throw confirmError
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
        assertPreviewableUpload(row)
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
    const row =
      params.input.ownerKind === 'user'
        ? await this.getUserClip(params.clipId, params.user!.id)
        : await this.getGuestClip(params.clipId, params.guestSessionId)

    const update =
      params.input.ownerKind === 'user'
        ? { description }
        : { clip_description: description }

    const { error } = await this.admin
      .from(params.input.ownerKind === 'user' ? 'clips' : 'guest_clip_uploads')
      .update(update)
      .eq('id', row.id)
    if (error) throw error

    if (params.input.ownerKind === 'user') {
      const userClip = row as ClipRow
      if (!userClip.board_id) {
        throw new BadRequestException('Clip is missing board metadata.')
      }
      await this.boardsService.touchUserBoard(userClip.board_id)
    }

    if (
      params.input.ownerKind === 'guest' &&
      params.input.boardSnapshot &&
      'client_board_session_id' in row
    ) {
      const { error: boardUpdateError } = await this.admin
        .from('guest_clip_uploads')
        .update({
          board_kind: params.input.boardSnapshot.boardKind,
          title: params.input.boardSnapshot.title,
          description: params.input.boardSnapshot.description ?? null,
          free_position: params.input.boardSnapshot.freePosition,
          cell_ids: params.input.boardSnapshot.cellIds,
          mission_snapshots: params.input.boardSnapshot.missionSnapshots,
        })
        .eq('guest_session_id', row.guest_session_id)
        .eq('client_board_session_id', row.client_board_session_id)
        .is('deleted_at', null)
      if (boardUpdateError) throw boardUpdateError
    }

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
      const userClip = row as ClipRow
      const { error: clipError } = await this.admin
        .from('clips')
        .update({ deleted_at: now })
        .eq('id', userClip.id)
      if (clipError) throw clipError

      const { error: cellError } = await this.admin
        .from('board_cells')
        .update({
          clip_id: null,
          marked_at: null,
          completed_at: null,
          completion_type: null,
        })
        .eq('clip_id', userClip.id)
      if (cellError) throw cellError
      if (userClip.board_id) {
        await this.boardsService.touchUserBoard(userClip.board_id)
      }
    } else {
      const { error } = await this.admin
        .from('guest_clip_uploads')
        .update({ deleted_at: now, upload_status: 'deleted' })
        .eq('id', row.id)
      if (error) throw error
    }

    return { ok: true }
  }

  async promoteGuestPhotosForUser(params: {
    userId: string
    guestSessionId: string | null
  }) {
    if (!params.guestSessionId) return { promoted: 0, photos: [] }

    const { data: uploads, error } = await this.admin
      .from('guest_photo_uploads')
      .select(
        'id, guest_session_id, client_board_session_id, mode, nickname, free_position, cell_ids, position, cell_id, storage_path, storage_provider, bucket_name, object_etag, content_type, size_bytes, upload_status, expires_at, promoted_user_id, promoted_photo_id',
      )
      .eq('guest_session_id', params.guestSessionId)
      .eq('upload_status', 'uploaded')
      .is('deleted_at', null)

    if (error) throw error
    if (!uploads?.length) return { promoted: 0, photos: [] }

    let promoted = 0
    const photos = []

    for (const upload of uploads as GuestPhotoUploadRow[]) {
      if (
        upload.expires_at &&
        new Date(upload.expires_at).getTime() <= Date.now()
      ) {
        continue
      }
      if (upload.promoted_photo_id) continue

      const boardId =
        await this.boardsService.ensureUserBoardForGuestPhotoPromotion(
          params.userId,
          {
            clientBoardSessionId: upload.client_board_session_id,
            mode: upload.mode,
            nickname: upload.nickname,
            freePosition: upload.free_position,
            cellIds: upload.cell_ids,
            position: upload.position,
            cellId: upload.cell_id,
          },
        )
      const ext = photoExtFromContentType(upload.content_type)
      const photoId = upload.id
      const destinationKey = this.r2.userPhotoKey({
        userId: params.userId,
        boardId,
        position: upload.position,
        id: photoId,
        ext,
      })
      const bucketName = upload.bucket_name ?? this.r2.bucketName
      let promotedObject: StoredPhotoObjectRow = {
        storage_path: destinationKey,
        bucket_name: bucketName,
      }

      const { data: existingPhoto, error: existingPhotoError } =
        await this.admin
          .from('photos')
          .select(
            'id, user_id, board_id, position, cell_id, storage_path, storage_provider, bucket_name, object_etag, content_type, size_bytes, uploaded_at, deleted_at',
          )
          .eq('id', photoId)
          .maybeSingle()

      if (existingPhotoError) throw existingPhotoError

      if (existingPhoto) {
        promotedObject = existingPhoto as StoredPhotoObjectRow
      } else {
        await this.r2.copyObject({
          sourceKey: upload.storage_path,
          destinationKey,
          bucketName,
          contentType: upload.content_type,
        })
        const metadata = await this.r2.assertObjectMatches(
          { objectKey: destinationKey, bucketName },
          {
            contentType: upload.content_type,
            sizeBytes: Number(upload.size_bytes),
          },
        )

        const now = new Date().toISOString()
        const { error: insertError } = await this.admin.from('photos').insert({
          id: photoId,
          user_id: params.userId,
          board_id: boardId,
          position: upload.position,
          cell_id: upload.cell_id,
          storage_path: destinationKey,
          storage_provider: STORAGE_PROVIDER_R2,
          bucket_name: bucketName,
          object_etag: metadata.etag,
          content_type: upload.content_type,
          size_bytes: upload.size_bytes,
          uploaded_at: now,
          captured_at: now,
          source: 'guest_promoted',
        })
        if (insertError) throw insertError
      }

      const markedAt = new Date().toISOString()
      const { error: boardCellError } = await this.admin
        .from('board_cells')
        .upsert(
          {
            board_id: boardId,
            position: upload.position,
            cell_id: upload.cell_id,
            photo_id: photoId,
            clip_id: null,
            marked_at: markedAt,
            completed_at: markedAt,
            completion_type: 'photo',
          },
          { onConflict: 'board_id,position' },
        )
      if (boardCellError) throw boardCellError
      await this.boardsService.touchUserBoard(boardId)

      await this.removeStoredPhotos([upload])

      const { error: updateError } = await this.admin
        .from('guest_photo_uploads')
        .update({
          upload_status: 'promoted',
          promoted_user_id: params.userId,
          promoted_photo_id: photoId,
          promoted_at: new Date().toISOString(),
          deleted_at: new Date().toISOString(),
        })
        .eq('id', upload.id)
      if (updateError) throw updateError

      photos.push({
        guestPhotoId: upload.id,
        userPhotoId: photoId,
        position: upload.position,
        cellId: upload.cell_id,
        ...(await this.photoPreviewPayload(
          { ...promotedObject, id: photoId } as PhotoRow,
          'user',
        )),
      })
      promoted += 1
    }

    return { promoted, photos }
  }

  async promoteGuestClipsForUser(params: {
    userId: string
    guestSessionId: string | null
  }) {
    if (!params.guestSessionId) return { promoted: 0, clips: [] }

    const { data: uploads, error } = await this.admin
      .from('guest_clip_uploads')
      .select(
        'id, guest_session_id, client_board_session_id, mode, board_kind, nickname, title, description, clip_description, free_position, cell_ids, mission_snapshots, position, cell_id, storage_path, poster_storage_path, storage_provider, bucket_name, object_etag, poster_object_etag, content_type, recorder_mime_type, codec, size_bytes, duration_ms, width, height, orientation, poster_content_type, poster_size_bytes, poster_width, poster_height, upload_status, expires_at, promoted_user_id, promoted_clip_id',
      )
      .eq('guest_session_id', params.guestSessionId)
      .eq('upload_status', 'uploaded')
      .is('deleted_at', null)

    if (error) throw error
    if (!uploads?.length) return { promoted: 0, clips: [] }

    let promoted = 0
    const clips = []
    const now = new Date().toISOString()

    for (const upload of uploads as GuestClipUploadRow[]) {
      if (!upload.poster_storage_path || upload.promoted_clip_id) continue
      if (
        upload.expires_at &&
        new Date(upload.expires_at).getTime() <= Date.now()
      ) {
        continue
      }

      const boardId = await this.boardsService.ensureUserBoard(params.userId, {
        clientBoardSessionId: upload.client_board_session_id,
        mode: upload.mode,
        boardKind: upload.board_kind ?? 'mission',
        nickname: upload.nickname,
        title: upload.title ?? upload.nickname,
        description: upload.description ?? undefined,
        freePosition: upload.free_position,
        cellIds: upload.cell_ids,
        missionSnapshots: (upload.mission_snapshots as never[]) ?? [],
      })
      const clipExt = clipExtFromContentType(upload.content_type)
      const posterExt = posterExtFromContentType(
        upload.poster_content_type ?? 'image/jpeg',
      )
      const clipPath = this.r2.userClipKey({
        userId: params.userId,
        boardId,
        position: upload.position,
        id: upload.id,
        ext: clipExt,
      })
      const posterPath = this.r2.userPosterKey({
        userId: params.userId,
        boardId,
        position: upload.position,
        id: upload.id,
        ext: posterExt,
      })
      const bucketName = upload.bucket_name ?? this.r2.bucketName
      const { data: existingClip, error: existingClipError } = await this.admin
        .from('clips')
        .select('id')
        .eq('id', upload.id)
        .maybeSingle()

      if (existingClipError) throw existingClipError

      if (!existingClip) {
        await this.r2.copyObject({
          sourceKey: upload.storage_path,
          destinationKey: clipPath,
          bucketName,
          contentType: upload.content_type,
        })
        await this.r2.copyObject({
          sourceKey: upload.poster_storage_path,
          destinationKey: posterPath,
          bucketName,
          contentType: upload.poster_content_type ?? undefined,
        })
        const [clipMetadata, posterMetadata] = await Promise.all([
          this.r2.assertObjectMatches(
            { objectKey: clipPath, bucketName },
            { contentType: upload.content_type, sizeBytes: upload.size_bytes },
          ),
          this.r2.assertObjectMatches(
            { objectKey: posterPath, bucketName },
            {
              contentType: upload.poster_content_type ?? 'image/jpeg',
              sizeBytes: Number(upload.poster_size_bytes),
            },
          ),
        ])

        const { error: insertError } = await this.admin.from('clips').insert({
          id: upload.id,
          user_id: params.userId,
          board_id: boardId,
          cell_id: upload.cell_id,
          position: upload.position,
          storage_path: clipPath,
          poster_storage_path: posterPath,
          storage_provider: STORAGE_PROVIDER_R2,
          bucket_name: bucketName,
          object_etag: clipMetadata.etag,
          poster_object_etag: posterMetadata.etag,
          content_type: upload.content_type,
          recorder_mime_type: upload.recorder_mime_type,
          codec: upload.codec,
          size_bytes: upload.size_bytes,
          duration_ms: upload.duration_ms,
          width: upload.width,
          height: upload.height,
          orientation: upload.orientation,
          poster_content_type: upload.poster_content_type,
          poster_size_bytes: upload.poster_size_bytes,
          poster_width: upload.poster_width,
          poster_height: upload.poster_height,
          uploaded_at: now,
          poster_uploaded_at: now,
          recorded_at: now,
          source: 'guest_promoted',
          description: upload.clip_description ?? null,
        })
        if (insertError) throw insertError
      }

      const { error: cellError } = await this.admin.from('board_cells').upsert(
        {
          board_id: boardId,
          position: upload.position,
          cell_id: upload.cell_id,
          photo_id: null,
          clip_id: upload.id,
          marked_at: now,
          completed_at: now,
          completion_type: 'clip',
        },
        { onConflict: 'board_id,position' },
      )
      if (cellError) throw cellError
      await this.boardsService.touchUserBoard(boardId)

      const { error: updateError } = await this.admin
        .from('guest_clip_uploads')
        .update({
          upload_status: 'promoted',
          promoted_user_id: params.userId,
          promoted_clip_id: upload.id,
          promoted_at: now,
          deleted_at: now,
        })
        .eq('id', upload.id)
      if (updateError) throw updateError

      await this.removeStoredClipObjects([upload])

      promoted += 1
      clips.push({ guestClipId: upload.id, userClipId: upload.id })
    }

    return { promoted, clips }
  }

  async cleanupExpiredGuestPhotos(limit = 100) {
    const { data: candidates, error } = await this.admin
      .from('guest_photo_uploads')
      .select(
        'id, guest_session_id, client_board_session_id, mode, nickname, free_position, cell_ids, position, cell_id, storage_path, storage_provider, bucket_name, object_etag, content_type, size_bytes, upload_status, expires_at, promoted_user_id, promoted_photo_id',
      )
      .in('upload_status', ['presigned', 'uploaded'])
      .lte('expires_at', new Date().toISOString())
      .is('deleted_at', null)
      .limit(limit)

    if (error) throw error
    if (!candidates?.length) return { expired: 0 }

    const candidateRows = candidates as GuestPhotoUploadRow[]
    const previousStatusById = new Map(
      candidateRows.map((upload) => [upload.id, upload.upload_status]),
    )
    const now = new Date().toISOString()
    const { data: uploads, error: updateError } = await this.admin
      .from('guest_photo_uploads')
      .update({
        upload_status: 'expired',
        deleted_at: now,
      })
      .in(
        'id',
        candidateRows.map((upload) => upload.id),
      )
      .in('upload_status', ['presigned', 'uploaded'])
      .is('deleted_at', null)
      .select('id, storage_path, bucket_name, upload_status')
    if (updateError) throw updateError

    const claimedUploads = (uploads ?? []) as GuestPhotoUploadRow[]

    try {
      await this.removeStoredPhotos(claimedUploads)
    } catch (error) {
      await Promise.all(
        claimedUploads.map((upload) =>
          this.admin
            .from('guest_photo_uploads')
            .update({
              upload_status: previousStatusById.get(upload.id) ?? 'presigned',
              deleted_at: null,
            })
            .eq('id', upload.id)
            .eq('upload_status', 'expired')
            .eq('deleted_at', now),
        ),
      )
      throw error
    }

    return { expired: claimedUploads.length }
  }

  async cleanupExpiredGuestClips(limit = 100) {
    const { data: candidates, error } = await this.admin
      .from('guest_clip_uploads')
      .select(
        'id, storage_path, poster_storage_path, bucket_name, upload_status, expires_at',
      )
      .lte('expires_at', new Date().toISOString())
      .in('upload_status', ['presigned', 'uploaded', 'failed'])
      .is('deleted_at', null)
      .limit(limit)

    if (error) throw error
    if (!candidates?.length) return { deleted: 0 }

    const candidateRows = candidates as GuestClipUploadRow[]
    const previousStatusById = new Map(
      candidateRows.map((upload) => [upload.id, upload.upload_status]),
    )
    const now = new Date().toISOString()
    const { data: uploads, error: updateError } = await this.admin
      .from('guest_clip_uploads')
      .update({
        upload_status: 'expired',
        deleted_at: now,
      })
      .in(
        'id',
        candidateRows.map((upload) => upload.id),
      )
      .in('upload_status', ['presigned', 'uploaded', 'failed'])
      .is('deleted_at', null)
      .select('id, storage_path, poster_storage_path, bucket_name, upload_status')
    if (updateError) throw updateError

    const claimedUploads = (uploads ?? []) as GuestClipUploadRow[]

    try {
      await this.removeStoredClipObjects(claimedUploads)
    } catch (error) {
      await Promise.all(
        claimedUploads.map((upload) =>
          this.admin
            .from('guest_clip_uploads')
            .update({
              upload_status: previousStatusById.get(upload.id) ?? 'presigned',
              deleted_at: null,
            })
            .eq('id', upload.id)
            .eq('upload_status', 'expired')
            .eq('deleted_at', now),
        ),
      )
      throw error
    }

    return { deleted: claimedUploads.length }
  }

  async cleanupStaleUserMedia(limit = 100) {
    const cutoff = new Date(
      Date.now() - SIGNED_UPLOAD_EXPIRES_SECONDS * 1000,
    ).toISOString()
    const [photosResult, clipsResult] = await Promise.all([
      this.admin
        .from('photos')
        .select('id, storage_path, bucket_name')
        .is('uploaded_at', null)
        .is('deleted_at', null)
        .lt('created_at', cutoff)
        .limit(limit),
      this.admin
        .from('clips')
        .select('id, storage_path, poster_storage_path, bucket_name')
        .is('uploaded_at', null)
        .is('deleted_at', null)
        .lt('created_at', cutoff)
        .limit(limit),
    ])

    if (photosResult.error) throw photosResult.error
    if (clipsResult.error) throw clipsResult.error

    const stalePhotos = (photosResult.data ?? []) as (StoredPhotoObjectRow & {
      id: string
    })[]
    const staleClips = (clipsResult.data ?? []) as (StoredClipObjectRow & {
      id: string
    })[]

    const photoClaimedAt = new Date().toISOString()
    const photoUpdate = stalePhotos.length
      ? await this.admin
          .from('photos')
          .update({ deleted_at: photoClaimedAt })
          .in(
            'id',
            stalePhotos.map((photo) => photo.id),
          )
          .is('uploaded_at', null)
          .is('deleted_at', null)
          .select('id, storage_path, bucket_name')
      : { data: [], error: null }

    if (photoUpdate.error) throw photoUpdate.error

    const photos = (photoUpdate.data ?? []) as (StoredPhotoObjectRow & {
      id: string
    })[]
    await this.deleteClaimedPhotos(photos, photoClaimedAt)

    const clipClaimedAt = new Date().toISOString()
    const clipUpdate = staleClips.length
      ? await this.admin
          .from('clips')
          .update({ deleted_at: clipClaimedAt })
          .in(
            'id',
            staleClips.map((clip) => clip.id),
          )
          .is('uploaded_at', null)
          .is('deleted_at', null)
          .select('id, storage_path, poster_storage_path, bucket_name')
      : { data: [], error: null }

    if (clipUpdate.error) throw clipUpdate.error

    const clips = (clipUpdate.data ?? []) as (StoredClipObjectRow & {
      id: string
    })[]
    await this.deleteClaimedClips(clips, clipClaimedAt)

    return { photos: photos.length, clips: clips.length }
  }

  private async deleteClaimedPhotos(
    photos: readonly (StoredPhotoObjectRow & { id: string })[],
    claimedAt: string,
  ) {
    try {
      await this.removeStoredPhotos(photos)
    } catch (error) {
      if (photos.length) {
        await this.admin
          .from('photos')
          .update({ deleted_at: null })
          .in(
            'id',
            photos.map((photo) => photo.id),
          )
          .is('uploaded_at', null)
          .eq('deleted_at', claimedAt)
      }
      throw error
    }
  }

  private async deleteClaimedClips(
    clips: readonly (StoredClipObjectRow & { id: string })[],
    claimedAt: string,
  ) {
    try {
      await this.removeStoredClipObjects(clips)
    } catch (error) {
      if (clips.length) {
        await this.admin
          .from('clips')
          .update({ deleted_at: null })
          .in(
            'id',
            clips.map((clip) => clip.id),
          )
          .is('uploaded_at', null)
          .eq('deleted_at', claimedAt)
      }
      throw error
    }
  }

  private async removeStoredPhotos(objects: readonly StoredPhotoObjectRow[]) {
    const r2ObjectsByBucket = new Map<string | null | undefined, string[]>()

    for (const object of objects) {
      const paths = r2ObjectsByBucket.get(object.bucket_name) ?? []
      paths.push(object.storage_path)
      r2ObjectsByBucket.set(object.bucket_name, paths)
    }

    await Promise.all(
      Array.from(r2ObjectsByBucket.entries()).map(([bucketName, paths]) =>
        this.r2.deleteObjects(paths, bucketName),
      ),
    )
  }

  private async removeStoredClipObjects(
    objects: readonly StoredClipObjectRow[],
  ) {
    const r2ObjectsByBucket = new Map<string | null | undefined, string[]>()

    for (const object of objects) {
      const paths = r2ObjectsByBucket.get(object.bucket_name) ?? []
      paths.push(
        ...[object.storage_path, object.poster_storage_path].filter(
          (path): path is string => Boolean(path),
        ),
      )
      r2ObjectsByBucket.set(object.bucket_name, paths)
    }

    await Promise.all(
      Array.from(r2ObjectsByBucket.entries()).map(([bucketName, paths]) =>
        this.r2.deleteObjects(paths, bucketName),
      ),
    )
  }

  private async getUserPhoto(photoId: string, userId: string) {
    const result = await this.admin
      .from('photos')
      .select(
        'id, user_id, board_id, position, cell_id, storage_path, storage_provider, bucket_name, object_etag, content_type, size_bytes, uploaded_at',
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
        'id, guest_session_id, client_board_session_id, mode, nickname, free_position, cell_ids, position, cell_id, storage_path, storage_provider, bucket_name, object_etag, content_type, size_bytes, uploaded_at, upload_status, expires_at',
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
        'id, user_id, board_id, position, cell_id, storage_path, poster_storage_path, storage_provider, bucket_name, object_etag, content_type, size_bytes, duration_ms, poster_content_type, poster_size_bytes, uploaded_at, description',
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
        'id, guest_session_id, client_board_session_id, mode, board_kind, nickname, title, description, clip_description, free_position, cell_ids, mission_snapshots, position, cell_id, storage_path, poster_storage_path, storage_provider, bucket_name, object_etag, poster_object_etag, content_type, size_bytes, duration_ms, poster_content_type, poster_size_bytes, uploaded_at, upload_status, expires_at',
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
      ...(('clip_description' in row ? row.clip_description : row.description)
        ? {
            description:
              'clip_description' in row
                ? row.clip_description
                : row.description,
          }
        : {}),
      ...requested,
    }
  }
}
