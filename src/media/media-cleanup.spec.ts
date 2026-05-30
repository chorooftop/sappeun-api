import { describe, expect, it, vi } from 'vitest'

import { MediaService } from '@/media/media.service'

type QueryResult = {
  data: unknown[] | null
  error: Error | null
}

type QueryEvent =
  | { type: 'from'; table: string }
  | { type: 'update'; label: string; payload: unknown }
  | {
      type: 'resolve'
      label: string
      filters: [string, string, unknown][]
      payload: unknown
    }
  | { type: 'r2-delete'; paths: string[]; bucketName: string | null | undefined }

function makeQuery(
  label: string,
  result: QueryResult,
  events: QueryEvent[],
) {
  const filters: [string, string, unknown][] = []
  let payload: unknown

  const query = {
    select() {
      return query
    },
    in(column: string, value: unknown) {
      filters.push(['in', column, value])
      return query
    },
    lt(column: string, value: unknown) {
      filters.push(['lt', column, value])
      return query
    },
    lte(column: string, value: unknown) {
      filters.push(['lte', column, value])
      return query
    },
    is(column: string, value: unknown) {
      filters.push(['is', column, value])
      return query
    },
    limit(value: unknown) {
      filters.push(['limit', 'limit', value])
      return query
    },
    update(value: unknown) {
      payload = value
      events.push({ type: 'update', label, payload: value })
      return query
    },
    eq(column: string, value: unknown) {
      filters.push(['eq', column, value])
      return query
    },
    then(resolve: (value: QueryResult) => unknown, reject?: (error: unknown) => unknown) {
      events.push({ type: 'resolve', label, filters, payload })
      return Promise.resolve(result).then(resolve, reject)
    },
  }

  return query
}

function makeAdmin(
  queues: Record<string, ReturnType<typeof makeQuery>[]>,
  events: QueryEvent[],
) {
  return {
    from(table: string) {
      const query = queues[table]?.shift()
      if (!query) throw new Error(`Unexpected table query: ${table}`)
      events.push({ type: 'from', table })
      return query
    },
  }
}

describe('MediaService cleanup', () => {
  it('rolls back expired guest photo claims when R2 deletion fails', async () => {
    const events: QueryEvent[] = []
    const r2Error = new Error('R2 unavailable')
    const admin = makeAdmin(
      {
        guest_photo_uploads: [
          makeQuery(
            'select-candidates',
            {
              data: [
                {
                  id: 'photo-1',
                  storage_path: 'guest/photo-1.jpg',
                  bucket_name: 'bucket-a',
                  upload_status: 'uploaded',
                },
              ],
              error: null,
            },
            events,
          ),
          makeQuery(
            'claim-expired',
            {
              data: [
                {
                  id: 'photo-1',
                  storage_path: 'guest/photo-1.jpg',
                  bucket_name: 'bucket-a',
                  upload_status: 'expired',
                },
              ],
              error: null,
            },
            events,
          ),
          makeQuery('rollback-expired', { data: [], error: null }, events),
        ],
      },
      events,
    )
    const r2 = {
      deleteObjects: vi.fn((paths: string[], bucketName?: string | null) => {
        events.push({ type: 'r2-delete', paths, bucketName })
        throw r2Error
      }),
    }
    const service = new MediaService(
      {} as any,
      r2 as any,
      { adminClient: admin } as any,
    )

    await expect(service.cleanupExpiredGuestPhotos()).rejects.toThrow(r2Error)

    const updates = events.filter((event) => event.type === 'update')
    expect(updates).toEqual([
      {
        type: 'update',
        label: 'claim-expired',
        payload: expect.objectContaining({
          upload_status: 'expired',
        }),
      },
      {
        type: 'update',
        label: 'rollback-expired',
        payload: {
          upload_status: 'uploaded',
          deleted_at: null,
        },
      },
    ])
    expect(events.find((event) => event.type === 'r2-delete')).toEqual({
      type: 'r2-delete',
      paths: ['guest/photo-1.jpg'],
      bucketName: 'bucket-a',
    })
  })
})
