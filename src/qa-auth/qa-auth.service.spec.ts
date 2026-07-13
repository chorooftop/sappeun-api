import type { User } from '@supabase/supabase-js'
import { createHash } from 'crypto'
import { describe, expect, it, vi } from 'vitest'

import { QaAuthService } from '@/qa-auth/qa-auth.service'

const qaEmail = 'qa@sappeun.test'
const qaPassword = 'test-password-123'

describe('QaAuthService', () => {
  it('hides the endpoint when QA auth is disabled', async () => {
    const service = createService({ QA_AUTH_ENABLED: 'false' })

    await expect(service.createSession()).rejects.toThrow()
  })

  it('hides the endpoint in production unless explicitly allowed', async () => {
    const service = createService({ NODE_ENV: 'production' })

    await expect(service.createSession()).rejects.toThrow()
  })

  it('rejects an invalid QA auth code when a hash is configured', async () => {
    const service = createService({
      QA_AUTH_CODE_HASH: sha256('correct-code'),
    })

    await expect(service.createSession({ code: 'wrong-code' })).rejects.toThrow(
      'Invalid QA auth code.',
    )
  })

  it('creates a QA user, signs in, and completes signup', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined)
    const users = new FakeUsersService({ requiresSignupConsent: true })
    const supabase = new FakeSupabase()
    const service = createService({}, { supabase, users })

    const result = await service.createSession({
      client: 'maestro',
      flow: 'qa-login',
    })

    expect(supabase.createdUsers).toHaveLength(1)
    expect(supabase.createdUsers[0]?.email).toBe(qaEmail)
    expect(supabase.createdUsers[0]?.app_metadata?.qa_actor).toBe(true)
    expect(supabase.signInRequests).toEqual([
      { email: qaEmail, password: qaPassword },
    ])
    expect(users.syncCalls).toHaveLength(1)
    expect(users.completeSignupCalls).toHaveLength(1)
    expect(result).toMatchObject({
      session: {
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
      },
      user: {
        email: qaEmail,
      },
      profile: {
        nickname: '사뿐 QA',
        signupCompleted: true,
      },
      requiresSignupConsent: false,
    })
    expect(JSON.stringify(info.mock.calls)).not.toContain('access-token')
    expect(JSON.stringify(info.mock.calls)).not.toContain(qaPassword)
    info.mockRestore()
  })

  it('updates an existing QA-marked user before signing in', async () => {
    const supabase = new FakeSupabase([
      fakeUser({
        id: 'existing-qa',
        email: qaEmail,
        app_metadata: { qa_actor: true },
        user_metadata: { name: 'Old QA' },
      }),
    ])
    const service = createService({}, { supabase })

    await service.createSession()

    expect(supabase.createdUsers).toHaveLength(0)
    expect(supabase.updatedUsers).toHaveLength(1)
    expect(supabase.updatedUsers[0]).toMatchObject({
      id: 'existing-qa',
      attributes: {
        password: qaPassword,
        app_metadata: {
          qa_actor: true,
          provider: 'email',
        },
      },
    })
  })

  it('does not take over an existing non-QA user email', async () => {
    const supabase = new FakeSupabase([
      fakeUser({
        id: 'real-user',
        email: qaEmail,
        app_metadata: { provider: 'google' },
      }),
    ])
    const service = createService({}, { supabase })

    await expect(service.createSession()).rejects.toThrow(
      'Configured QA auth email is not a QA user.',
    )
    expect(supabase.updatedUsers).toHaveLength(0)
    expect(supabase.signInRequests).toHaveLength(0)
  })
})

