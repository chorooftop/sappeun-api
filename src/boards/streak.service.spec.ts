import { describe, expect, it } from 'vitest'

import { StreakService } from '@/boards/streak.service'
import { previousKstDate } from '@/common/time/kst'

type QueryResult = { data: unknown; error: Error | null }

function makeQuery(result: QueryResult) {
  const query: Record<string, unknown> = {
    select: () => query,
    eq: () => query,
    is: () => query,
    not: () => query,
    lte: () => query,
    order: () => query,
    limit: () => query,
    then: (
      resolve: (value: QueryResult) => unknown,
      reject?: (error: unknown) => unknown,
    ) => Promise.resolve(result).then(resolve, reject),
  }
  return query
}

function makeService(
  personalDates: string[],
  groupDates: string[],
): StreakService {
  const admin = {
    from(table: string) {
      if (table === 'boards') {
        return makeQuery({
          data: personalDates.map((daily_date) => ({ daily_date })),
          error: null,
        })
      }
      if (table === 'group_board_completion_dates') {
        return makeQuery({
          data: groupDates.map((daily_date) => ({ daily_date })),
          error: null,
        })
      }
      throw new Error(`Unexpected table query: ${table}`)
    },
  }
  return new StreakService({ adminClient: admin } as never)
}

/**
 * The exact pre-group algorithm from BoardsService.computeStreakEndingAt
 * (boards.service.ts:846-870): walk rows as returned (desc), break on the
 * first date that misses the expected chain.
 */
function legacyPersonalStreak(dates: string[], endingAt: string) {
  let expected = endingAt
  let streak = 0
  for (const date of dates) {
    if (date !== expected) break
    streak += 1
    expected = previousKstDate(expected)
  }
  return streak
}

describe('StreakService (solo golden — AC-15)', () => {
  const CASES: { name: string; dates: string[]; endingAt: string }[] = [
    { name: 'empty history', dates: [], endingAt: '2026-07-14' },
    {
      name: 'single completion today',
      dates: ['2026-07-14'],
      endingAt: '2026-07-14',
    },
    {
      name: 'unbroken 5-day run',
      dates: ['2026-07-14', '2026-07-13', '2026-07-12', '2026-07-11', '2026-07-10'],
      endingAt: '2026-07-14',
    },
    {
      name: 'gap breaks the chain',
      dates: ['2026-07-14', '2026-07-12', '2026-07-11'],
      endingAt: '2026-07-14',
    },
    {
      name: 'history not ending today',
      dates: ['2026-07-10', '2026-07-09'],
      endingAt: '2026-07-14',
    },
    {
      name: 'month boundary',
      dates: ['2026-07-01', '2026-06-30', '2026-06-29'],
      endingAt: '2026-07-01',
    },
  ]

  for (const testCase of CASES) {
    it(`matches the legacy personal-only algorithm: ${testCase.name}`, async () => {
      const service = makeService(testCase.dates, [])
      await expect(
        service.computeStreakEndingAt('user-1', testCase.endingAt),
      ).resolves.toBe(legacyPersonalStreak(testCase.dates, testCase.endingAt))
    })
  }
})

describe('StreakService (group union — AC-11/AC-14)', () => {
  it('deduplicates a personal + group completion on the same day', async () => {
    const service = makeService(
      ['2026-07-14', '2026-07-13'],
      ['2026-07-14', '2026-07-12'],
    )
    // 14(양쪽), 13(개인), 12(그룹) → 연속 3일. 중복 14가 2행이어도 1일로 계산.
    await expect(
      service.computeStreakEndingAt('user-1', '2026-07-14'),
    ).resolves.toBe(3)
  })

  it('counts group-only completion days', async () => {
    const service = makeService([], ['2026-07-14', '2026-07-13'])
    await expect(
      service.computeStreakEndingAt('user-1', '2026-07-14'),
    ).resolves.toBe(2)
  })

  it('bridges a personal gap with a group completion', async () => {
    const service = makeService(
      ['2026-07-14', '2026-07-12'],
      ['2026-07-13'],
    )
    await expect(
      service.computeStreakEndingAt('user-1', '2026-07-14'),
    ).resolves.toBe(3)
  })

  it('still breaks on a genuine gap across both sources', async () => {
    const service = makeService(['2026-07-14'], ['2026-07-11'])
    await expect(
      service.computeStreakEndingAt('user-1', '2026-07-14'),
    ).resolves.toBe(1)
  })
})
