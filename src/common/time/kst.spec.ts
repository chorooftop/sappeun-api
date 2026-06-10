import { describe, expect, it } from 'vitest'

import {
  computeLifecycle,
  kstDateOf,
  kstGraceUntil,
  previousKstDate,
} from '@/common/time/kst'

describe('KST daily bingo time helpers', () => {
  it('derives the service day using a fixed KST offset', () => {
    expect(kstDateOf(new Date('2026-06-09T14:59:59.999Z'))).toBe('2026-06-09')
    expect(kstDateOf(new Date('2026-06-09T15:00:00.000Z'))).toBe('2026-06-10')
  })

  it('computes grace until KST next-day 01:00 as UTC', () => {
    expect(kstGraceUntil('2026-06-10').toISOString()).toBe(
      '2026-06-10T16:00:00.000Z',
    )
  })

  it('uses active, grace, and expired boundaries precisely', () => {
    expect(
      computeLifecycle('2026-06-10', new Date('2026-06-10T14:59:59.999Z'))
        .state,
    ).toBe('active')
    expect(
      computeLifecycle('2026-06-10', new Date('2026-06-10T15:00:00.000Z'))
        .state,
    ).toBe('grace')
    expect(
      computeLifecycle('2026-06-10', new Date('2026-06-10T15:59:59.999Z'))
        .state,
    ).toBe('grace')
    expect(
      computeLifecycle('2026-06-10', new Date('2026-06-10T16:00:00.000Z'))
        .state,
    ).toBe('expired')
  })

  it('walks to the previous KST date', () => {
    expect(previousKstDate('2026-06-01')).toBe('2026-05-31')
  })
})
