import { describe, expect, it, vi } from 'vitest'
import type { User } from '@supabase/supabase-js'

import { GroupMediaService } from '@/group-boards/group-media.service'

type QueryResult = { data: unknown; error: Error | null }
type RpcCall = { name: string; args: Record<string, unknown> }
type InsertCall = { table: string; payload: Record<string, unknown> }

function makeQuery(result: QueryResult, onInsert?: (payload: unknown) => void) {
  const query: Record<string, unknown> = {
    select: () => query,
    insert: (payload: unknown) => {
      onInsert?.(payload)
      return query
    },
    eq: () => query,
    is: () => query,
    order: () => query,
    limit: () => query,
    maybeSingle: () => Promise.resolve(result),
    then: (
      resolve: (value: QueryResult) => unknown,
      reject?: (error: unknown) => unknown,
    ) => Promise.resolve(result).then(resolve, reject),
  }
  return query
}

function makeAdmin(
  queues: Record<string, QueryResult[]>,
  rpcQueue: QueryResult[] = [],
  rpcCalls: RpcCall[] = [],
  insertCalls: InsertCall[] = [],
) {
  return {
    from(table: string) {
      const next = queues[table]?.shift()
      if (!next) throw new Error(`Unexpected table query: ${table}`)
      return makeQuery(next, (payload) => {
        insertCalls.push({ table, payload: payload as Record<string, unknown> })
      })
    },
    rpc(name: string, args: Record<string, unknown>) {
      rpcCalls.push({ name, args })
      const next = rpcQueue.shift()
      return Promise.resolve(next ?? { data: null, error: null })
    },
  }
}

const USER = { id: 'user-1' } as User
const NOW = new Date('2026-07-14T03:00:00.000Z')

const BOARD_ROW = {
  id: 'board-1',
  group_id: 'group-1',
  daily_date: '2026-07-14',
  mode: '3x3',
  seed_recipe: '{}',
  cell_ids: ['a', 'b', 'c', 'd', 'free', 'f', 'g', 'h', 'i'],
  free_position: 4,
  reroll_count: 0,
  first_media_at: null,
  created_by: 'user-1',
  created_at: NOW.toISOString(),
  updated_at: NOW.toISOString(),
  ended_at: null,
  end_reason: null,
  deleted_at: null,
}

function makeService(admin: ReturnType<typeof makeAdmin>) {
  const connections = { assertActiveGroupMember: vi.fn().mockResolvedValue({}) }
  const r2 = {
    groupPhotoKey: vi.fn().mockReturnValue('users/hash/group-boards/board-1/cells/0/photos/p.jpg'),
    groupClipKey: vi.fn().mockReturnValue('clip-key'),
    groupPosterKey: vi.fn().mockReturnValue('poster-key'),
    createSignedUpload: vi.fn().mockResolvedValue({
      bucketName: 'bucket',
      objectKey: 'key',
      signedUrl: 'https://upload',
      uploadHeaders: {},
    }),
    assertObjectMatches: vi.fn().mockResolvedValue({ etag: 'etag-1' }),
    createPreviewUrl: vi.fn().mockResolvedValue('https://preview'),
  }
  const clock = { now: () => NOW }
  const service = new GroupMediaService(
    { adminClient: admin } as never,
    connections as never,
    r2 as never,
    clock,
  )
  return { service, connections, r2 }
}

