-- 0023_group_boards.sql
-- Connections & shared bingo, step 3/5: group boards, cells, per-member cell
-- media, badge fanout, and the streak completion ledger.
-- Monotonic invariants (AC-14):
--   * group_board_cells.completed_at — set once at first media confirm, never
--     reset (even if every media row is later deleted).
--   * group_boards.first_media_at — reroll lock anchor, set once, never reset.
--   * group_board_completions — per-user completion ledger written at close
--     time; streaks derive from it, so leaving/rejoining a group never
--     rewrites past streak dates.
-- Plan: plans/connections-shared-bingo-implementation.md (§1-0023)

-- ---------------------------------------------------------------------------
-- 1. group_boards
-- ---------------------------------------------------------------------------

create table if not exists public.group_boards (
  id uuid primary key default extensions.uuid_generate_v4(),
  group_id uuid not null references public.connection_groups(id) on delete cascade,
  daily_date date not null,
  mode public.board_mode not null default '3x3',
  seed_recipe text not null,
  cell_ids text[],
  free_position integer,
  reroll_count integer not null default 0,
  first_media_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  ended_at timestamptz,
  end_reason text,
  deleted_at timestamptz,
  constraint group_boards_free_position_check
    check (free_position is null or (free_position >= 0 and free_position < 9)),
  constraint group_boards_end_reason_check
    check (
      end_reason is null
      or end_reason in ('completed', 'auto_grace_expired')
    )
);

-- AC-7: at most one live board per (group, day); concurrent creators converge
-- via 23505 catch + re-select in get_or_create_group_board (0025).
create unique index if not exists group_boards_group_daily_uidx
  on public.group_boards (group_id, daily_date)
 where deleted_at is null;

create index if not exists group_boards_group_idx
  on public.group_boards (group_id, daily_date desc);

-- ---------------------------------------------------------------------------
-- 2. group_board_cells
--    Mirrors board_cells mission snapshot columns; no photo_id/clip_id here —
--    per-member media lives in group_board_cell_media.
-- ---------------------------------------------------------------------------

create table if not exists public.group_board_cells (
  group_board_id uuid not null references public.group_boards(id) on delete cascade,
  "position" integer not null,
  cell_id text not null,
  mission_label text,
  mission_capture_label text,
  mission_category text,
  mission_caption text,
  mission_hint text,
  mission_icon text,
  mission_snapshot jsonb,
  mission_catalog_version text,
  completed_at timestamptz,
  completed_by uuid references auth.users(id) on delete set null,
  completion_type text,
  primary key (group_board_id, "position"),
  constraint group_board_cells_position_check
    check ("position" >= 0 and "position" < 9),
  constraint group_board_cells_completion_type_check
    check (
      completion_type is null
      or completion_type = any (
        array['photo'::text, 'clip'::text, 'free'::text]
      )
    )
);

-- ---------------------------------------------------------------------------
-- 3. group_board_cell_media
--    N media per cell, at most one live entry per member per cell.
--    deleted_at = owner-initiated removal (AC-14: cell completion survives).
-- ---------------------------------------------------------------------------

create table if not exists public.group_board_cell_media (
  id uuid primary key default extensions.uuid_generate_v4(),
  group_board_id uuid not null,
  "position" integer not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  photo_id uuid references public.photos(id) on delete cascade,
  clip_id uuid references public.clips(id) on delete cascade,
  created_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint group_board_cell_media_target_check
    check ((photo_id is not null) <> (clip_id is not null)),
  constraint group_board_cell_media_cell_fk
    foreign key (group_board_id, "position")
    references public.group_board_cells (group_board_id, "position")
    on delete cascade
);

create unique index if not exists group_board_cell_media_member_uidx
  on public.group_board_cell_media (group_board_id, "position", user_id)
 where deleted_at is null;

create index if not exists group_board_cell_media_photo_idx
  on public.group_board_cell_media (photo_id);

create index if not exists group_board_cell_media_clip_idx
  on public.group_board_cell_media (clip_id);