function createService(
  overrides: Record<string, string | undefined> = {},
  deps: {
    supabase?: FakeSupabase
    users?: FakeUsersService
  } = {},
) {
  const supabase = deps.supabase ?? new FakeSupabase()
  const users = deps.users ?? new FakeUsersService()
  const values = {
    NODE_ENV: 'development',
    QA_AUTH_ENABLED: 'true',
    QA_AUTH_ALLOW_PRODUCTION: 'false',
    QA_AUTH_EMAIL: qaEmail,
    QA_AUTH_PASSWORD: qaPassword,
    QA_AUTH_CODE_HASH: undefined,
    QA_AUTH_BIRTH_DATE: '2000-01-01',
    QA_AUTH_DISPLAY_NAME: '사뿐 QA',
    ...overrides,
  }

  return new QaAuthService(
    { get: (key: keyof typeof values) => values[key] } as never,
    supabase as never,
    users as never,
  )
}

class FakeSupabase {
  constructor(users: User[] = []) {
    this.users = [...users]
  }

  users: User[]
  createdUsers: Array<Record<string, unknown>> = []
  updatedUsers: Array<{ id: string; attributes: Record<string, unknown> }> = []
  signInRequests: Array<{ email: string; password: string }> = []

  adminClient = {
    auth: {
      admin: {
        listUsers: () =>
          Promise.resolve({
            data: { users: this.users },
            error: null,
          }),
        createUser: (attributes: Record<string, unknown>) => {
          this.createdUsers.push(attributes)
          const user = fakeUser({
            id: 'created-qa',
            email: attributes.email as string,
            app_metadata: attributes.app_metadata as Record<string, unknown>,
            user_metadata: attributes.user_metadata as Record<string, unknown>,
          })
          this.users.push(user)
          return Promise.resolve({ data: { user }, error: null })
        },
        updateUserById: (id: string, attributes: Record<string, unknown>) => {
          this.updatedUsers.push({ id, attributes })
          const user = this.users.find((candidate) => candidate.id === id)
          if (user) {
            user.app_metadata = attributes.app_metadata as Record<
              string,
              unknown
            >
            user.user_metadata = attributes.user_metadata as Record<
              string,
              unknown
            >
          }
          return Promise.resolve({ data: { user: user ?? null }, error: null })
        },
      },
    },
  }

  anonClient = {
    auth: {
      signInWithPassword: (request: { email: string; password: string }) => {
        this.signInRequests.push(request)
        return Promise.resolve({
          data: {
            session: {
              access_token: 'access-token',
              refresh_token: 'refresh-token',
              expires_at: 1781234567,
            },
            user:
              this.users.find(
                (candidate) =>
                  candidate.email?.toLowerCase() ===
                  request.email.toLowerCase(),
              ) ?? null,
          },
          error: null,
        })
      },
    },
  }
}

class FakeUsersService {
  constructor(
    private readonly options: { requiresSignupConsent?: boolean } = {},
  ) {}

  syncCalls: Array<{ user: User; input: Record<string, unknown> }> = []
  completeSignupCalls: Array<{ user: User; input: Record<string, unknown> }> =
    []

  syncAuthProfile(user: User, input: Record<string, unknown>) {
    this.syncCalls.push({ user, input })
    return Promise.resolve({
      profile: {
        nickname: '사뿐 QA',
        signup_completed_at: this.options.requiresSignupConsent
          ? null
          : '2026-06-12T00:00:00.000Z',
      },
      requiresSignupConsent: this.options.requiresSignupConsent ?? false,
    })
  }

  completeSignup(user: User, input: Record<string, unknown>) {
    this.completeSignupCalls.push({ user, input })
    return Promise.resolve({
      profile: {
        nickname: '사뿐 QA',
        signup_completed_at: '2026-06-12T00:00:00.000Z',
      },
      requiresSignupConsent: false,
    })
  }
}

function fakeUser(input: {
  id: string
  email: string
  app_metadata?: Record<string, unknown>
  user_metadata?: Record<string, unknown>
}): User {
  return {
    id: input.id,
    email: input.email,
    app_metadata: input.app_metadata ?? {},
    user_metadata: input.user_metadata ?? {},
    aud: 'authenticated',
    created_at: '2026-06-12T00:00:00.000Z',
  }
}

function sha256(value: string) {
  return createHash('sha256').update(value).digest('hex')
}
