import { Injectable } from '@nestjs/common'
import type { User } from '@supabase/supabase-js'

import { isMissingColumnError } from '@/supabase/supabase.errors'
import { SupabaseService } from '@/supabase/supabase.service'

@Injectable()
export class UsersService {
  constructor(private readonly supabase: SupabaseService) {}

  async getMe(user: User) {
    const { data: profile, error } = await this.supabase.adminClient
      .from('profiles')
      .select(
        'user_id, nickname, display_name, avatar_url, primary_provider, first_login_at, last_seen_at, signup_completed_at, onboarding_completed_at',
      )
      .eq('user_id', user.id)
      .maybeSingle()

    if (error) throw error

    return {
      user: {
        id: user.id,
        email: user.email ?? null,
        phone: user.phone ?? null,
      },
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
}
