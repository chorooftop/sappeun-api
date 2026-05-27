import { Injectable } from '@nestjs/common'
import type { User } from '@supabase/supabase-js'

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
}
