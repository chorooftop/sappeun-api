import type { User } from '@supabase/supabase-js'
import { describe, expect, it } from 'vitest'

import { calculateAge } from '@/users/consents.constants'
import { UsersService } from '@/users/users.service'

describe('calculateAge', () => {
  it('returns the exact age on the birthday (UTC, host-tz independent)', () => {
    const birth = new Date('2012-05-30T00:00:00Z')
    const asOf = new Date('2026-05-30T00:00:00Z')
    expect(calculateAge(birth, asOf)).toBe(14)
  })

  it('does not count the year until the birthday is reached', () => {
    const birth = new Date('2012-05-31T00:00:00Z')
    const asOf = new Date('2026-05-30T00:00:00Z')
    expect(calculateAge(birth, asOf)).toBe(13)
  })
})

describe('UsersService.syncAuthProfile', () => {
  it('creates a profile from verified Supabase auth metadata', async () => {
    const rows = new Map<string, Record<string, unknown>>()
    const service = new UsersService(fakeSupabase(rows) as never)

    const result = await service.syncAuthProfile(
      fakeUser({
        id: '11111111-1111-4111-8111-111111111111',
        provider: 'google',
        userMetadata: {
          name: ' 사뿐 구글 ',
          avatar_url: 'https://cdn.example.com/avatar.png',
        },
      }),
      { provider: 'kakao', displayName: '요청 이름' },
    )

    expect(result.user).toEqual({
      id: '11111111-1111-4111-8111-111111111111',
      email: 'user@example.com',
      phone: null,
    })
    expect(result.requiresSignupConsent).toBe(true)
    expect(result.profile).toMatchObject({
      user_id: '11111111-1111-4111-8111-111111111111',
      nickname: '요청 이름',
      display_name: '요청 이름',
      avatar_url: 'https://cdn.example.com/avatar.png',
      primary_provider: 'google',
      signup_completed_at: null,
    })
    expect(result.profile?.first_login_at).toBeTruthy()
    expect(result.profile?.last_seen_at).toBeTruthy()
  })

  it('preserves user-edited profile fields while refreshing auth timestamps', async () => {
    const userId = '22222222-2222-4222-8222-222222222222'
    const rows = new Map<string, Record<string, unknown>>([
      [
        userId,
        {
          user_id: userId,
          nickname: '내닉네임',
          display_name: '내 이름',
          avatar_url: 'https://cdn.example.com/local.png',
          primary_provider: null,
          first_login_at: '2026-05-01T00:00:00.000Z',
          last_seen_at: null,
          signup_completed_at: '2026-05-02T00:00:00.000Z',
          onboarding_completed_at: null,
        },
      ],
    ])
    const service = new UsersService(fakeSupabase(rows) as never)

    const result = await service.syncAuthProfile(
      fakeUser({
        id: userId,
        provider: 'apple',
        userMetadata: {
          name: 'Apple Name',
          avatar_url: 'https://cdn.example.com/apple.png',
        },
      }),
    )

    expect(result.requiresSignupConsent).toBe(false)
    expect(result.profile).toMatchObject({
      user_id: userId,
      nickname: '내닉네임',
      display_name: '내 이름',
      avatar_url: 'https://cdn.example.com/local.png',
      primary_provider: 'apple',
      first_login_at: '2026-05-01T00:00:00.000Z',
      signup_completed_at: '2026-05-02T00:00:00.000Z',
    })
    expect(result.profile?.last_seen_at).toBeTruthy()
  })

  it('ignores unsupported Supabase auth providers when selecting primary provider', async () => {
    const rows = new Map<string, Record<string, unknown>>()
    const service = new UsersService(fakeSupabase(rows) as never)

    const result = await service.syncAuthProfile(
      fakeUser({
        id: '33333333-3333-4333-8333-333333333333',
        provider: 'email',
        identities: [{ provider: 'google' }],
      }),
      { provider: 'kakao' },
    )

    expect(result.profile.primary_provider).toBe('google')
  })
})

