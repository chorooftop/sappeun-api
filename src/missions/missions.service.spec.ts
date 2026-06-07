import { describe, expect, it } from 'vitest'

import { MissionsService } from '@/missions/missions.service'

type QueryResult = {
  data: unknown
  error: Error | null
}

function makeQuery(result: QueryResult) {
  const query: Record<string, unknown> = {
    select: () => query,
    eq: () => query,
    order: () => query,
    then: (
      resolve: (value: QueryResult) => unknown,
      reject?: (error: unknown) => unknown,
    ) => Promise.resolve(result).then(resolve, reject),
  }
  return query
}

function makeAdmin(queues: Record<string, QueryResult[]>) {
  return {
    from(table: string) {
      const next = queues[table]?.shift()
      if (!next) throw new Error(`Unexpected table query: ${table}`)
      return makeQuery(next)
    },
  }
}

function makeService(admin: ReturnType<typeof makeAdmin>) {
  return new MissionsService({ adminClient: admin } as never)
}

function contentRow(overrides: Record<string, unknown> = {}) {
  return {
    mission_id: 'n01',
    label: '꽃',
    category: 'nature',
    hint: '길가에서 꽃을 찾아요',
    caption: null,
    capture_label: null,
    icon: 'flower-2',
    variant: 'QeQCU',
    difficulty: null,
    camera: null,
    text_only: null,
    font_size: null,
    swatch: null,
    swatch_label: null,
    no_photo: null,
    fixed_position: null,
    artwork: null,
    min_app_build: null,
    required_capabilities: [],
    active_from: null,
    active_until: null,
    sort_order: 0,
    ...overrides,
  }
}

describe('MissionsService.getMissionContent', () => {
  it('maps snake_case rows to camelCase cells and assembles the response', async () => {
    const admin = makeAdmin({
      mission_content: [
        {
          data: [
            contentRow(),
            contentRow({
              mission_id: 't01',
              label: '7',
              category: 'time',
              hint: null,
              caption: '숫자 찾기',
              capture_label: '숫자 7',
              icon: null,
              text_only: true,
              font_size: 34,
              sort_order: 10,
            }),
            contentRow({
              mission_id: 'c01',
              label: '빨간색',
              category: 'color',
              caption: '색 찾기',
              capture_label: '빨간색',
              icon: null,
              swatch: 'red',
              swatch_label: '빨강',
              sort_order: 20,
            }),
          ],
          error: null,
        },
      ],
      mission_categories: [
        {
          data: [
            {
              key: 'nature',
              label: '자연·식물',
              tone: 'brand-primary',
              count: 8,
            },
            {
              key: 'time',
              label: '시간·숫자',
              tone: 'brand-primary',
              count: 6,
            },
            { key: 'color', label: '색깔', tone: 'cat-color', count: 8 },
          ],
          error: null,
        },
      ],
    })

    const result = await makeService(admin).getMissionContent()

    expect(result.totalCells).toBe(3)
    expect(result.version).toBe('1.3.0')
    expect(result.updatedAt).toBe('2026-05-14')

    expect(result.cells[0]).toEqual({
      id: 'n01',
      category: 'nature',
      label: '꽃',
      hint: '길가에서 꽃을 찾아요',
      icon: 'flower-2',
      variant: 'QeQCU',
    })

    expect(result.cells[1]).toEqual({
      id: 't01',
      category: 'time',
      label: '7',
      caption: '숫자 찾기',
      captureLabel: '숫자 7',
      icon: null,
      variant: 'QeQCU',
      textOnly: true,
      fontSize: 34,
    })

    expect(result.cells[2]).toMatchObject({
      id: 'c01',
      swatch: 'red',
      swatchLabel: '빨강',
      icon: null,
    })

    expect(result.categories).toEqual({
      nature: { label: '자연·식물', count: 1, tone: 'brand-primary' },
      time: { label: '시간·숫자', count: 1, tone: 'brand-primary' },
      color: { label: '색깔', count: 1, tone: 'cat-color' },
    })
  })

  it('preserves a null icon as null rather than dropping the key', async () => {
    const admin = makeAdmin({
      mission_content: [{ data: [contentRow({ icon: null })], error: null }],
      mission_categories: [{ data: [], error: null }],
    })

    const result = await makeService(admin).getMissionContent()

    expect(result.cells[0]).toHaveProperty('icon', null)
  })

  it('adds runtime artwork when the DB row provides a valid spec', async () => {
    const admin = makeAdmin({
      mission_content: [
        {
          data: [
            contentRow({
              artwork: {
                schemaVersion: 1,
                type: 'lucide',
                key: 'flower-2',
                paletteMode: 'mono',
              },
            }),
          ],
          error: null,
        },
      ],
      mission_categories: [{ data: [], error: null }],
    })

    const result = await makeService(admin).getMissionContent()

    expect(result.cells[0]).toMatchObject({
      id: 'n01',
      artwork: {
        schemaVersion: 1,
        type: 'lucide',
        key: 'flower-2',
        paletteMode: 'mono',
      },
    })
  })

  it('filters gated rows unless the client advertises the required capabilities', async () => {
    const rows = [
      contentRow({ mission_id: 'n01', sort_order: 0 }),
      contentRow({
        mission_id: 'new-remote',
        sort_order: 10,
        required_capabilities: ['runtime-artwork-v1'],
        min_app_build: 202606080001,
      }),
    ]

    const legacyAdmin = makeAdmin({
      mission_content: [{ data: rows, error: null }],
      mission_categories: [{ data: [], error: null }],
    })
    const legacy = await makeService(legacyAdmin).getMissionContent()
    expect(legacy.cells.map((cell) => cell.id)).toEqual(['n01'])
    expect(legacy.categories).toEqual({})

    const runtimeAdmin = makeAdmin({
      mission_content: [{ data: rows, error: null }],
      mission_categories: [{ data: [], error: null }],
    })
    const runtime = await makeService(runtimeAdmin).getMissionContent(
      undefined,
      {
        appBuild: 202606080001,
        capabilities: new Set(['runtime-artwork-v1']),
      },
    )

    expect(runtime.cells.map((cell) => cell.id)).toEqual(['n01', 'new-remote'])
  })

  it('returns an empty payload when there is no content', async () => {
    const admin = makeAdmin({
      mission_content: [{ data: [], error: null }],
      mission_categories: [{ data: [], error: null }],
    })

    const result = await makeService(admin).getMissionContent()

    expect(result.totalCells).toBe(0)
    expect(result.cells).toEqual([])
    expect(result.categories).toEqual({})
  })

  it('throws when the content query errors', async () => {
    const admin = makeAdmin({
      mission_content: [{ data: null, error: new Error('boom') }],
      mission_categories: [{ data: [], error: null }],
    })

    await expect(makeService(admin).getMissionContent()).rejects.toThrow('boom')
  })
})
