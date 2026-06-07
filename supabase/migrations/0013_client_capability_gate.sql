-- Client capability gate for runtime-only mission and badge content.
--
-- The API enforces these columns in service code. Keeping them in DB lets
-- operators add future rows safely without app redeploys.

alter table public.mission_content
  add column if not exists min_app_build integer,
  add column if not exists required_capabilities text[] not null default '{}',
  add column if not exists active_from timestamptz,
  add column if not exists active_until timestamptz;

alter table public.mission_badges
  add column if not exists min_app_build integer,
  add column if not exists required_capabilities text[] not null default '{}',
  add column if not exists active_from timestamptz,
  add column if not exists active_until timestamptz;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'mission_content_min_app_build_check'
      and conrelid = 'public.mission_content'::regclass
  ) then
    alter table public.mission_content
      add constraint mission_content_min_app_build_check
      check (min_app_build is null or min_app_build > 0);
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'mission_badges_min_app_build_check'
      and conrelid = 'public.mission_badges'::regclass
  ) then
    alter table public.mission_badges
      add constraint mission_badges_min_app_build_check
      check (min_app_build is null or min_app_build > 0);
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'mission_content_required_capabilities_check'
      and conrelid = 'public.mission_content'::regclass
  ) then
    alter table public.mission_content
      add constraint mission_content_required_capabilities_check
      check (
        cardinality(required_capabilities) <= 50
        and array_position(required_capabilities, null) is null
      );
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'mission_badges_required_capabilities_check'
      and conrelid = 'public.mission_badges'::regclass
  ) then
    alter table public.mission_badges
      add constraint mission_badges_required_capabilities_check
      check (
        cardinality(required_capabilities) <= 50
        and array_position(required_capabilities, null) is null
      );
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'mission_content_active_window_check'
      and conrelid = 'public.mission_content'::regclass
  ) then
    alter table public.mission_content
      add constraint mission_content_active_window_check
      check (
        active_from is null
        or active_until is null
        or active_from < active_until
      );
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'mission_badges_active_window_check'
      and conrelid = 'public.mission_badges'::regclass
  ) then
    alter table public.mission_badges
      add constraint mission_badges_active_window_check
      check (
        active_from is null
        or active_until is null
        or active_from < active_until
      );
  end if;
end $$;

create index if not exists mission_content_runtime_gate_idx
  on public.mission_content (catalog_version, active, sort_order)
  where active = true;

create index if not exists mission_badges_runtime_gate_idx
  on public.mission_badges (catalog_version, active, sort_order)
  where active = true;

create index if not exists mission_content_required_capabilities_gin_idx
  on public.mission_content using gin (required_capabilities);

create index if not exists mission_badges_required_capabilities_gin_idx
  on public.mission_badges using gin (required_capabilities);

comment on column public.mission_content.min_app_build is
  'Minimum X-Sappeun-App-Build that may receive this mission content row.';

comment on column public.mission_content.required_capabilities is
  'Client capabilities required for this mission content row, e.g. runtime-artwork-v1.';

comment on column public.mission_badges.min_app_build is
  'Minimum X-Sappeun-App-Build that may receive this badge catalog row.';

comment on column public.mission_badges.required_capabilities is
  'Client capabilities required for this badge catalog row, e.g. runtime-artwork-v1.';

notify pgrst, 'reload schema';