describe('UsersService.completeSignup', () => {
  const userId = '44444444-4444-4444-8444-444444444444'

  function seededProfile() {
    return new Map<string, Record<string, unknown>>([
      [
        userId,
        {
          user_id: userId,
          nickname: '사뿐',
          display_name: '사뿐',
          avatar_url: null,
          primary_provider: 'kakao',
          first_login_at: '2026-05-01T00:00:00.000Z',
          last_seen_at: '2026-05-20T00:00:00.000Z',
          signup_completed_at: null,
          onboarding_completed_at: null,
        },
      ],
    ])
  }

  it('records consents and completes signup on first call', async () => {
    const db = fakeDb(seededProfile())
    const service = new UsersService(db as never)

    const result = await service.completeSignup(fakeUser({ id: userId, provider: 'kakao' }), {
      birthDate: '2000-01-01',
      consents: { terms: true, privacy: true, marketing: true },
    })

    expect(result.requiresSignupConsent).toBe(false)
    expect(result.profile?.signup_completed_at).toBeTruthy()

    const types = db.consents.filter((c) => c.user_id === userId).map((c) => c.consent_type)
    expect(types).toEqual(expect.arrayContaining(['terms', 'privacy', 'marketing']))
    expect(db.consents.find((c) => c.consent_type === 'terms')?.version).toBe('terms-2026-05-16')
  })

  it('is idempotent: re-running keeps the original signup_completed_at', async () => {
    const db = fakeDb(seededProfile())
    const service = new UsersService(db as never)
    const user = fakeUser({ id: userId, provider: 'kakao' })

    const first = await service.completeSignup(user, {
      birthDate: '2000-01-01',
      consents: { terms: true, privacy: true },
    })
    const second = await service.completeSignup(user, {
      birthDate: '2000-01-01',
      consents: { terms: true, privacy: true },
    })

    expect(second.profile?.signup_completed_at).toBe(first.profile?.signup_completed_at)
  })

  it('rejects when a required consent is missing', async () => {
    const db = fakeDb(seededProfile())
    const service = new UsersService(db as never)

    await expect(
      service.completeSignup(fakeUser({ id: userId, provider: 'kakao' }), {
        birthDate: '2000-01-01',
        consents: { terms: true, privacy: false },
      }),
    ).rejects.toThrow()
    expect(db.consents).toHaveLength(0)
  })

  it('rejects users under the minimum signup age', async () => {
    const db = fakeDb(seededProfile())
    const service = new UsersService(db as never)

    await expect(
      service.completeSignup(fakeUser({ id: userId, provider: 'kakao' }), {
        birthDate: '2015-01-01',
        consents: { terms: true, privacy: true },
      }),
    ).rejects.toThrow()
    expect(db.consents).toHaveLength(0)
  })

  it('rejects an invalid calendar date (rollover) at the service layer', async () => {
    const db = fakeDb(seededProfile())
    const service = new UsersService(db as never)

    await expect(
      service.completeSignup(fakeUser({ id: userId, provider: 'kakao' }), {
        birthDate: '2001-02-29',
        consents: { terms: true, privacy: true },
      }),
    ).rejects.toThrow()
    expect(db.consents).toHaveLength(0)
  })

  it('getConsents marks revoked rows inactive', async () => {
    const db = fakeDb(seededProfile())
    db.consents.push(
      {
        user_id: userId,
        consent_type: 'terms',
        version: 'terms-2026-05-16',
        accepted_at: '2026-05-29T00:00:00.000Z',
        revoked_at: null,
        source: 'signup',
      },
      {
        user_id: userId,
        consent_type: 'marketing',
        version: 'marketing-2026-05-16',
        accepted_at: '2026-05-29T00:00:00.000Z',
        revoked_at: '2026-05-30T00:00:00.000Z',
        source: 'signup',
      },
    )
    const service = new UsersService(db as never)

    const result = await service.getConsents(
      fakeUser({ id: userId, provider: 'kakao' }),
    )
    const terms = result.consents.find((c) => c.consent_type === 'terms')
    const marketing = result.consents.find((c) => c.consent_type === 'marketing')

    expect(terms?.active).toBe(true)
    expect(marketing?.active).toBe(false)
  })
})