-- ---------------------------------------------------------------------------
-- 4. group_board_badges
--    Per-member badge fanout. board_badges cannot be reused: its board_id is
--    an FK to public.boards. mission_id anchor matches 0017.
-- ---------------------------------------------------------------------------

create table if not exists public.group_board_badges (
  group_board_id uuid not null references public.group_boards(id) on delete cascade,
  mission_id text not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  earned_at timestamptz not null default now(),
  primary key (group_board_id, mission_id, user_id),
  constraint group_board_badges_mission_fk
    foreign key (mission_id)
    references public.mission_content (mission_id)
    on update cascade
    on delete restrict
);

create index if not exists group_board_badges_user_idx
  on public.group_board_badges (user_id);

create index if not exists group_board_badges_mission_idx
  on public.group_board_badges (mission_id);

-- ---------------------------------------------------------------------------
-- 5. group_board_completions — streak ledger
--    Written once per (board, close-time active member) by
--    award_group_board_badges (0025). daily_date is denormalized from the
--    board so the streak query needs no join. Rows are immutable: leaving or
--    rejoining the group never rewrites them (AC-14).
-- ---------------------------------------------------------------------------

create table if not exists public.group_board_completions (
  group_board_id uuid not null references public.group_boards(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  group_id uuid not null references public.connection_groups(id) on delete cascade,
  daily_date date not null,
  completed_at timestamptz not null,
  primary key (group_board_id, user_id)
);

create index if not exists group_board_completions_user_daily_idx
  on public.group_board_completions (user_id, daily_date desc);

-- Streak queries need distinct dates: a user in K groups has up to K ledger
-- rows per day, so a row-based LIMIT would shrink the lookback window to
-- ~370/K days. This view collapses to one row per (user, date).
create or replace view public.group_board_completion_dates as
select distinct user_id, daily_date
  from public.group_board_completions;

revoke all on table public.group_board_completion_dates
  from public, anon, authenticated;

grant select on table public.group_board_completion_dates to service_role;

-- ---------------------------------------------------------------------------
-- 6. RLS enable + explicit grants + policies (0006 rationale)
-- ---------------------------------------------------------------------------

alter table public.group_boards enable row level security;
alter table public.group_board_cells enable row level security;
alter table public.group_board_cell_media enable row level security;
alter table public.group_board_badges enable row level security;
alter table public.group_board_completions enable row level security;

revoke all on table
  public.group_boards,
  public.group_board_cells,
  public.group_board_cell_media,
  public.group_board_badges,
  public.group_board_completions
  from public, anon, authenticated;

grant select, insert, update, delete
  on table
    public.group_boards,
    public.group_board_cells,
    public.group_board_cell_media,
    public.group_board_badges,
    public.group_board_completions
  to service_role;

create policy group_boards_select_member on public.group_boards
  for select
  to authenticated
  using (public.is_active_group_member(group_id, (select auth.uid())));

create policy group_board_cells_select_member on public.group_board_cells
  for select
  to authenticated
  using (
    exists (
      select 1
        from public.group_boards gb
       where gb.id = group_board_id
         and public.is_active_group_member(gb.group_id, (select auth.uid()))
    )
  );

create policy group_board_cell_media_select_member on public.group_board_cell_media
  for select
  to authenticated
  using (
    exists (
      select 1
        from public.group_boards gb
       where gb.id = group_board_id
         and public.is_active_group_member(gb.group_id, (select auth.uid()))
    )
  );

create policy group_board_badges_select on public.group_board_badges
  for select
  to authenticated
  using (
    (select auth.uid()) = user_id
    or exists (
      select 1
        from public.group_boards gb
       where gb.id = group_board_id
         and public.is_active_group_member(gb.group_id, (select auth.uid()))
    )
  );

-- Own-row access outlives membership: a user who left the group can still
-- read their own streak ledger entries.
create policy group_board_completions_select on public.group_board_completions
  for select
  to authenticated
  using (
    (select auth.uid()) = user_id
    or public.is_active_group_member(group_id, (select auth.uid()))
  );

notify pgrst, 'reload schema';
