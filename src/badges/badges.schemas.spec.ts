import { describe, expect, it } from 'vitest'

import {
  badgeCatalogItemSchema,
  badgeDifficultyFilterSchema,
  badgeStatusFilterSchema,
  userBadgesQuerySchema,
} from '@/badges/badges.schemas'

describe('badgeDifficultyFilterSchema', () => {
  it('accepts all valid difficulty values', () => {
    expect(badgeDifficultyFilterSchema.parse('easy')).toBe('easy')
    expect(badgeDifficultyFilterSchema.parse('medium')).toBe('medium')
    expect(badgeDifficultyFilterSchema.parse('hard')).toBe('hard')
    expect(badgeDifficultyFilterSchema.parse('all')).toBe('all')
  })

  it('rejects unknown difficulty values', () => {
    expect(badgeDifficultyFilterSchema.safeParse('expert').success).toBe(false)
    expect(badgeDifficultyFilterSchema.safeParse('').success).toBe(false)
    expect(badgeDifficultyFilterSchema.safeParse(null).success).toBe(false)
  })
})

describe('badgeStatusFilterSchema', () => {
  it('accepts all valid status values', () => {
    expect(badgeStatusFilterSchema.parse('earned')).toBe('earned')
    expect(badgeStatusFilterSchema.parse('locked')).toBe('locked')
    expect(badgeStatusFilterSchema.parse('all')).toBe('all')
  })

  it('rejects unknown status values', () => {
    expect(badgeStatusFilterSchema.safeParse('pending').success).toBe(false)
    expect(badgeStatusFilterSchema.safeParse('').success).toBe(false)
    expect(badgeStatusFilterSchema.safeParse(undefined).success).toBe(false)
  })
})

describe('userBadgesQuerySchema', () => {
  it('defaults difficulty and status to "all" when omitted', () => {
    expect(userBadgesQuerySchema.parse({})).toEqual({
      difficulty: 'all',
      status: 'all',
    })
  })

  it('accepts explicit valid values for both filters', () => {
    expect(
      userBadgesQuerySchema.parse({ difficulty: 'easy', status: 'earned' }),
    ).toEqual({ difficulty: 'easy', status: 'earned' })
  })

  it('accepts all combinations of difficulty and status', () => {
    expect(
      userBadgesQuerySchema.parse({ difficulty: 'hard', status: 'locked' }),
    ).toEqual({ difficulty: 'hard', status: 'locked' })
    expect(
      userBadgesQuerySchema.parse({ difficulty: 'medium', status: 'all' }),
    ).toEqual({ difficulty: 'medium', status: 'all' })
  })

  it('rejects an invalid difficulty value', () => {
    expect(
      userBadgesQuerySchema.safeParse({ difficulty: 'ultra' }).success,
    ).toBe(false)
  })

  it('rejects an invalid status value', () => {
    expect(userBadgesQuerySchema.safeParse({ status: 'unknown' }).success).toBe(
      false,
    )
  })

  it('rejects both invalid difficulty and status', () => {
    expect(
      userBadgesQuerySchema.safeParse({
        difficulty: 'legendary',
        status: 'pending',
      }).success,
    ).toBe(false)
  })
})

describe('badgeCatalogItemSchema', () => {
  it('accepts additive runtime artwork while preserving legacy artworkKey', () => {
    const parsed = badgeCatalogItemSchema.parse({
      badgeId: 'mission:n01:v1',
      missionId: 'n01',
      catalogVersion: 'api-migration-v1',
      title: '꽃',
      category: 'nature',
      difficulty: 'easy',
      gradeLabel: '일상 배지',
      gradeColor: '#6ED6A0',
      artworkKey: 'mission/n01',
      artwork: {
        schemaVersion: 1,
        type: 'lucide',
        key: 'flower-2',
      },
      sortOrder: 10,
    })

    expect(parsed.artwork).toMatchObject({ type: 'lucide', key: 'flower-2' })
    expect(parsed.artworkKey).toBe('mission/n01')
  })
})
