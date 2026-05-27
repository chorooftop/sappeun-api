import type { User } from '@supabase/supabase-js'
import { describe, expect, it } from 'vitest'

import { UsersService } from '@/users/users.service'

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

  async maybeSingle() {
    if (!this.userId) throw new Error('Missing user id.')
    const row = this.rows.get(this.userId)
    return { data: row ? this.project(row) : null, error: null }
  }

  async single() {
    if (this.operation === 'insert') return this.singleInsert()
    if (this.operation === 'update') return this.singleUpdate()
    if (!this.userId) throw new Error('Missing user id.')
    const row = this.rows.get(this.userId)
    return { data: row ? this.project(row) : null, error: row ? null : {} }
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
