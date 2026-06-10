-- Daily 3x3 bingo lifecycle metadata and atomic reroll counter.

alter table public.boards
  add column if not exists daily_date date,
  add column if not exists reroll_count integer not null default 0,
  add column if not exists end_reason text,
  add column if not exists pre_0020_hidden boolean not null default false;

do $$
begin
  if not exists (
    select 1
      from pg_constraint
     where conname = 'boards_end_reason_check'
       and conrelid = 'public.boards'::regclass
  ) then
    alter table public.boards
      add constraint boards_end_reason_check
      check (
        end_reason is null
        or end_reason in ('completed', 'auto_grace_expired')
      );
  end if;
end $$;

update public.boards
   set daily_date = (created_at at time zone 'Asia/Seoul')::date
 where daily_date is null;

update public.boards
   set end_reason = 'completed'
 where ended_at is not null
   and deleted_at is null
   and end_reason is null;

update public.boards
   set deleted_at = coalesce(deleted_at, now()),
       updated_at = now(),
       pre_0020_hidden = true
 where mode = '5x5'
   and deleted_at is null;

do $$
begin
  if exists (
    select 1
      from public.boards
     where deleted_at is null
       and daily_date is not null
     group by user_id, daily_date
    having count(*) > 1
  ) then
    raise exception 'Duplicate active boards exist for (user_id, daily_date); deduplicate before creating boards_user_daily_uidx';
  end if;
end $$;

create unique index if not exists boards_user_daily_uidx
  on public.boards(user_id, daily_date)
 where deleted_at is null;

create or replace function public.reroll_board(
  p_board_id uuid,
  p_user_id uuid,
  p_limit integer
)
returns table(reroll_count integer)
language sql
security definer
set search_path = public
as $$
  update public.boards
     set reroll_count = public.boards.reroll_count + 1,
         updated_at = now()
   where id = p_board_id
     and user_id = p_user_id
     and ended_at is null
     and deleted_at is null
     and reroll_count < p_limit
  returning public.boards.reroll_count;
$$;

revoke all on function public.reroll_board(uuid, uuid, integer)
  from public, anon, authenticated;
grant execute on function public.reroll_board(uuid, uuid, integer)
  to service_role;

notify pgrst, 'reload schema';
