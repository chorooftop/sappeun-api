import { describe, expect, it, vi } from 'vitest'

import { HealthController } from '@/health/health.controller'

describe('HealthController', () => {
  it('keeps existing fields and adds runtime metadata', () => {
    const controller = new HealthController({
      get: vi.fn(() => 'production'),
    } as never)

    const result = controller.getHealth()

    expect(result).toMatchObject({
      ok: true,
      service: 'sappeun-api',
      nodeEnv: 'production',
    })
    expect(result.timestamp).toEqual(expect.any(String))
    expect(result.uptimeSec).toEqual(expect.any(Number))
  })

  it('includes commitSha when Render exposes a commit env var', () => {
    vi.stubEnv('RENDER_GIT_COMMIT', 'abc123')
    const controller = new HealthController({
      get: vi.fn(() => 'production'),
    } as never)

    expect(controller.getHealth()).toMatchObject({
      commitSha: 'abc123',
    })

    vi.unstubAllEnvs()
  })
})