describe('GroupMediaService', () => {
  describe('presignGroupPhotoUpload', () => {
    it('inserts a photo with group_board_id and no board_id (XOR)', async () => {
      const insertCalls: InsertCall[] = []
      const admin = makeAdmin(
        {
          group_boards: [{ data: BOARD_ROW, error: null }],
          photos: [{ data: null, error: null }],
        },
        [],
        [],
        insertCalls,
      )
      const { service, connections } = makeService(admin)

      const result = await service.presignGroupPhotoUpload(USER, {
        groupId: 'group-1',
        position: 0,
        cellId: 'a',
        contentType: 'image/jpeg',
        sizeBytes: 1000,
      })

      expect(connections.assertActiveGroupMember).toHaveBeenCalledWith(
        'user-1',
        'group-1',
      )
      expect(insertCalls).toHaveLength(1)
      expect(insertCalls[0].payload).toMatchObject({
        board_id: null,
        group_board_id: 'board-1',
        position: 0,
        cell_id: 'a',
      })
      expect(result.photoId).toBeTruthy()
      expect(result.ownerKind).toBe('user')
    })

    it('rejects a stale cellId with 400', async () => {
      const admin = makeAdmin({
        group_boards: [{ data: BOARD_ROW, error: null }],
      })
      const { service } = makeService(admin)

      await expect(
        service.presignGroupPhotoUpload(USER, {
          groupId: 'group-1',
          position: 0,
          cellId: 'stale-cell',
          contentType: 'image/jpeg',
          sizeBytes: 1000,
        }),
      ).rejects.toMatchObject({ status: 400 })
    })

    it('rejects uploads to the free center cell with 400', async () => {
      const admin = makeAdmin({
        group_boards: [{ data: BOARD_ROW, error: null }],
      })
      const { service } = makeService(admin)

      // cell_ids[4] === 'free' and free_position === 4, so the cellId check
      // alone would pass — the dedicated free-cell guard must reject it.
      await expect(
        service.presignGroupPhotoUpload(USER, {
          groupId: 'group-1',
          position: 4,
          cellId: 'free',
          contentType: 'image/jpeg',
          sizeBytes: 1000,
        }),
      ).rejects.toMatchObject({ status: 400 })
    })

    it('rejects uploads to an ended board with 409', async () => {
      const admin = makeAdmin({
        group_boards: [
          {
            data: { ...BOARD_ROW, ended_at: NOW.toISOString() },
            error: null,
          },
        ],
      })
      const { service } = makeService(admin)

      await expect(
        service.presignGroupPhotoUpload(USER, {
          groupId: 'group-1',
          position: 0,
          cellId: 'a',
          contentType: 'image/jpeg',
          sizeBytes: 1000,
        }),
      ).rejects.toMatchObject({ status: 409 })
    })
  })

  describe('confirmGroupPhotoUpload', () => {
    const PHOTO_ROW = {
      id: 'photo-1',
      user_id: 'user-1',
      group_board_id: 'board-1',
      position: 0,
      cell_id: 'a',
      storage_path: 'path/p.jpg',
      bucket_name: 'bucket',
      content_type: 'image/jpeg',
      size_bytes: 1000,
      uploaded_at: null,
    }

    it('calls confirm_group_photo_upload with the R2 etag', async () => {
      const rpcCalls: RpcCall[] = []
      const admin = makeAdmin(
        {
          photos: [{ data: PHOTO_ROW, error: null }],
          group_boards: [
            { data: { id: 'board-1', group_id: 'group-1' }, error: null },
          ],
        },
        [{ data: null, error: null }],
        rpcCalls,
      )
      const { service } = makeService(admin)

      const result = await service.confirmGroupPhotoUpload(USER, {
        groupId: 'group-1',
        photoId: 'photo-1',
      })

      expect(rpcCalls[0]).toMatchObject({
        name: 'confirm_group_photo_upload',
        args: {
          p_photo_id: 'photo-1',
          p_user_id: 'user-1',
          p_object_etag: 'etag-1',
        },
      })
      expect(result.previewUrl).toBe('https://preview')
    })

    it('maps CELL_MISMATCH to 409 (presign→confirm reroll race)', async () => {
      const admin = makeAdmin(
        {
          photos: [{ data: PHOTO_ROW, error: null }],
          group_boards: [
            { data: { id: 'board-1', group_id: 'group-1' }, error: null },
          ],
        },
        [{ data: null, error: new Error('CELL_MISMATCH') }],
      )
      const { service } = makeService(admin)

      await expect(
        service.confirmGroupPhotoUpload(USER, {
          groupId: 'group-1',
          photoId: 'photo-1',
        }),
      ).rejects.toMatchObject({ status: 409 })
    })

    it('404s when the photo belongs to another group board', async () => {
      const admin = makeAdmin({
        photos: [{ data: PHOTO_ROW, error: null }],
        group_boards: [
          { data: { id: 'board-1', group_id: 'other-group' }, error: null },
        ],
      })
      const { service } = makeService(admin)

      await expect(
        service.confirmGroupPhotoUpload(USER, {
          groupId: 'group-1',
          photoId: 'photo-1',
        }),
      ).rejects.toMatchObject({ status: 404 })
    })
  })
})
