-- 0022_connection_invites_requests.sql
-- Connections & shared bingo, step 2/5: invite codes + join requests.
-- Invite codes: 8 chars, shares alphabet, unique, expire 7 days after issue
-- (TTL enforced by the issuing service + request_group_join RPC, 0025).
-- Plan: plans/connections-shared-bingo-implementation.md (§1-0022)

-- ---------------------------------------------------------------------------
-- 1. connection_group_invites
-- ---------------------------------------------------------------------------

create table if not exists public.connection_group_invites (
  id uuid primary key default extensions.uuid_generate_v4(),
  group_id uuid not null references public.connection_groups(id) on delete cascade,
  invite_code text not null,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  constraint connection_group_invites_code_length_check
    check (char_length(invite_code) = 8)
);

create unique index if not exists connection_group_invites_code_uidx
  on public.connection_group_invites (invite_code);

create index if not exists connection_group_invites_group_idx
  on public.connection_group_invites (group_id);

-- ---------------------------------------------------------------------------
-- 2. connection_group_join_requests
--    Partial unique keeps at most one pending request per (group, user);
--    decided (approved/rejected) rows remain as history.
-- ---------------------------------------------------------------------------

create table if not exists public.connection_group_join_requests (
  id uuid primary key default extensions.uuid_generate_v4(),
  group_id uuid not null references public.connection_groups(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  invite_id uuid references public.connection_group_invites(id) on delete set null,
  status text not null default 'pending',
  decided_by uuid references auth.users(id) on delete set null,
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  constraint connection_group_join_requests_status_check
    check (status = any (array['pending'::text, 'approved'::text, 'rejected'::text]))
);

create unique index if not exists connection_group_join_requests_pending_uidx
  on public.connection_group_join_requests (group_id, user_id)
 where status = 'pending';

create index if not exists connection_group_join_requests_group_pending_idx
  on public.connection_group_join_requests (group_id)
 where status = 'pending';

create index if not exists connection_group_join_requests_user_idx
  on public.connection_group_join_requests (user_id);

-- ---------------------------------------------------------------------------
-- 3. RLS enable + explicit grants + policies (0006 rationale)
-- ---------------------------------------------------------------------------

alter table public.connection_group_invites enable row level security;
alter table public.connection_group_join_requests enable row level security;

revoke all on table
  public.connection_group_invites,
  public.connection_group_join_requests
  from public, anon, authenticated;

grant select, insert, update, delete
  on table
    public.connection_group_invites,
    public.connection_group_join_requests
  to service_role;

create policy connection_group_invites_select_member on public.connection_group_invites
  for select
  to authenticated
  using (public.is_active_group_member(group_id, (select auth.uid())));

-- Group members review incoming requests; requesters can see their own.
create policy connection_group_join_requests_select on public.connection_group_join_requests
  for select
  to authenticated
  using (
    (select auth.uid()) = user_id
    or public.is_active_group_member(group_id, (select auth.uid()))
  );

notify pgrst, 'reload schema';
