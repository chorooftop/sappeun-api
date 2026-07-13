import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import type { User } from '@supabase/supabase-js'
import { createHash, timingSafeEqual } from 'crypto'

import type { AppEnv } from '@/config/env'
import type { QaAuthSessionInput } from '@/qa-auth/qa-auth.schemas'
import { SupabaseService } from '@/supabase/supabase.service'
import { UsersService } from '@/users/users.service'

const QA_APP_METADATA = {
  qa_actor: true,
  provider: 'email',
} as const

interface AuthUserPage {
  users?: User[]
}

@Injectable()
export class QaAuthService {
  constructor(
    private readonly config: ConfigService<AppEnv, true>,
    private readonly supabase: SupabaseService,
    private readonly usersService: UsersService,
  ) {}

  async createSession(input: QaAuthSessionInput = {}) {
    this.assertEnabled(input)

    const email = this.requiredConfig('QA_AUTH_EMAIL')
    const password = this.requiredConfig('QA_AUTH_PASSWORD')
    const displayName = this.config.get('QA_AUTH_DISPLAY_NAME', {
      infer: true,
    })
    const birthDate = this.config.get('QA_AUTH_BIRTH_DATE', { infer: true })

    const user = await this.ensureQaUser({ email, password, displayName })
    const {
      data: { session, user: signedInUser },
      error,
    } = await this.supabase.anonClient.auth.signInWithPassword({
      email,
      password,
    })

    if (error || !session?.access_token || !session.refresh_token) {
      throw new ServiceUnavailableException('QA auth session unavailable.')
    }

    const effectiveUser = signedInUser ?? user
    const profile = await this.ensureCompletedProfile(effectiveUser, {
      displayName,
      birthDate,
    })

    this.audit(input, effectiveUser.id)

    return {
      session: {
        accessToken: session.access_token,
        refreshToken: session.refresh_token,
        expiresAt: session.expires_at ?? null,
      },
      user: {
        id: effectiveUser.id,
        email: effectiveUser.email ?? email,
      },
      profile: {
        nickname: profile.profile?.nickname ?? null,
        signupCompleted: profile.requiresSignupConsent === false,
      },
      requiresSignupConsent: false,
    }
  }

  private assertEnabled(input: QaAuthSessionInput) {
    const enabled =
      this.config.get('QA_AUTH_ENABLED', { infer: true }) === 'true'
    if (!enabled) throw new NotFoundException()

    const nodeEnv = this.config.get('NODE_ENV', { infer: true })
    const allowProduction =
      this.config.get('QA_AUTH_ALLOW_PRODUCTION', { infer: true }) === 'true'
    if (nodeEnv === 'production' && !allowProduction) {
      throw new NotFoundException()
    }

    const expectedCodeHash = this.config.get('QA_AUTH_CODE_HASH', {
      infer: true,
    })
    if (!expectedCodeHash) return

    if (!input.code || !matchesSha256(input.code, expectedCodeHash)) {
      throw new ForbiddenException('Invalid QA auth code.')
    }
  }

  private requiredConfig(name: 'QA_AUTH_EMAIL' | 'QA_AUTH_PASSWORD') {
    const value = this.config.get(name, { infer: true })
    if (!value) {
      throw new ServiceUnavailableException('QA auth is not configured.')
    }
    return value
  }

  private async ensureQaUser(input: {
    email: string
    password: string
    displayName: string
  }) {
    const existing = await this.findUserByEmail(input.email)
    if (!existing) {
      const { data, error } =
        await this.supabase.adminClient.auth.admin.createUser({
          email: input.email,
          password: input.password,
          email_confirm: true,
          user_metadata: {
            name: input.displayName,
            full_name: input.displayName,
          },
          app_metadata: QA_APP_METADATA,
        })

      if (error || !data.user) {
        throw new ServiceUnavailableException('QA auth user unavailable.')
      }
      return data.user
    }

    if (existing.app_metadata?.qa_actor !== true) {
      throw new ConflictException('Configured QA auth email is not a QA user.')
    }

    const { data, error } =
      await this.supabase.adminClient.auth.admin.updateUserById(existing.id, {
        password: input.password,
        user_metadata: {
          ...(existing.user_metadata ?? {}),
          name: input.displayName,
          full_name: input.displayName,
        },
        app_metadata: {
          ...(existing.app_metadata ?? {}),
          ...QA_APP_METADATA,
        },
      })

    if (error || !data.user) {
      throw new ServiceUnavailableException('QA auth user unavailable.')
    }
    return data.user
  }

  private async findUserByEmail(email: string): Promise<User | null> {
    const perPage = 1000

    for (let page = 1; page <= 50; page += 1) {
      const { data, error } =
        await this.supabase.adminClient.auth.admin.listUsers({
          page,
          perPage,
        })
      if (error)
        throw new ServiceUnavailableException('QA auth user lookup failed.')

      const users = (data as AuthUserPage).users ?? []
      const match = users.find(
        (user) => user.email?.toLowerCase() === email.toLowerCase(),
      )
      if (match) return match
      if (users.length < perPage) return null
    }

    throw new ServiceUnavailableException('QA auth user lookup exceeded limit.')
  }

  private async ensureCompletedProfile(
    user: User,
    input: { displayName: string; birthDate: string },
  ) {
    const synced = await this.usersService.syncAuthProfile(user, {
      displayName: input.displayName,
    })
    if (!synced.requiresSignupConsent) return synced

    return this.usersService.completeSignup(user, {
      birthDate: input.birthDate,
      consents: {
        terms: true,
        privacy: true,
        marketing: false,
      },
    })
  }

  private audit(input: QaAuthSessionInput, userId: string) {
    // Do not log access/refresh tokens, password, or QA code.
    console.info('qa_auth_session_created', {
      userId,
      client: input.client ?? null,
      flow: input.flow ?? null,
    })
  }
}

function matchesSha256(value: string, expectedHash: string) {
  const actual = createHash('sha256').update(value).digest('hex')
  const expected = expectedHash.trim().toLowerCase()
  if (!/^[a-f0-9]{64}$/.test(expected)) return false

  const actualBuffer = Buffer.from(actual, 'hex')
  const expectedBuffer = Buffer.from(expected, 'hex')
  return timingSafeEqual(actualBuffer, expectedBuffer)
}
