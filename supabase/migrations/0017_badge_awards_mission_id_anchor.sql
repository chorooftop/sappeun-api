-- Convert earned badge references from synthetic badge_id to mission_id.
--
-- The function signature remains award_board_badges(uuid, uuid, text[]); the
-- text[] payload is now interpreted as mission_id[] and the returned badge_id
-- column carries that mission_id for API compatibility.

begin;

do $$
begin
  if not exists (
    select 1
      from pg_constraint
     where conname = 'mission_content_mission_id_key'
       and conrelid = 'public.mission_content'::regclass
  ) then
    alter table public.mission_content
      add constraint mission_content_mission_id_key unique (mission_id);
  end if;
end $$;

alter table public.user_badges
  add column if not exists mission_id text,
  add column if not exists earned_catalog_version text;

alter table public.board_badges
  add column if not exists mission_id text;

update public.user_badges
   set mission_id = split_part(badge_id, ':', 2)
 where mission_id is null;

update public.board_badges
   set mission_id = split_part(badge_id, ':', 2)
 where mission_id is null;

update public.user_badges u
   set earned_catalog_version = b.catalog_version
  from public.mission_badges b
 where u.badge_id = b.id
   and u.earned_catalog_version is null;

update public.user_badges
   set earned_catalog_version = split_part(badge_id, ':', 3)
 where earned_catalog_version is null;

do $$
begin
  if exists (
    select 1
      from public.user_badges u
     where u.badge_id !~ '^mission:[a-z0-9]+:v1$'
        or u.mission_id is null
        or not exists (
          select 1 from public.mission_content m
           where m.mission_id = u.mission_id
        )
  ) or exists (
    select 1
      from public.board_badges b
     where b.badge_id !~ '^mission:[a-z0-9]+:v1$'
        or b.mission_id is null
        or not exists (
          select 1 from public.mission_content m
           where m.mission_id = b.mission_id
        )
  ) then
    raise exception 'badge_id to mission_id backfill incomplete or orphaned';
  end if;
end $$;

drop index if exists public.board_badges_badge_idx;
drop index if exists public.user_badges_badge_idx;

alter table public.user_badges
  drop constraint user_badges_pkey,
  drop column badge_id;

alter table public.board_badges
  drop constraint board_badges_pkey,
  drop column badge_id;

alter table public.user_badges
  alter column mission_id set not null,
  add constraint user_badges_pkey primary key (user_id, mission_id),
  add constraint user_badges_mission_fk foreign key (mission_id)
    references public.mission_content (mission_id)
    on update cascade
    on delete restrict;

alter table public.board_badges
  alter column mission_id set not null,
  add constraint board_badges_pkey primary key (board_id, mission_id),
  add constraint board_badges_mission_fk foreign key (mission_id)
    references public.mission_content (mission_id)
    on update cascade
    on delete restrict;

alter table public.board_badges enable row level security;
alter table public.user_badges enable row level security;

revoke all on table public.board_badges, public.user_badges
  from public, anon, authenticated;

grant select, insert, update, delete
  on table public.board_badges, public.user_badges
  to service_role;

create index if not exists board_badges_mission_idx
  on public.board_badges (mission_id);

create index if not exists user_badges_mission_idx
  on public.user_badges (mission_id);

create index if not exists user_badges_first_board_idx
  on public.user_badges (first_board_id);

create index if not exists user_badges_last_board_idx
  on public.user_badges (last_board_id);

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
    insert into public.board_badges (board_id, mission_id, user_id, earned_at)
    select p_board_id, mission_input.mission_id, p_user_id, v_now
      from unnest(p_badge_ids) as mission_input(mission_id)
      join public.mission_content m
        on m.mission_id = mission_input.mission_id
       and m.awards_badge = true
       and m.active = true
    on conflict on constraint board_badges_pkey do nothing
    returning board_badges.mission_id
  ),
  rolled as (
    insert into public.user_badges (
      user_id, mission_id, earned_catalog_version, first_board_id,
      last_board_id, first_earned_at, last_earned_at, earned_count
    )
    select p_user_id, i.mission_id, m.catalog_version, p_board_id,
           p_board_id, v_now, v_now, 1
      from inserted i
      join public.mission_content m on m.mission_id = i.mission_id
    on conflict on constraint user_badges_pkey do update
      set earned_count   = user_badges.earned_count + 1,
          last_earned_at = excluded.last_earned_at,
          last_board_id  = excluded.last_board_id
    returning user_badges.mission_id, (user_badges.earned_count = 1) as is_first_earn
  )
  select r.mission_id as badge_id, r.is_first_earn from rolled r;
end;
$$;

revoke all on function public.award_board_badges(uuid, uuid, text[]) from public;
revoke all on function public.award_board_badges(uuid, uuid, text[]) from anon;
revoke all on function public.award_board_badges(uuid, uuid, text[]) from authenticated;
grant execute on function public.award_board_badges(uuid, uuid, text[]) to service_role;

commit;

notify pgrst, 'reload schema';
