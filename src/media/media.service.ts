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

function assertUserForOwnerKind(user: User | null): asserts user is User {
  if (!user) {
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
    guestSessionId: string | null
  }) {
    const { input, user } = params
    if (!user) {
      throw new UnauthorizedException('Authentication required.')
    }
    const photoId = randomUUID()
    const ext = photoExtFromContentType(input.contentType)
    const boardId = await this.boardsService.ensureUserBoardForMedia(
      user.id,
      input,
    )
    const objectKey = this.r2.userPhotoKey({
      userId: user.id,
      boardId: boardId ?? '',
      position: input.position,
      id: photoId,
      ext,
    })
    const upload = await this.r2.createSignedUpload({
      objectKey,
      contentType: input.contentType,
      expiresInSeconds: SIGNED_UPLOAD_EXPIRES_SECONDS,
    })

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

    return {
      ...uploadPayload(upload),
      photoId,
      ownerKind: 'user' satisfies OwnerKind,
      expiresAt: signedUrlExpiresAt(SIGNED_UPLOAD_EXPIRES_SECONDS),
    }
  }

  async confirmPhotoUpload(params: {
    input: ConfirmPhotoUploadInput
    user: User | null
    guestSessionId: string | null
  }) {
    const { input, user } = params
    assertUserForOwnerKind(user)

    const row = await this.getUserPhoto(input.photoId, user.id)

    const metadata = await this.r2.assertObjectMatches(
      { objectKey: row.storage_path, bucketName: row.bucket_name },
      { contentType: row.content_type, sizeBytes: Number(row.size_bytes) },
    )
    const now = new Date().toISOString()

    if (!row.board_id || row.position === null || !row.cell_id) {
      throw new BadRequestException('Photo is missing board metadata.')
    }

    const { error: confirmError } = await this.admin.rpc(
      'confirm_user_photo_upload',
      {
        p_photo_id: row.id,
        p_user_id: user.id,
        p_object_etag: metadata.etag,
        p_confirmed_at: now,
      },
    )
    if (confirmError) throw confirmError

    return this.photoPreviewPayload(row, input.ownerKind)
  }

  async createPhotoPreviewUrls(params: {
    input: PhotoPreviewInput
    user: User | null
    guestSessionId: string | null
  }) {
    assertUserForOwnerKind(params.user)
    const user = params.user
    const photos = await Promise.all(
      params.input.photos.map(async (photo) => {
        const row = await this.getUserPhoto(photo.photoId, user.id)
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
    assertUserForOwnerKind(params.user)
    const row = await this.getUserPhoto(params.photoId, params.user.id)

    await this.r2.deleteObjects([row.storage_path], row.bucket_name)
    const now = new Date().toISOString()

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
    if (row.board_id) {
      await this.boardsService.touchUserBoard(row.board_id)
    }

    return { ok: true }
  }

  async prepareClipUpload(params: {
    input: PresignClipUploadInput
    user: User | null
    guestSessionId: string | null
  }) {
    const { input, user } = params
    if (!user) {
      throw new UnauthorizedException('Authentication required.')
    }
    const clipId = randomUUID()
    const clipExt = clipExtFromContentType(input.contentType)
    const posterExt = posterExtFromContentType(input.posterContentType)
    const boardId = await this.boardsService.ensureUserBoardForMedia(
      user.id,
      input,
    )
    const clipKey = this.r2.userClipKey({
      userId: user.id,
      boardId: boardId ?? '',
      position: input.position,
      id: clipId,
      ext: clipExt,
    })
    const posterKey = this.r2.userPosterKey({
      userId: user.id,
      boardId: boardId ?? '',
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

    return {
      clipId,
      ownerKind: 'user' satisfies OwnerKind,
      clip: uploadPayload(clipUpload),
      poster: uploadPayload(posterUpload),
      expiresAt: signedUrlExpiresAt(SIGNED_UPLOAD_EXPIRES_SECONDS),
    }
  }

  async confirmClipUpload(params: {
    input: ConfirmClipUploadInput
    user: User | null
    guestSessionId: string | null
  }) {
    const { input, user } = params
    assertUserForOwnerKind(user)
    const row = await this.getUserClip(input.clipId, user.id)

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

    if (!row.board_id || row.position === null || !row.cell_id) {
      throw new BadRequestException('Clip is missing board metadata.')
    }

    const { error: confirmError } = await this.admin.rpc(
      'confirm_user_clip_upload',
      {
        p_clip_id: row.id,
        p_user_id: user.id,
        p_object_etag: clipMetadata.etag,
        p_poster_object_etag: posterMetadata.etag,
        p_confirmed_at: now,
      },
    )
    if (confirmError) throw confirmError

    return this.clipPreviewPayload(row, input.ownerKind)
  }

  async createClipPreviewUrls(params: {
    input: ClipPreviewInput
    user: User | null
    guestSessionId: string | null
  }) {
    assertUserForOwnerKind(params.user)
    const user = params.user
    const clips = await Promise.all(
      params.input.clips.map(async (clip) => {
        const row = await this.getUserClip(clip.clipId, user.id)
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
    assertUserForOwnerKind(params.user)
    const description = params.input.description?.trim() || null
    const row = await this.getUserClip(params.clipId, params.user.id)

    const { error } = await this.admin
      .from('clips')
      .update({ description })
      .eq('id', row.id)
    if (error) throw error

    if (!row.board_id) {
      throw new BadRequestException('Clip is missing board metadata.')
    }
    await this.boardsService.touchUserBoard(row.board_id)

    return { ok: true }
  }

  async deleteClip(params: {
    clipId: string
    ownerKind: OwnerKind
    user: User | null
    guestSessionId: string | null
  }) {
    assertUserForOwnerKind(params.user)
    const row = await this.getUserClip(params.clipId, params.user.id)
    const keys = [row.storage_path, row.poster_storage_path].filter(
      (key): key is string => Boolean(key),
    )

    await this.r2.deleteObjects(keys, row.bucket_name)
    const now = new Date().toISOString()

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
    if (row.board_id) {
      await this.boardsService.touchUserBoard(row.board_id)
    }

    return { ok: true }
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
      .select(
        'id, storage_path, poster_storage_path, bucket_name, upload_status',
      )
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
      // Group-board media must go through the group endpoints: deleting it
      // here would leave the live group_board_cell_media row dangling.
      .is('group_board_id', null)
      .is('deleted_at', null)
      .single()
    const data = result.data as PhotoRow | null
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
      // Group-board media must go through the group endpoints (see
      // getUserPhoto) — also prevents the write-then-400 description update.
      .is('group_board_id', null)
      .is('deleted_at', null)
      .single()
    const data = result.data as ClipRow | null
    const error = result.error

    if (error || !data) throw new NotFoundException('Clip not found.')
    return data
  }

  private async photoPreviewPayload(
    row: PhotoRow,
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
    row: ClipRow,
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