function fakeDb(profiles: Map<string, Record<string, unknown>>) {
  const consents: Array<Record<string, unknown>> = []
  return {
    consents,
    adminClient: {
      from(table: string) {
        if (table === 'profiles') return new FakeProfilesChain(profiles)
        if (table === 'user_consents') return new FakeConsentsChain(consents)
        throw new Error(`Unexpected table: ${table}`)
      },
    },
  }
}

function projectRow(row: Record<string, unknown>, cols?: string) {
  const columns = cols?.split(',').map((c) => c.trim()).filter(Boolean)
  if (!columns || columns.length === 0) return row
  return Object.fromEntries(columns.map((c) => [c, row[c] ?? null]))
}

class FakeProfilesChain {
  private op: 'select' | 'insert' | 'update' = 'select'
  private cols?: string
  private payload?: Record<string, unknown>
  private eqUser?: string
  private isNullCol?: string

  constructor(private readonly store: Map<string, Record<string, unknown>>) {}

  select(cols: string) {
    this.cols = cols
    return this
  }
  insert(payload: Record<string, unknown>) {
    this.op = 'insert'
    this.payload = payload
    return this
  }
  update(payload: Record<string, unknown>) {
    this.op = 'update'
    this.payload = payload
    return this
  }
  eq(column: string, value: string) {
    if (column === 'user_id') this.eqUser = value
    return this
  }
  is(column: string) {
    this.isNullCol = column
    return this
  }

  maybeSingle() {
    const row = this.eqUser ? this.store.get(this.eqUser) : undefined
    return Promise.resolve({
      data: row ? projectRow(row, this.cols) : null,
      error: null,
    })
  }

  single() {
    if (this.op === 'insert') {
      const id = this.payload?.user_id as string
      const row = {
        signup_completed_at: null,
        onboarding_completed_at: null,
        ...this.payload,
      }
      this.store.set(id, row)
      return Promise.resolve({ data: projectRow(row, this.cols), error: null })
    }
    const row = this.eqUser ? this.store.get(this.eqUser) : undefined
    if (!row) return Promise.resolve({ data: null, error: {} })
    const updated = { ...row, ...this.payload }
    this.store.set(this.eqUser as string, updated)
    return Promise.resolve({ data: projectRow(updated, this.cols), error: null })
  }

  then(
    resolve: (value: { error: unknown }) => unknown,
    reject?: (reason: unknown) => unknown,
  ) {
    return Promise.resolve(this.runTerminalUpdate()).then(resolve, reject)
  }

  private runTerminalUpdate() {
    if (this.op !== 'update' || !this.eqUser) return { error: null }
    const row = this.store.get(this.eqUser)
    if (!row) return { error: null }
    // .is('col', null) 필터: 해당 컬럼이 이미 값이 있으면 업데이트 미적용(멱등)
    if (this.isNullCol && row[this.isNullCol] != null) return { error: null }
    this.store.set(this.eqUser, { ...row, ...this.payload })
    return { error: null }
  }
}

class FakeConsentsChain {
  private op: 'upsert' | 'select' = 'select'
  private rows?: Array<Record<string, unknown>>
  private cols?: string
  private eqUser?: string

  constructor(private readonly store: Array<Record<string, unknown>>) {}

  upsert(rows: Array<Record<string, unknown>>) {
    this.op = 'upsert'
    this.rows = rows
    return this
  }
  select(cols: string) {
    this.op = 'select'
    this.cols = cols
    return this
  }
  eq(_column: string, value: string) {
    this.eqUser = value
    return this
  }
  order() {
    return this
  }

