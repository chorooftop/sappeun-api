-- 0006_bingo_editable_badges.sql
-- Adds: boards.customization_status, board_cells original columns,
--       mission_badges / board_badges / user_badges tables,
--       RLS policies, award_board_badges RPC, catalog seed.
-- Style: matches 0001/0004/0005 (lowercase, do-block constraint guards,
--         security definer set search_path to 'public',
--         function-level revoke/grant, explicit least-privilege table grants).

-- ---------------------------------------------------------------------------
-- 1. boards: customization_status + title length check
-- ---------------------------------------------------------------------------

alter table public.boards
  add column if not exists customization_status text not null default 'official';

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'boards_customization_status_check'
      and conrelid = 'public.boards'::regclass
  ) then
    alter table public.boards
      add constraint boards_customization_status_check
      check (customization_status = any (array['official'::text, 'edited'::text]));
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'boards_title_length_check'
      and conrelid = 'public.boards'::regclass
  ) then
    alter table public.boards
      add constraint boards_title_length_check
      check (title is null or char_length(title) <= 24);
  end if;
end $$;

-- backfill: 기존 custom board는 edited로 표시
update public.boards
   set customization_status = 'edited'
 where board_kind = 'custom' and customization_status = 'official';

-- NOTE: edited_cell_count column은 만들지 않는다 (read-time 파생, CORR-5).
-- predicate: board_cells.original_mission_snapshot IS NOT NULL

-- ---------------------------------------------------------------------------
-- 2. board_cells: original snapshot / edit tracking columns
-- ---------------------------------------------------------------------------

alter table public.board_cells
  add column if not exists original_cell_id text,
  add column if not exists original_mission_snapshot jsonb,
  add column if not exists edited_at timestamptz;

-- ---------------------------------------------------------------------------
-- 3. mission_badges
-- ---------------------------------------------------------------------------

create table if not exists public.mission_badges (
  id text primary key,
  mission_id text not null,
  catalog_version text not null,
  title text not null,
  category text,
  difficulty text not null,
  grade_label text not null,
  grade_color text not null,
  artwork_key text,
  sort_order integer not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  constraint mission_badges_difficulty_check
    check (difficulty = any (array['easy'::text, 'medium'::text, 'hard'::text])),
  constraint mission_badges_title_check
    check (char_length(title) <= 40),
  unique (catalog_version, mission_id)
);

-- ---------------------------------------------------------------------------
-- 4. board_badges
-- ---------------------------------------------------------------------------

create table if not exists public.board_badges (
  board_id uuid not null references public.boards(id) on delete cascade,
  badge_id text not null references public.mission_badges(id) on delete restrict,
  user_id uuid not null references auth.users(id) on delete cascade,
  earned_at timestamptz not null default now(),
  primary key (board_id, badge_id)
);

create index if not exists board_badges_user_board_idx
  on public.board_badges (user_id, board_id);

-- NOTE: boards is soft-delete only (deleted_at). on delete cascade on board_id
-- is a safety net only; it will not fire in normal operation (CORR-9).

-- ---------------------------------------------------------------------------
-- 5. user_badges
-- ---------------------------------------------------------------------------

create table if not exists public.user_badges (
  user_id uuid not null references auth.users(id) on delete cascade,
  badge_id text not null references public.mission_badges(id) on delete restrict,
  first_board_id uuid references public.boards(id) on delete set null,
  last_board_id uuid references public.boards(id) on delete set null,
  first_earned_at timestamptz not null default now(),
  last_earned_at timestamptz not null default now(),
  earned_count integer not null default 1,
  primary key (user_id, badge_id),
  constraint user_badges_earned_count_check
    check (earned_count >= 1)
);

-- ---------------------------------------------------------------------------
-- 6. RLS enable + explicit grants + policies
-- ---------------------------------------------------------------------------

alter table public.mission_badges enable row level security;
alter table public.board_badges enable row level security;
alter table public.user_badges enable row level security;

-- The API server uses the service-role client for badge reads/writes. The
-- project default ACL currently grants broad table privileges to anon and
-- authenticated, so explicitly revoke them for these new backend-owned tables.
revoke all on table public.mission_badges, public.board_badges, public.user_badges
  from public, anon, authenticated;

