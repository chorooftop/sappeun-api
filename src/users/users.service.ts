import { Injectable } from '@nestjs/common'
import type { User } from '@supabase/supabase-js'

import { isMissingColumnError } from '@/supabase/supabase.errors'
import { SupabaseService } from '@/supabase/supabase.service'

const MAX_DISPLAY_NAME_LENGTH = 40
const MAX_NICKNAME_LENGTH = 10
const UNIQUE_VIOLATION = '23505'
const AUTH_SYNC_PROVIDERS = ['kakao', 'apple', 'google'] as const
const PROFILE_COLUMNS =
  'user_id, nickname, display_name, avatar_url, primary_provider, first_login_at, last_seen_at, signup_completed_at, onboarding_completed_at'
const PROFILE_COLUMNS_WITHOUT_NICKNAME =
  'user_id, display_name, avatar_url, primary_provider, first_login_at, last_seen_at, signup_completed_at, onboarding_completed_at'

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
    let { error } = await this.supabase.adminClient
      .from('profiles')
      .update({
        nickname,
        nickname_updated_at: now,
      })
      .eq('user_id', userId)

    if (
      error &&
      isMissingColumnError(error, ['nickname', 'nickname_updated_at'])
    ) {
      ;({ error } = await this.supabase.adminClient
        .from('profiles')
        .update({
          display_name: nickname,
          last_seen_at: now,
        })
        .eq('user_id', userId))
    }

    if (error) throw error

    return {
      profile: {
        nickname,
        nicknameUpdatedAt: now,
      },
    }
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

  private async readProfile(
    userId: string,
    includeNickname = true,
  ): Promise<ProfileRow | null> {
    const { data, error } = await this.supabase.adminClient
      .from('profiles')
      .select(
        includeNickname ? PROFILE_COLUMNS : PROFILE_COLUMNS_WITHOUT_NICKNAME,
      )
      .eq('user_id', userId)
      .maybeSingle()

    if (error && includeNickname && isMissingColumnError(error, ['nickname'])) {
      return this.readProfile(userId, false)
    }

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

    let { data, error } = await this.supabase.adminClient
      .from('profiles')
      .insert(payload)
      .select(PROFILE_COLUMNS)
      .single()

    if (error && isMissingColumnError(error, ['nickname'])) {
      const { nickname: _nickname, ...fallbackPayload } = payload
      ;({ data, error } = await this.supabase.adminClient
        .from('profiles')
        .insert(fallbackPayload)
        .select(PROFILE_COLUMNS_WITHOUT_NICKNAME)
        .single())
    }

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

    let { data, error } = await this.supabase.adminClient
      .from('profiles')
      .update(update)
      .eq('user_id', profile.user_id)
      .select(PROFILE_COLUMNS)
      .single()

    if (
      error &&
      isMissingColumnError(error, ['nickname', 'nickname_updated_at'])
    ) {
      delete update.nickname
      delete update.nickname_updated_at
      ;({ data, error } = await this.supabase.adminClient
        .from('profiles')
        .update(update)
        .eq('user_id', profile.user_id)
        .select(PROFILE_COLUMNS_WITHOUT_NICKNAME)
        .single())
    }

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
