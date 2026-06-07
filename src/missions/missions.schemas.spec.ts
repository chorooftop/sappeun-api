import { describe, expect, it } from 'vitest'

import {
  missionContentResponseSchema,
  type MissionContentResponse,
} from '@/missions/missions.schemas'

describe('missionContentResponseSchema', () => {
  it('parses a representative response round-trip', () => {
    const response: MissionContentResponse = {
      version: '1.3.0',
      updatedAt: '2026-05-14',
      totalCells: 2,
      categories: {
        nature: { label: '자연·식물', count: 8, tone: 'brand-primary' },
        color: { label: '색깔', count: 8, tone: 'cat-color' },
      },
      cells: [
        {
          id: 'n01',
          category: 'nature',
          label: '꽃',
          hint: '길가에서 꽃을 찾아요',
          icon: 'flower-2',
          variant: 'QeQCU',
          artwork: {
            schemaVersion: 1,
            type: 'lucide',
            key: 'flower-2',
          },
        },
        {
          id: 'c01',
          category: 'color',
          label: '빨간색',
          caption: '색 찾기',
          captureLabel: '빨간색',
          icon: null,
          variant: 'QeQCU',
          swatch: 'red',
          swatchLabel: '빨강',
        },
      ],
    }

    const parsed = missionContentResponseSchema.parse(response)
    expect(parsed).toEqual(response)
  })

  it('accepts a null icon and rejects a missing icon key', () => {
    const base = {
      id: 'n01',
      category: 'nature',
      label: '꽃',
      icon: null as string | null,
      variant: 'QeQCU',
    }

    expect(() =>
      missionContentResponseSchema.shape.cells.element.parse(base),
    ).not.toThrow()

    const withoutIcon: Record<string, unknown> = { ...base }
    delete withoutIcon.icon
    expect(() =>
      missionContentResponseSchema.shape.cells.element.parse(withoutIcon),
    ).toThrow()
  })
})
