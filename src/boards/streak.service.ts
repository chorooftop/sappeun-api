import { Injectable } from '@nestjs/common'

import { previousKstDate } from '@/common/time/kst'
import { SupabaseService } from '@/supabase/supabase.service'

const SUPPORTED_BOARD_MODE = '3x3'
const STREAK_LOOKBACK_LIMIT = 370

/**
 * Streak derivation across personal boards UNION the group completion ledger
 * (plan v4, issue 1).
 *
 * - Group credit comes from the group_board_completion_dates view (distinct
 *   dates over the completions ledger — one row per date regardless of how
 *   many groups completed that day, so the 370-row window is a 370-DAY
 *   window) keyed by user_id alone — deliberately NOT filtered by current
 *   membership, so leaving/rejoining a group never rewrites past streak
 *   dates (AC-14) and joining late never back-fills dates from before the
 *   user was a member.
 * - daily_date is de-duplicated before the consecutive-day walk: the walk
 *   breaks on `date !== expected`, so a personal + group completion on the
 *   same day would otherwise corrupt the count.
 * - With zero ledger rows the result is identical to the personal-only
 *   algorithm in BoardsService (solo golden guarantee).
 */
@Injectable()
export class StreakService {
  constructor(private readonly supabase: SupabaseService) {}

  private get admin() {
    return this.supabase.adminClient
  }

  async computeStreakEndingAt(userId: string, dailyDate: string) {
    const [personal, group] = await Promise.all([
      this.admin
        .from('boards')
        .select('daily_date')
        .eq('user_id', userId)
        .eq('mode', SUPPORTED_BOARD_MODE)
        .eq('end_reason', 'completed')
        .is('deleted_at', null)
        .not('daily_date', 'is', null)
        .lte('daily_date', dailyDate)
        .order('daily_date', { ascending: false })
        .limit(STREAK_LOOKBACK_LIMIT),
      this.admin
        .from('group_board_completion_dates')
        .select('daily_date')
        .eq('user_id', userId)
        .lte('daily_date', dailyDate)
        .order('daily_date', { ascending: false })
        .limit(STREAK_LOOKBACK_LIMIT),
    ])

    if (personal.error) throw personal.error
    if (group.error) throw group.error

    const rows = [
      ...((personal.data ?? []) as { daily_date: string | null }[]),
      ...((group.data ?? []) as { daily_date: string | null }[]),
    ]
    const dates = [
      ...new Set(
        rows
          .map((row) => row.daily_date)
          .filter((date): date is string => Boolean(date)),
      ),
    ].sort((a, b) => (a < b ? 1 : a > b ? -1 : 0))

    let expected = dailyDate
    let streak = 0
    for (const date of dates) {
      if (date !== expected) break
      streak += 1
      expected = previousKstDate(expected)
    }

    return streak
  }
}
