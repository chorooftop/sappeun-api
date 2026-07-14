-- 0024_group_media_extension.sql
-- Connections & shared bingo, step 4/5: additive photos/clips extension for
-- group board targets.
--
-- XOR constraint strategy (plan v4, issue 2): NOT VALID is deliberately NOT
-- used. NOT VALID only defers the bulk validation of existing rows — the
-- check is still enforced whenever an existing row is UPDATEd, so a legacy
-- NULL/NULL photo would make its own soft-delete/confirm fail at runtime.
-- Instead we guard like 0020's dedupe guard: if polluted rows exist the
-- migration itself fails (reconcile, then redeploy), and the constraint is
-- added immediately valid. New personal photos always carry board_id
-- (ensureUserBoardForMedia throws before presign otherwise), so the new
-- constraint cannot break the existing user path.
-- Plan: plans/connections-shared-bingo-implementation.md (§1-0024)

-- ---------------------------------------------------------------------------
-- 1. Additive columns
-- ---------------------------------------------------------------------------

alter table public.photos
  add column if not exists group_board_id uuid references public.group_boards(id);

alter table public.clips
  add column if not exists group_board_id uuid references public.group_boards(id);

create index if not exists photos_group_board_idx
  on public.photos (group_board_id)
 where group_board_id is not null;

create index if not exists clips_group_board_idx
  on public.clips (group_board_id)
 where group_board_id is not null;

-- ---------------------------------------------------------------------------
-- 2. Guard: no photos row may have neither owner target.
--    Checks ALL rows (soft-deleted included) because a CHECK constraint
--    applies table-wide and fires on any later UPDATE of such a row.
-- ---------------------------------------------------------------------------

do $$
declare
  v_count bigint;
begin
  select count(*)
    into v_count
    from public.photos
   where board_id is null
     and group_board_id is null;

  if v_count > 0 then
    raise exception
      'photos rows with neither board_id nor group_board_id exist (count=%); reconcile before applying photos_owner_target_check',
      v_count;
  end if;
end $$;

do $$
begin
  if not exists (
    select 1
      from pg_constraint
     where conname = 'photos_owner_target_check'
       and conrelid = 'public.photos'::regclass
  ) then
    alter table public.photos
      add constraint photos_owner_target_check
      check ((board_id is not null) <> (group_board_id is not null));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 3. clips: add the XOR check while board_id is still NOT NULL (0001), so
--    every existing row trivially satisfies it, then drop NOT NULL for group
--    clips. Existing rows are untouched.
-- ---------------------------------------------------------------------------

do $$
declare
  v_count bigint;
begin
  select count(*)
    into v_count
    from public.clips
   where board_id is null
     and group_board_id is null;

  if v_count > 0 then
    raise exception
      'clips rows with neither board_id nor group_board_id exist (count=%); reconcile before applying clips_owner_target_check',
      v_count;
  end if;
end $$;

do $$
begin
  if not exists (
    select 1
      from pg_constraint
     where conname = 'clips_owner_target_check'
       and conrelid = 'public.clips'::regclass
  ) then
    alter table public.clips
      add constraint clips_owner_target_check
      check ((board_id is not null) <> (group_board_id is not null));
  end if;
end $$;

alter table public.clips
  alter column board_id drop not null;

notify pgrst, 'reload schema';
