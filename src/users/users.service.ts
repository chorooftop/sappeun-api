import { Injectable, UnprocessableEntityException } from '@nestjs/common'
import type { User } from '@supabase/supabase-js'

import {
  CONSENT_SOURCE_SIGNUP,
  CONSENT_TYPES,
  CURRENT_CONSENT_VERSIONS,
  MIN_SIGNUP_AGE,
  REQUIRED_CONSENT_TYPES,
  calculateAge,
} from '@/users/consents.constants'
import { SupabaseService } from '@/supabase/supabase.service'

const MAX_DISPLAY_NAME_LENGTH = 40
const MAX_NICKNAME_LENGTH = 10
const UNIQUE_VIOLATION = '23505'
const AUTH_SYNC_PROVIDERS = ['kakao', 'apple', 'google'] as const
const PROFILE_COLUMNS =
  'user_id, nickname, display_name, avatar_url, primary_provider, first_login_at, last_seen_at, signup_completed_at, onboarding_completed_at'

interface CompleteSignupInput {
  birthDate: string
  consents: { terms: boolean; privacy: boolean; marketing?: boolean }
}

interface ConsentRow {
  consent_type: string
  version: string
  accepted_at: string
  revoked_at: string | null
  source: string
}

type AuthSyncProvider = (typeof AUTH_SYNC_PROVIDERS)[number]

interface AuthSyncInput {
  provider?: AuthSyncProvider
  displayName?: string
  avatarUrl?: string
}

interface ProfileCandidate {
  displayName: string | null
  avatarUrl: string | null
  primaryProvider: string | null
}

export interface ProfileRow {
  user_id: string
  nickname?: string | null
  display_name: string | null
  avatar_url: string | null
  primary_provider: string | null
  first_login_at: string
  last_seen_at: string | null
  signup_completed_at: string | null
  onboarding_completed_at: string | null
}

@Injectable()
export class UsersService {
  constructor(private readonly supabase: SupabaseService) {}

  async getMe(user: User) {
    const profile = await this.readProfile(user.id)
    return {
      user: currentUserPayload(user),
      profile,
    }
  }

  async getProfile(user: User) {
    const { profile } = await this.getMe(user)
    return {
      profile: {
        nickname: profile?.nickname ?? null,
        displayName: profile?.display_name ?? null,
        avatarUrl: profile?.avatar_url ?? null,
        primaryProvider: profile?.primary_provider ?? null,
      },
    }
  }

  async updateNickname(userId: string, nickname: string) {
    const now = new Date().toISOString()
    const { error } = await this.supabase.adminClient
      .from('profiles')
      .update({
        nickname,
        nickname_updated_at: now,
      })
      .eq('user_id', userId)

    if (error) throw error

    return {
      profile: {
        nickname,
        nicknameUpdatedAt: now,
      },
    }
  }

