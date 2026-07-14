-- 0021_connection_groups.sql
-- Connections & shared bingo, step 1/5: connection groups + memberships.
-- Style: matches 0001/0006/0020 (lowercase, do-block constraint guards,
--        security definer set search_path, function-level revoke/grant,
--        backend-owned tables closed to anon/authenticated).
-- Plan: plans/connections-shared-bingo-implementation.md (§1-0021)

-- ---------------------------------------------------------------------------
-- 1. connection_groups
-- ---------------------------------------------------------------------------

create table if not exists public.connection_groups (
  id uuid primary key default extensions.uuid_generate_v4(),
  name text not null,
  relationship_label text not null,
  theme text,
  emoji text,
  -- set null (not cascade): a creator's account deletion must not destroy a
  -- group that other members still use. Group lifecycle is soft-delete only
  -- (deleted_at set when the last member leaves — see leave_group RPC, 0025).
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint connection_groups_name_length_check
    check (char_length(name) between 1 and 40),
  constraint connection_groups_relationship_label_check
    check (relationship_label = any (
      array['lover'::text, 'friend'::text, 'family'::text, 'custom'::text]
    ))
);

-- ---------------------------------------------------------------------------
-- 2. connection_group_members
--    PK (group_id, user_id): rejoin reactivates the row (left_at -> null).
--    left_at null = active membership.
-- ---------------------------------------------------------------------------

create table if not exists public.connection_group_members (
  group_id uuid not null references public.connection_groups(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  joined_at timestamptz not null default now(),
  left_at timestamptz,
  primary key (group_id, user_id)
);

create index if not exists connection_group_members_user_active_idx
  on public.connection_group_members (user_id)
 where left_at is null;

-- ---------------------------------------------------------------------------
-- 3. is_active_group_member helper
--    SECURITY DEFINER is required: connection_group_members' own SELECT policy
--    calls this helper, and without definer the policy evaluation would
--    re-enter the same table's RLS ("infinite recursion detected in policy").
--    Membership in a soft-deleted group is impossible by invariant (the last
--    leave_group sets left_at before deleted_at), so no group join needed here.
-- ---------------------------------------------------------------------------

create or replace function public.is_active_group_member(
  p_group_id uuid,
  p_user_id uuid
) returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
      from public.connection_group_members m
     where m.group_id = p_group_id
       and m.user_id = p_user_id
       and m.left_at is null
  );
$$;

revoke all on function public.is_active_group_member(uuid, uuid)
  from public, anon;
-- authenticated needs execute so RLS policies can evaluate the helper.
grant execute on function public.is_active_group_member(uuid, uuid)
  to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. RLS enable + explicit grants + policies
--    Backend API reads/writes use service_role and bypass RLS. Policies are
--    defense-in-depth against direct PostgREST access (0006 rationale).
-- ---------------------------------------------------------------------------

alter table public.connection_groups enable row level security;
alter table public.connection_group_members enable row level security;

revoke all on table public.connection_groups, public.connection_group_members
  from public, anon, authenticated;

grant select, insert, update, delete
  on table public.connection_groups, public.connection_group_members
  to service_role;

create policy connection_groups_select_member on public.connection_groups
  for select
  to authenticated
  using (
    deleted_at is null
    and public.is_active_group_member(id, (select auth.uid()))
  );

create policy connection_group_members_select_member on public.connection_group_members
  for select
  to authenticated
  using (public.is_active_group_member(group_id, (select auth.uid())));

notify pgrst, 'reload schema';
