import { describe, expect, it } from 'vitest'

import { createR2OwnerHash } from '@/storage/r2.service'

describe('createR2OwnerHash', () => {
  it('creates a stable 32 character hash for object prefixes', () => {
    const hash = createR2OwnerHash('0123456789abcdef', 'user', 'user-id')

    expect(hash).toHaveLength(32)
    expect(hash).toBe(createR2OwnerHash('0123456789abcdef', 'user', 'user-id'))
    expect(hash).not.toBe(
      createR2OwnerHash('0123456789abcdef', 'guest', 'user-id'),
    )
  })
})