  async completeSignup(user: User, input: CompleteSignupInput) {
    const age = ageFromBirthDate(input.birthDate)
    if (age === null) {
      throw new UnprocessableEntityException({
        error: 'Invalid birth date.',
        code: 'INVALID_BIRTH_DATE',
      })
    }
    if (age < MIN_SIGNUP_AGE) {
      throw new UnprocessableEntityException({
        error: `만 ${MIN_SIGNUP_AGE}세 미만은 가입할 수 없습니다.`,
        code: 'AGE_RESTRICTION',
      })
    }

    for (const type of REQUIRED_CONSENT_TYPES) {
      if (!input.consents[type]) {
        throw new UnprocessableEntityException({
          error: 'Required consent missing.',
          code: 'CONSENT_REQUIRED',
          consentType: type,
        })
      }
    }

    // 프로필 존재 보장 (auth-sync가 선행되지만 방어적으로 생성)
    const existing = await this.readProfile(user.id)
    if (!existing) {
      await this.insertProfile(user.id, profileCandidateFromUser(user, {}))
    }

    const now = new Date().toISOString()

    // 두 단계로 나뉘지만 재시도-안전(retry-safe)하다:
    //  - 동의 upsert는 멱등(유니크 키 기준)이고,
    //  - 프로필 확정 update는 `.is(signup_completed_at, null)` 가드로 최초 1회만 적용된다.
    // 1단계만 성공하고 2단계가 실패하면 "동의는 있으나 미가입"(PENDING) 상태가 되는데,
    // 이는 트리거가 요구하는 정상 중간 상태이며 재요청 시 그대로 가입이 완결된다.
    // (참고: 마케팅 미동의(false)는 가입 시 기록하지 않는다 — 철회는 후속 설정 엔드포인트 담당.)

    // 1) 동의 행 기록 — DB 트리거가 signup_completed_at 설정 전 동의 존재를 검증하므로 먼저 insert
    const consentRows = grantedConsentRows(user.id, input.consents, now)
    const { error: consentError } = await this.supabase.adminClient
      .from('user_consents')
      .upsert(consentRows, { onConflict: 'user_id,consent_type,version' })
    if (consentError) throw consentError

    // 2) 생년월일 + signup_completed_at 확정 — 최초 1회만(멱등). birth_date도 같은 업데이트로
    //    함께 커밋되어, 가입 완료 후 재요청 시 연령 필드가 덮어써지지 않는다.
    const { error: signupError } = await this.supabase.adminClient
      .from('profiles')
      .update({
        birth_date: input.birthDate,
        signup_completed_at: now,
        signup_source: CONSENT_SOURCE_SIGNUP,
      })
      .eq('user_id', user.id)
      .is('signup_completed_at', null)
    if (signupError) throw signupError

    const profile = await this.readProfile(user.id)
    return {
      user: currentUserPayload(user),
      profile,
      requiresSignupConsent: false,
    }
  }

  async getConsents(user: User) {
    const { data, error } = await this.supabase.adminClient
      .from('user_consents')
      .select('consent_type, version, accepted_at, revoked_at, source')
      .eq('user_id', user.id)
      .order('accepted_at', { ascending: false })

    if (error) throw error

    const consents = ((data ?? []) as ConsentRow[]).map((row) => ({
      ...row,
      active: row.revoked_at == null,
    }))
    return { consents }
  }

  async syncAuthProfile(user: User, input: AuthSyncInput = {}) {
    const candidate = profileCandidateFromUser(user, input)
    const existingProfile = await this.readProfile(user.id)

    const profile =
      existingProfile === null
        ? await this.insertProfile(user.id, candidate)
        : await this.updateProfileFromAuth(existingProfile, candidate)

    return {
      user: currentUserPayload(user),
      profile,
      requiresSignupConsent: profile.signup_completed_at === null,
    }
  }

  private async readProfile(userId: string): Promise<ProfileRow | null> {
    const { data, error } = await this.supabase.adminClient
      .from('profiles')
      .select(PROFILE_COLUMNS)
      .eq('user_id', userId)
      .maybeSingle()

    if (error) throw error
    if (!data) return null
    return normalizeProfileRow(data)
  }

  private async insertProfile(userId: string, candidate: ProfileCandidate) {
    const now = new Date().toISOString()
    const payload = {
      user_id: userId,
      nickname: candidate.displayName?.slice(0, MAX_NICKNAME_LENGTH) ?? null,
      display_name: candidate.displayName,
      avatar_url: candidate.avatarUrl,
      primary_provider: candidate.primaryProvider,
      first_login_at: now,
      last_seen_at: now,
    }

    const { data, error } = await this.supabase.adminClient
      .from('profiles')
      .insert(payload)
      .select(PROFILE_COLUMNS)
      .single()

    if (error?.code === UNIQUE_VIOLATION) {
      const existingProfile = await this.readProfile(userId)
      if (!existingProfile) {
        throw new Error(
          'Profile row conflict occurred but row was not readable.',
        )
      }
      return this.updateProfileFromAuth(existingProfile, candidate)
    }

    if (error) throw error
    return normalizeProfileRow(data)
  }