grant select, insert, update, delete
  on table public.mission_badges, public.board_badges, public.user_badges
  to service_role;

-- Authenticated users can read active catalog entries if table SELECT is
-- deliberately granted later. Backend API reads use service_role and bypass RLS.
create policy mission_badges_select_active on public.mission_badges
  for select
  to authenticated
  using (active = true);

-- Users can only read their own board badge records if direct client SELECT is
-- deliberately granted later.
create policy board_badges_select_own on public.board_badges
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

-- Users can only read their own user badge collection if direct client SELECT
-- is deliberately granted later.
create policy user_badges_select_own on public.user_badges
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

-- Rationale: new badge tables are backend-owned for v1. RLS policies are kept
-- as defense-in-depth and future direct-read scaffolding, but table privileges
-- remain closed to anon/authenticated unless a later migration explicitly opens
-- read access.

-- ---------------------------------------------------------------------------
-- 7. RPC award_board_badges (CORR-1, matches 0004/0005 pattern)
-- ---------------------------------------------------------------------------

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
    select p_board_id, b, p_user_id, v_now
      from unnest(p_badge_ids) as b
    on conflict (board_id, badge_id) do nothing
    returning board_badges.badge_id
  ),
  rolled as (
    insert into public.user_badges (
      user_id, badge_id, first_board_id, last_board_id,
      first_earned_at, last_earned_at, earned_count
    )
    select p_user_id, i.badge_id, p_board_id, p_board_id, v_now, v_now, 1
      from inserted i
    on conflict (user_id, badge_id) do update
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

-- ---------------------------------------------------------------------------
-- 8. Catalog seed (catalog_version = 'api-migration-v1')
--    Source: sappeun-frontend/apps/mobile/assets/data/sheet.json v1.3.0
--    badge id format: mission:<id>:v1
--    Excluded: id='free', category='special' (center free slot, not a mission).
--    47 missions seeded (48 total cells minus 1 free slot).
--
-- difficulty mapping:
--   sf01–sf05, sf08, sf09 → 'easy'  (explicit in sheet.json)
--   sf06, sf07            → 'medium' (explicit in sheet.json)
--   n*, m*, a*, t*, c*   → 'easy'   (no difficulty field in sheet.json)
-- V1 seed decision: the 38 non-self missions without difficulty in
-- sheet.json v1.3.0 default to 'easy'. Override in a future catalog migration
-- if product/design assigns per-mission difficulty later.
--
-- grade_label / grade_color:
--   easy   → '일상 배지', '#6ED6A0'
--   medium → '도전 배지', '#F5A623'
--   hard   → '탐험 배지', '#E05353'  -- no hard missions in v1.3
-- ---------------------------------------------------------------------------

insert into public.mission_badges (
  id, mission_id, catalog_version, title, category,
  difficulty, grade_label, grade_color, artwork_key, sort_order, active
)
values
  -- nature (n01–n08) — difficulty: easy (v1 default, no difficulty in sheet)
  ('mission:n01:v1', 'n01', 'api-migration-v1', '꽃',         'nature', 'easy', '일상 배지', '#6ED6A0', 'mission/n01',  10, true),
  ('mission:n02:v1', 'n02', 'api-migration-v1', '나뭇잎',     'nature', 'easy', '일상 배지', '#6ED6A0', 'mission/n02',  20, true),
  ('mission:n03:v1', 'n03', 'api-migration-v1', '민들레',     'nature', 'easy', '일상 배지', '#6ED6A0', 'mission/n03',  30, true),
  ('mission:n04:v1', 'n04', 'api-migration-v1', '화분',       'nature', 'easy', '일상 배지', '#6ED6A0', 'mission/n04',  40, true),
  ('mission:n05:v1', 'n05', 'api-migration-v1', '나무',       'nature', 'easy', '일상 배지', '#6ED6A0', 'mission/n05',  50, true),
  ('mission:n06:v1', 'n06', 'api-migration-v1', '구름',       'nature', 'easy', '일상 배지', '#6ED6A0', 'mission/n06',  60, true),
  ('mission:n07:v1', 'n07', 'api-migration-v1', '햇빛',       'nature', 'easy', '일상 배지', '#6ED6A0', 'mission/n07',  70, true),
  ('mission:n08:v1', 'n08', 'api-migration-v1', '무지개',     'nature', 'easy', '일상 배지', '#6ED6A0', 'mission/n08',  80, true),

  -- manmade (m01–m10) — difficulty: easy (v1 default, no difficulty in sheet)
  ('mission:m01:v1', 'm01', 'api-migration-v1', '자판기',     'manmade', 'easy', '일상 배지', '#6ED6A0', 'mission/m01',  90, true),
  ('mission:m02:v1', 'm02', 'api-migration-v1', '표지판',     'manmade', 'easy', '일상 배지', '#6ED6A0', 'mission/m02', 100, true),
  ('mission:m03:v1', 'm03', 'api-migration-v1', '공중전화',   'manmade', 'easy', '일상 배지', '#6ED6A0', 'mission/m03', 110, true),
  ('mission:m04:v1', 'm04', 'api-migration-v1', '우체통',     'manmade', 'easy', '일상 배지', '#6ED6A0', 'mission/m04', 120, true),
  ('mission:m05:v1', 'm05', 'api-migration-v1', '가로등',     'manmade', 'easy', '일상 배지', '#6ED6A0', 'mission/m05', 130, true),
  ('mission:m06:v1', 'm06', 'api-migration-v1', '자전거',     'manmade', 'easy', '일상 배지', '#6ED6A0', 'mission/m06', 140, true),
  ('mission:m07:v1', 'm07', 'api-migration-v1', '우산',       'manmade', 'easy', '일상 배지', '#6ED6A0', 'mission/m07', 150, true),
  ('mission:m08:v1', 'm08', 'api-migration-v1', '의자',       'manmade', 'easy', '일상 배지', '#6ED6A0', 'mission/m08', 160, true),
  ('mission:m09:v1', 'm09', 'api-migration-v1', '벽화',       'manmade', 'easy', '일상 배지', '#6ED6A0', 'mission/m09', 170, true),
  ('mission:m10:v1', 'm10', 'api-migration-v1', '횡단보도',   'manmade', 'easy', '일상 배지', '#6ED6A0', 'mission/m10', 180, true),

  -- animal (a01–a06) — difficulty: easy (v1 default, no difficulty in sheet)
  ('mission:a01:v1', 'a01', 'api-migration-v1', '고양이',     'animal', 'easy', '일상 배지', '#6ED6A0', 'mission/a01', 190, true),
  ('mission:a02:v1', 'a02', 'api-migration-v1', '강아지',     'animal', 'easy', '일상 배지', '#6ED6A0', 'mission/a02', 200, true),
  ('mission:a03:v1', 'a03', 'api-migration-v1', '참새',       'animal', 'easy', '일상 배지', '#6ED6A0', 'mission/a03', 210, true),
  ('mission:a04:v1', 'a04', 'api-migration-v1', '나비',       'animal', 'easy', '일상 배지', '#6ED6A0', 'mission/a04', 220, true),
  ('mission:a05:v1', 'a05', 'api-migration-v1', '비둘기',     'animal', 'easy', '일상 배지', '#6ED6A0', 'mission/a05', 230, true),
  ('mission:a06:v1', 'a06', 'api-migration-v1', '물고기',     'animal', 'easy', '일상 배지', '#6ED6A0', 'mission/a06', 240, true),

  -- time (t01–t06) — difficulty: easy (v1 default, no difficulty in sheet)
  ('mission:t01:v1', 't01', 'api-migration-v1', '7',         'time', 'easy', '일상 배지', '#6ED6A0', 'mission/t01', 250, true),
  ('mission:t02:v1', 't02', 'api-migration-v1', '5',         'time', 'easy', '일상 배지', '#6ED6A0', 'mission/t02', 260, true),
  ('mission:t03:v1', 't03', 'api-migration-v1', 'T',         'time', 'easy', '일상 배지', '#6ED6A0', 'mission/t03', 270, true),
  ('mission:t04:v1', 't04', 'api-migration-v1', '시계',       'time', 'easy', '일상 배지', '#6ED6A0', 'mission/t04', 280, true),
  ('mission:t05:v1', 't05', 'api-migration-v1', '달',         'time', 'easy', '일상 배지', '#6ED6A0', 'mission/t05', 290, true),
  ('mission:t06:v1', 't06', 'api-migration-v1', '별',         'time', 'easy', '일상 배지', '#6ED6A0', 'mission/t06', 300, true),

  -- self (sf01–sf09) — difficulty explicit in sheet.json
  -- easy: sf01,sf02,sf03,sf04,sf05,sf08,sf09 | medium: sf06,sf07
  ('mission:sf01:v1', 'sf01', 'api-migration-v1', '활짝 웃은 셀카', 'self', 'easy',   '일상 배지', '#6ED6A0', 'mission/sf01', 310, true),
  ('mission:sf02:v1', 'sf02', 'api-migration-v1', '손가락 하트',     'self', 'easy',   '일상 배지', '#6ED6A0', 'mission/sf02', 320, true),
  ('mission:sf03:v1', 'sf03', 'api-migration-v1', '엄지척 셀카',     'self', 'easy',   '일상 배지', '#6ED6A0', 'mission/sf03', 330, true),
  ('mission:sf04:v1', 'sf04', 'api-migration-v1', '브이 포즈',       'self', 'easy',   '일상 배지', '#6ED6A0', 'mission/sf04', 340, true),
  ('mission:sf05:v1', 'sf05', 'api-migration-v1', '오늘의 신발',     'self', 'easy',   '일상 배지', '#6ED6A0', 'mission/sf05', 350, true),
  ('mission:sf06:v1', 'sf06', 'api-migration-v1', '내 그림자',       'self', 'medium', '도전 배지', '#F5A623', 'mission/sf06', 360, true),
  ('mission:sf07:v1', 'sf07', 'api-migration-v1', '거울 셀카',       'self', 'medium', '도전 배지', '#F5A623', 'mission/sf07', 370, true),
  ('mission:sf08:v1', 'sf08', 'api-migration-v1', '표정 셀카',       'self', 'easy',   '일상 배지', '#6ED6A0', 'mission/sf08', 380, true),
  ('mission:sf09:v1', 'sf09', 'api-migration-v1', '옷 색 셀카',      'self', 'easy',   '일상 배지', '#6ED6A0', 'mission/sf09', 390, true),

  -- color (c01–c08) — difficulty: easy (v1 default, no difficulty in sheet)
  ('mission:c01:v1', 'c01', 'api-migration-v1', '빨간색',     'color', 'easy', '일상 배지', '#6ED6A0', 'mission/c01', 400, true),
  ('mission:c02:v1', 'c02', 'api-migration-v1', '노란색',     'color', 'easy', '일상 배지', '#6ED6A0', 'mission/c02', 410, true),
  ('mission:c03:v1', 'c03', 'api-migration-v1', '초록색',     'color', 'easy', '일상 배지', '#6ED6A0', 'mission/c03', 420, true),
  ('mission:c04:v1', 'c04', 'api-migration-v1', '파란색',     'color', 'easy', '일상 배지', '#6ED6A0', 'mission/c04', 430, true),
  ('mission:c05:v1', 'c05', 'api-migration-v1', '분홍색',     'color', 'easy', '일상 배지', '#6ED6A0', 'mission/c05', 440, true),
  ('mission:c06:v1', 'c06', 'api-migration-v1', '하얀색',     'color', 'easy', '일상 배지', '#6ED6A0', 'mission/c06', 450, true),
  ('mission:c07:v1', 'c07', 'api-migration-v1', '검은색',     'color', 'easy', '일상 배지', '#6ED6A0', 'mission/c07', 460, true),
  ('mission:c08:v1', 'c08', 'api-migration-v1', '알록달록',   'color', 'easy', '일상 배지', '#6ED6A0', 'mission/c08', 470, true)
on conflict (catalog_version, mission_id) do update
  set title       = excluded.title,
      category    = excluded.category,
      difficulty  = excluded.difficulty,
      grade_label = excluded.grade_label,
      grade_color = excluded.grade_color,
      artwork_key = excluded.artwork_key,
      sort_order  = excluded.sort_order,
      active      = excluded.active;
