import { describe, expect, it } from 'vitest'

import { normalizeGuestSessionId } from '@/auth/auth.service'

describe('normalizeGuestSessionId', () => {
  it('trims valid UUID guest session ids', () => {
    expect(
      normalizeGuestSessionId(' 018f7d38-0dd4-4d77-981e-36e85f0b2a42 '),
    ).toBe('018f7d38-0dd4-4d77-981e-36e85f0b2a42')
  })

  it('rejects non-UUID ids', () => {
    expect(normalizeGuestSessionId('guest_local_identity')).toBeNull()
  })
})
