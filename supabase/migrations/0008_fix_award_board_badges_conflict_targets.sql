-- 0008_fix_award_board_badges_conflict_targets.sql
-- Forward-fix for award_board_badges runtime ambiguity:
-- PL/pgSQL output column `badge_id` can conflict with unqualified ON CONFLICT
-- column references. Use explicit primary-key constraint targets.

create or replace function public.award_board_badges(
  p_user_id uuid,
  p_board_id uuid,
  p_badge_ids text[]
) returns table (badge_id text, is_first_earn boolean)
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_now timestamptz := now();
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Only service role can award badges.'
      using errcode = '42501';
  end if;

  return query
  with inserted as (
    insert into public.board_badges (board_id, badge_id, user_id, earned_at)
    select p_board_id, badge_input.badge_id, p_user_id, v_now
      from unnest(p_badge_ids) as badge_input(badge_id)
    on conflict on constraint board_badges_pkey do nothing
    returning board_badges.badge_id
  ),
  rolled as (
    insert into public.user_badges (
      user_id, badge_id, first_board_id, last_board_id,
      first_earned_at, last_earned_at, earned_count
    )
    select p_user_id, i.badge_id, p_board_id, p_board_id, v_now, v_now, 1
      from inserted i
    on conflict on constraint user_badges_pkey do update
      set earned_count   = user_badges.earned_count + 1,
          last_earned_at = excluded.last_earned_at,
          last_board_id  = excluded.last_board_id
    returning user_badges.badge_id, (user_badges.earned_count = 1) as is_first_earn
  )
  select r.badge_id, r.is_first_earn from rolled r;
end;
$$;

revoke all on function public.award_board_badges(uuid, uuid, text[]) from public;
revoke all on function public.award_board_badges(uuid, uuid, text[]) from anon;
revoke all on function public.award_board_badges(uuid, uuid, text[]) from authenticated;
grant execute on function public.award_board_badges(uuid, uuid, text[]) to service_role;