  private async updateProfileFromAuth(
    profile: ProfileRow,
    candidate: ProfileCandidate,
  ) {
    const now = new Date().toISOString()
    const update: Record<string, string | null> = {
      last_seen_at: now,
    }

    if (!profile.primary_provider && candidate.primaryProvider) {
      update.primary_provider = candidate.primaryProvider
    }

    if (!profile.display_name && candidate.displayName) {
      update.display_name = candidate.displayName
    }

    if (!profile.nickname && candidate.displayName) {
      update.nickname = candidate.displayName.slice(0, MAX_NICKNAME_LENGTH)
      update.nickname_updated_at = now
    }

    if (!profile.avatar_url && candidate.avatarUrl) {
      update.avatar_url = candidate.avatarUrl
    }

    const { data, error } = await this.supabase.adminClient
      .from('profiles')
      .update(update)
      .eq('user_id', profile.user_id)
      .select(PROFILE_COLUMNS)
      .single()

    if (error) throw error
    return normalizeProfileRow(data)
  }
}

function currentUserPayload(user: User) {
  return {
    id: user.id,
    email: user.email ?? null,
    phone: user.phone ?? null,
  }
}

function profileCandidateFromUser(
  user: User,
  input: AuthSyncInput,
): ProfileCandidate {
  const userMetadata = user.user_metadata ?? {}

  return {
    displayName: firstText(
      [
        input.displayName,
        userMetadata.name,
        userMetadata.full_name,
        userMetadata.nickname,
        userMetadata.preferred_username,
      ],
      MAX_DISPLAY_NAME_LENGTH,
    ),
    avatarUrl: firstText(
      [input.avatarUrl, userMetadata.avatar_url, userMetadata.picture],
      2048,
    ),
    primaryProvider: firstText(
      [
        authSyncProvider(user.app_metadata?.provider),
        user.identities?.find(
          (identity) => authSyncProvider(identity.provider) !== null,
        )?.provider,
        input.provider,
      ],
      64,
    ),
  }
}

function authSyncProvider(value: unknown): AuthSyncProvider | null {
  if (typeof value !== 'string') return null
  return AUTH_SYNC_PROVIDERS.includes(value as AuthSyncProvider)
    ? (value as AuthSyncProvider)
    : null
}

function firstText(values: unknown[], maxLength: number) {
  for (const value of values) {
    if (typeof value !== 'string') continue
    const trimmed = value.trim()
    if (!trimmed) continue
    return trimmed.slice(0, maxLength)
  }
  return null
}

function normalizeProfileRow(row: ProfileRow | null): ProfileRow {
  if (!row) {
    throw new Error('Expected profile row.')
  }
  return {
    ...row,
    nickname: row.nickname ?? null,
  }
}

function ageFromBirthDate(birthDate: string): number | null {
  const parsed = new Date(`${birthDate}T00:00:00Z`)
  if (Number.isNaN(parsed.getTime())) return null
  // 잘못된 날짜의 롤오버 방지 (예: '2001-02-29' → 2001-03-01). 컨트롤러 z.iso.date()와
  // 별개로 서비스 자체에서도 방어한다.
  if (parsed.toISOString().slice(0, 10) !== birthDate) return null
  return calculateAge(parsed)
}

function grantedConsentRows(
  userId: string,
  consents: CompleteSignupInput['consents'],
  acceptedAt: string,
) {
  return CONSENT_TYPES.filter((type) => consents[type]).map((type) => ({
    user_id: userId,
    consent_type: type,
    version: CURRENT_CONSENT_VERSIONS[type],
    accepted_at: acceptedAt,
    source: CONSENT_SOURCE_SIGNUP,
  }))
}