  then(
    resolve: (value: { data?: unknown; error: unknown }) => unknown,
    reject?: (reason: unknown) => unknown,
  ) {
    if (this.op === 'upsert' && this.rows) {
      for (const row of this.rows) {
        const idx = this.store.findIndex(
          (x) =>
            x.user_id === row.user_id &&
            x.consent_type === row.consent_type &&
            x.version === row.version,
        )
        if (idx >= 0) this.store[idx] = { ...this.store[idx], ...row }
        else this.store.push({ ...row })
      }
      return Promise.resolve({ error: null }).then(resolve, reject)
    }
    const data = this.store
      .filter((x) => x.user_id === this.eqUser)
      .map((x) => projectRow(x, this.cols))
    return Promise.resolve({ data, error: null }).then(resolve, reject)
  }
}

function fakeUser({
  id,
  provider,
  identities,
  userMetadata = {},
}: {
  id: string
  provider: string
  identities?: Array<{ provider: string }>
  userMetadata?: Record<string, unknown>
}): User {
  return {
    id,
    email: 'user@example.com',
    phone: null,
    app_metadata: { provider },
    user_metadata: userMetadata,
    identities: identities ?? [
      {
        provider,
      },
    ],
  } as unknown as User
}

function fakeSupabase(rows: Map<string, Record<string, unknown>>) {
  return {
    adminClient: {
      from(table: string) {
        if (table !== 'profiles') throw new Error(`Unexpected table: ${table}`)
        return new FakeProfilesTable(rows)
      },
    },
  }
}

class FakeProfilesTable {
  constructor(private readonly rows: Map<string, Record<string, unknown>>) {}

  select(columns: string) {
    return new FakeProfilesQuery(this.rows, 'select', undefined, columns)
  }

  insert(payload: Record<string, unknown>) {
    return new FakeProfilesQuery(this.rows, 'insert', payload)
  }

  update(payload: Record<string, unknown>) {
    return new FakeProfilesQuery(this.rows, 'update', payload)
  }
}

class FakeProfilesQuery {
  private selectedColumns?: string
  private userId?: string

  constructor(
    private readonly rows: Map<string, Record<string, unknown>>,
    private readonly operation: 'select' | 'insert' | 'update',
    private readonly payload?: Record<string, unknown>,
    selectedColumns?: string,
  ) {
    this.selectedColumns = selectedColumns
  }

  select(columns: string) {
    this.selectedColumns = columns
    return this
  }

  eq(column: string, value: string) {
    if (column !== 'user_id') throw new Error(`Unexpected column: ${column}`)
    this.userId = value
    return this
  }

  maybeSingle() {
    if (!this.userId) throw new Error('Missing user id.')
    const row = this.rows.get(this.userId)
    return Promise.resolve({ data: row ? this.project(row) : null, error: null })
  }

  single() {
    if (this.operation === 'insert') return Promise.resolve(this.singleInsert())
    if (this.operation === 'update') return Promise.resolve(this.singleUpdate())
    if (!this.userId) throw new Error('Missing user id.')
    const row = this.rows.get(this.userId)
    return Promise.resolve({
      data: row ? this.project(row) : null,
      error: row ? null : {},
    })
  }

  private singleInsert() {
    const userId = this.payload?.user_id
    if (typeof userId !== 'string') throw new Error('Missing insert user id.')
    if (this.rows.has(userId)) {
      return { data: null, error: { code: '23505' } }
    }

    const row = {
      ...this.payload,
      signup_completed_at: null,
      onboarding_completed_at: null,
    } as Record<string, unknown>
    this.rows.set(userId, row)
    return { data: this.project(row), error: null }
  }

  private singleUpdate() {
    if (!this.userId) throw new Error('Missing update user id.')
    const existing = this.rows.get(this.userId)
    if (!existing) return { data: null, error: {} }

    const updated = { ...existing, ...this.payload }
    this.rows.set(this.userId, updated)
    return { data: this.project(updated), error: null }
  }

  private project(row: Record<string, unknown>) {
    const columns = this.selectedColumns
      ?.split(',')
      .map((column) => column.trim())
      .filter(Boolean)
    if (!columns || columns.length === 0) return row

    return Object.fromEntries(
      columns.map((column) => [column, row[column] ?? null]),
    )
  }
}
