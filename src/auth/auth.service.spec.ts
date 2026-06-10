import { UnauthorizedException } from '@nestjs/common'
import { describe, expect, it } from 'vitest'

import { AuthService } from '@/auth/auth.service'

describe('AuthService.requireUser', () => {
  it('rejects requests without a bearer token', async () => {
    const service = new AuthService({} as never)

    await expect(
      service.requireUser({ headers: {} } as never),
    ).rejects.toBeInstanceOf(UnauthorizedException)
  })
})
