import { describe, expect, it } from 'vitest'

import { artworkSpecSchema } from '@/common/artwork.schemas'

describe('artworkSpecSchema', () => {
  it('parses lucide, swatch, and text artwork specs', () => {
    expect(
      artworkSpecSchema.parse({
        schemaVersion: 1,
        type: 'lucide',
        key: 'flower-2',
      }),
    ).toEqual({
      schemaVersion: 1,
      type: 'lucide',
      key: 'flower-2',
    })

    expect(
      artworkSpecSchema.parse({
        schemaVersion: 1,
        type: 'swatch',
        colorHex: '#22CC88',
        label: '초록',
      }),
    ).toMatchObject({ type: 'swatch', colorHex: '#22CC88' })

    expect(
      artworkSpecSchema.parse({
        schemaVersion: 1,
        type: 'text',
        label: '7',
        fontSize: 34,
      }),
    ).toMatchObject({ type: 'text', label: '7' })
  })

  it('parses remoteImage with an allowed HTTPS host and required fallback', () => {
    const parsed = artworkSpecSchema.parse({
      schemaVersion: 1,
      type: 'remoteImage',
      assetId: 'mission_squirrel_v1',
      url: 'https://assets.sappeun.app/mission-artwork/mission_squirrel_v1.abcdef123456.webp',
      contentHash:
        'sha256:abcdef123456abcdef123456abcdef123456abcdef123456abcdef123456abcd',
      mimeType: 'image/webp',
      width: 256,
      height: 256,
      fit: 'contain',
      fallback: {
        schemaVersion: 1,
        type: 'lucide',
        key: 'cat',
      },
    })

    expect(parsed.type).toBe('remoteImage')
  })

  it('rejects disallowed remoteImage hosts and overly deep fallbacks', () => {
    expect(() =>
      artworkSpecSchema.parse({
        schemaVersion: 1,
        type: 'remoteImage',
        assetId: 'bad',
        url: 'https://example.com/bad.webp',
        contentHash: 'sha256:abcdef123456',
        mimeType: 'image/webp',
        width: 256,
        height: 256,
        fallback: {
          schemaVersion: 1,
          type: 'lucide',
          key: 'cat',
        },
      }),
    ).toThrow()

    expect(() =>
      artworkSpecSchema.parse({
        schemaVersion: 1,
        type: 'remoteImage',
        assetId: 'one',
        url: 'https://assets.sappeun.app/one.webp',
        contentHash: 'sha256:abcdef123456',
        mimeType: 'image/webp',
        width: 256,
        height: 256,
        fallback: {
          schemaVersion: 1,
          type: 'remoteImage',
          assetId: 'two',
          url: 'https://assets.sappeun.app/two.webp',
          contentHash: 'sha256:abcdef123456',
          mimeType: 'image/webp',
          width: 256,
          height: 256,
          fallback: {
            schemaVersion: 1,
            type: 'remoteImage',
            assetId: 'three',
            url: 'https://assets.sappeun.app/three.webp',
            contentHash: 'sha256:abcdef123456',
            mimeType: 'image/webp',
            width: 256,
            height: 256,
            fallback: {
              schemaVersion: 1,
              type: 'lucide',
              key: 'cat',
            },
          },
        },
      }),
    ).toThrow()
  })
})
