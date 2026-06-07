import { describe, expect, it } from 'vitest'

import {
  isVisibleToClient,
  parseClientCapabilities,
} from '@/common/client-capabilities'

describe('parseClientCapabilities', () => {
  it('treats absent headers as a legacy client', () => {
    const parsed = parseClientCapabilities({})

    expect(parsed.appBuild).toBeNull()
    expect([...parsed.capabilities]).toEqual([])
  })

  it('parses app build and comma-separated capability headers', () => {
    const parsed = parseClientCapabilities({
      'x-sappeun-app-build': '202606080001',
      'x-sappeun-client-capabilities': 'runtime-artwork-v1, swatch-hex-v1',
    })

    expect(parsed.appBuild).toBe(202606080001)
    expect([...parsed.capabilities]).toEqual([
      'runtime-artwork-v1',
      'swatch-hex-v1',
    ])
  })

  it('degrades invalid headers to legacy client metadata', () => {
    const parsed = parseClientCapabilities({
      'x-sappeun-app-build': 'not-a-build',
      'x-sappeun-client-capabilities': 'runtime-artwork-v1',
    })

    expect(parsed.appBuild).toBeNull()
    expect([...parsed.capabilities]).toEqual([])
  })

  it('parses app build without capabilities', () => {
    const buildOnly = parseClientCapabilities({
      'x-sappeun-app-build': '202606080001',
    })

    expect(buildOnly.appBuild).toBe(202606080001)
    expect([...buildOnly.capabilities]).toEqual([])
  })

  it('parses capabilities without app build', () => {
    const capabilitiesOnly = parseClientCapabilities({
      'x-sappeun-client-capabilities': 'runtime-artwork-v1',
    })

    expect(capabilitiesOnly.appBuild).toBeNull()
    expect([...capabilitiesOnly.capabilities]).toEqual(['runtime-artwork-v1'])
  })

  it('degrades blank metadata headers to legacy client metadata', () => {
    const parsed = parseClientCapabilities({
      'x-sappeun-app-build': '202606080001',
      'x-sappeun-client-capabilities': '   ',
    })

    expect(parsed.appBuild).toBeNull()
    expect([...parsed.capabilities]).toEqual([])
  })
})

describe('isVisibleToClient', () => {
  const runtimeClient = parseClientCapabilities({
    'x-sappeun-app-build': '202606080001',
    'x-sappeun-client-capabilities': 'runtime-artwork-v1,swatch-hex-v1',
  })

  it('allows ungated rows to legacy clients', () => {
    expect(
      isVisibleToClient(
        { min_app_build: null, required_capabilities: [] },
        parseClientCapabilities({}),
      ),
    ).toBe(true)
  })

  it('hides capability-gated rows from legacy clients', () => {
    expect(
      isVisibleToClient(
        { required_capabilities: ['runtime-artwork-v1'] },
        parseClientCapabilities({}),
      ),
    ).toBe(false)
  })

  it('allows rows when build and capabilities satisfy the gate', () => {
    expect(
      isVisibleToClient(
        {
          min_app_build: 202606080000,
          required_capabilities: ['runtime-artwork-v1'],
        },
        runtimeClient,
      ),
    ).toBe(true)
  })

  it('allows capability-only rows without app build', () => {
    expect(
      isVisibleToClient(
        { required_capabilities: ['runtime-artwork-v1'] },
        parseClientCapabilities({
          'x-sappeun-client-capabilities': 'runtime-artwork-v1',
        }),
      ),
    ).toBe(true)
  })

  it('keeps build-gated rows hidden without app build', () => {
    expect(
      isVisibleToClient(
        {
          min_app_build: 202606080000,
          required_capabilities: ['runtime-artwork-v1'],
        },
        parseClientCapabilities({
          'x-sappeun-client-capabilities': 'runtime-artwork-v1',
        }),
      ),
    ).toBe(false)
  })

  it('applies active windows', () => {
    const now = new Date('2026-06-08T00:00:00.000Z')

    expect(
      isVisibleToClient(
        { active_from: '2026-06-08T01:00:00.000Z' },
        runtimeClient,
        now,
      ),
    ).toBe(false)
    expect(
      isVisibleToClient(
        { active_until: '2026-06-08T00:00:00.000Z' },
        runtimeClient,
        now,
      ),
    ).toBe(false)
  })
})
