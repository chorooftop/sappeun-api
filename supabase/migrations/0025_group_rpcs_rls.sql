-- 0025_group_rpcs_rls.sql
-- Connections & shared bingo, step 5/5: group RPCs.
-- All functions: plpgsql, security definer, search_path=public, service_role
-- execute only, service_role gate inside (0004/0006/0017 pattern). Caps and
-- limits are passed in by the API layer (reroll_board p_limit pattern) so env
-- stays the single source of truth. Cap checks are serialized with
-- pg_advisory_xact_lock (count-then-insert alone is racy).
-- Lock ordering (deadlock-free): member-cap(group) before user-cap(user);
-- no path acquires a group lock while holding a user lock.
--
-- close/award split (plan v4): close_group_board only flips ended_at with a
-- single-winner UPDATE; award_group_board_badges is a self-healing idempotent
-- path retried by any active member who sees a completed board without
-- group_board_completions rows. A winner crashing between close and award can
-- never permanently lose the fanout (mirrors resolveAlreadyEndedClose on the
-- personal path).
-- Plan: plans/connections-shared-bingo-implementation.md (§1-0025)

-- ---------------------------------------------------------------------------
-- 1. create_connection_group
-- ---------------------------------------------------------------------------

create or replace function public.create_connection_group(
  p_user_id uuid,
  p_name text,
  p_label text,
  p_theme text,
  p_emoji text,
  p_max_groups integer
) returns public.connection_groups
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_now timestamptz := now();
  v_group public.connection_groups;
  v_active_count integer;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Only service role can manage connection groups.'
      using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(
    hashtext('connection_group_user_cap'), hashtext(p_user_id::text)
  );

  select count(*)
    into v_active_count
    from public.connection_group_members m
    join public.connection_groups g
      on g.id = m.group_id
     and g.deleted_at is null
   where m.user_id = p_user_id
     and m.left_at is null;

  if v_active_count >= p_max_groups then
    raise exception 'GROUP_LIMIT_EXCEEDED';
  end if;

  insert into public.connection_groups (
    name, relationship_label, theme, emoji, created_by, created_at, updated_at
  )
  values (p_name, p_label, p_theme, p_emoji, p_user_id, v_now, v_now)
  returning * into v_group;

  insert into public.connection_group_members (group_id, user_id, joined_at)
  values (v_group.id, p_user_id, v_now);

  return v_group;
end;
$$;

revoke all on function public.create_connection_group(uuid, text, text, text, text, integer)
  from public, anon, authenticated;
grant execute on function public.create_connection_group(uuid, text, text, text, text, integer)
  to service_role;

-- ---------------------------------------------------------------------------
-- 2. request_group_join
-- ---------------------------------------------------------------------------

create or replace function public.request_group_join(
  p_user_id uuid,
  p_invite_code text,
  p_max_groups integer
) returns public.connection_group_join_requests
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_now timestamptz := now();
  v_invite record;
  v_request public.connection_group_join_requests;
  v_active_count integer;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Only service role can manage join requests.'
      using errcode = '42501';
  end if;

  select i.id, i.group_id, i.expires_at, i.revoked_at,
         g.deleted_at as group_deleted_at
    into v_invite
    from public.connection_group_invites i
    join public.connection_groups g on g.id = i.group_id
   where i.invite_code = p_invite_code;

  if not found then
    raise exception 'INVITE_NOT_FOUND';
  end if;

  if v_invite.group_deleted_at is not null then
    raise exception 'GROUP_DELETED';
  end if;

  if v_invite.revoked_at is not null or v_invite.expires_at <= v_now then
    raise exception 'INVITE_EXPIRED';
  end if;

  if public.is_active_group_member(v_invite.group_id, p_user_id) then
    raise exception 'ALREADY_MEMBER';
  end if;

  perform pg_advisory_xact_lock(
    hashtext('connection_group_user_cap'), hashtext(p_user_id::text)
  );

  select count(*)
    into v_active_count
    from public.connection_group_members m
    join public.connection_groups g
      on g.id = m.group_id
     and g.deleted_at is null
   where m.user_id = p_user_id
     and m.left_at is null;

  if v_active_count >= p_max_groups then
    raise exception 'GROUP_LIMIT_EXCEEDED';
  end if;

  insert into public.connection_group_join_requests (
    group_id, user_id, invite_id, status, created_at
  )
  values (v_invite.group_id, p_user_id, v_invite.id, 'pending', v_now)
  on conflict (group_id, user_id) where status = 'pending'
  do update set invite_id = excluded.invite_id
  returning * into v_request;

  return v_request;
end;
$$;

revoke all on function public.request_group_join(uuid, text, integer)
  from public, anon, authenticated;
grant execute on function public.request_group_join(uuid, text, integer)
  to service_role;

-- ---------------------------------------------------------------------------
-- 3. approve_group_join
-- ---------------------------------------------------------------------------

create or replace function public.approve_group_join(
  p_decider_id uuid,
  p_request_id uuid,
  p_max_members integer,
  p_max_groups integer
) returns public.connection_group_members
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_now timestamptz := now();
  v_request public.connection_group_join_requests;
  v_member public.connection_group_members;
  v_count integer;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Only service role can manage join requests.'
      using errcode = '42501';
  end if;

  select r.* into v_request
    from public.connection_group_join_requests r
   where r.id = p_request_id
     for update;

  if not found or v_request.status <> 'pending' then
    raise exception 'REQUEST_NOT_FOUND';
  end if;

  if not exists (
    select 1 from public.connection_groups g
     where g.id = v_request.group_id and g.deleted_at is null
  ) then
    raise exception 'GROUP_DELETED';
  end if;

  if not public.is_active_group_member(v_request.group_id, p_decider_id) then
    raise exception 'NOT_GROUP_MEMBER';
  end if;

  -- Requester already became an active member through another path: just
  -- settle the request without re-checking caps.
  if public.is_active_group_member(v_request.group_id, v_request.user_id) then
    update public.connection_group_join_requests
       set status = 'approved', decided_by = p_decider_id, decided_at = v_now
     where id = v_request.id;

    select m.* into v_member
      from public.connection_group_members m
     where m.group_id = v_request.group_id
       and m.user_id = v_request.user_id;
    return v_member;
  end if;

  perform pg_advisory_xact_lock(
    hashtext('connection_group_member_cap'), hashtext(v_request.group_id::text)
  );

  select count(*)
    into v_count
    from public.connection_group_members m
   where m.group_id = v_request.group_id
     and m.left_at is null;

  if v_count >= p_max_members then
    raise exception 'MEMBER_LIMIT_EXCEEDED';
  end if;

  perform pg_advisory_xact_lock(
    hashtext('connection_group_user_cap'), hashtext(v_request.user_id::text)
  );

  select count(*)
    into v_count
    from public.connection_group_members m
    join public.connection_groups g
      on g.id = m.group_id
     and g.deleted_at is null
   where m.user_id = v_request.user_id
     and m.left_at is null;

  if v_count >= p_max_groups then
    raise exception 'GROUP_LIMIT_EXCEEDED';
  end if;

  update public.connection_group_join_requests
     set status = 'approved', decided_by = p_decider_id, decided_at = v_now
   where id = v_request.id;

  -- Rejoin reactivates the row; joined_at is refreshed so close-time
  -- membership snapshots (award fanout) stay accurate.
  insert into public.connection_group_members (group_id, user_id, joined_at)
  values (v_request.group_id, v_request.user_id, v_now)
  on conflict (group_id, user_id)
  do update set left_at = null, joined_at = v_now
  returning * into v_member;

  return v_member;
end;
$$;

revoke all on function public.approve_group_join(uuid, uuid, integer, integer)
  from public, anon, authenticated;
grant execute on function public.approve_group_join(uuid, uuid, integer, integer)
  to service_role;

-- ---------------------------------------------------------------------------
-- 4. reject_group_join
-- ---------------------------------------------------------------------------

create or replace function public.reject_group_join(
  p_decider_id uuid,
  p_request_id uuid
) returns void
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_now timestamptz := now();
  v_request public.connection_group_join_requests;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Only service role can manage join requests.'
      using errcode = '42501';
  end if;

  select r.* into v_request
    from public.connection_group_join_requests r
   where r.id = p_request_id
     for update;

  if not found or v_request.status <> 'pending' then
    raise exception 'REQUEST_NOT_FOUND';
  end if;

  if not public.is_active_group_member(v_request.group_id, p_decider_id) then
    raise exception 'NOT_GROUP_MEMBER';
  end if;

  update public.connection_group_join_requests
     set status = 'rejected', decided_by = p_decider_id, decided_at = v_now
   where id = v_request.id;
end;
$$;

revoke all on function public.reject_group_join(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.reject_group_join(uuid, uuid)
  to service_role;

-- ---------------------------------------------------------------------------
-- 5. leave_group
-- ---------------------------------------------------------------------------

create or replace function public.leave_group(
  p_user_id uuid,
  p_group_id uuid
) returns table (group_deleted boolean)
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_now timestamptz := now();
  v_remaining integer;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Only service role can manage memberships.'
      using errcode = '42501';
  end if;

  update public.connection_group_members m
     set left_at = v_now
   where m.group_id = p_group_id
     and m.user_id = p_user_id
     and m.left_at is null;

  if not found then
    raise exception 'NOT_GROUP_MEMBER';
  end if;

  select count(*)
    into v_remaining
    from public.connection_group_members m
   where m.group_id = p_group_id
     and m.left_at is null;

  if v_remaining = 0 then
    update public.connection_groups g
       set deleted_at = v_now, updated_at = v_now
     where g.id = p_group_id
       and g.deleted_at is null;
    return query select true;
  else
    return query select false;
  end if;
end;
$$;

revoke all on function public.leave_group(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.leave_group(uuid, uuid)
  to service_role;

-- ---------------------------------------------------------------------------
-- 6. get_or_create_group_board (AC-7)
--    p_cells: jsonb array of 9 objects matching group_board_cells snapshot
--    columns (boardCellSnapshotPayload shape, snake_case).
-- ---------------------------------------------------------------------------

create or replace function public.get_or_create_group_board(
  p_user_id uuid,
  p_group_id uuid,
  p_daily_date date,
  p_seed_recipe text,
  p_cell_ids text[],
  p_free_position integer,
  p_cells jsonb
) returns public.group_boards
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_now timestamptz := now();
  v_board public.group_boards;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Only service role can manage group boards.'
      using errcode = '42501';
  end if;

  if not exists (
    select 1 from public.connection_groups g
     where g.id = p_group_id and g.deleted_at is null
  ) then
    raise exception 'GROUP_DELETED';
  end if;

  if not public.is_active_group_member(p_group_id, p_user_id) then
    raise exception 'NOT_GROUP_MEMBER';
  end if;

  select gb.* into v_board
    from public.group_boards gb
   where gb.group_id = p_group_id
     and gb.daily_date = p_daily_date
     and gb.deleted_at is null;

  if found then
    return v_board;
  end if;

  if coalesce(array_length(p_cell_ids, 1), 0) <> 9
     or jsonb_typeof(p_cells) is distinct from 'array'
     or jsonb_array_length(p_cells) <> 9 then
    raise exception 'INVALID_BOARD_SEED';
  end if;

  begin
    insert into public.group_boards (
      group_id, daily_date, mode, seed_recipe, cell_ids, free_position,
      created_by, created_at, updated_at
    )
    values (
      p_group_id, p_daily_date, '3x3', p_seed_recipe, p_cell_ids,
      p_free_position, p_user_id, v_now, v_now
    )
    returning * into v_board;
  exception when unique_violation then
    -- Concurrent creator won (AC-7); converge on its committed board.
    select gb.* into v_board
      from public.group_boards gb
     where gb.group_id = p_group_id
       and gb.daily_date = p_daily_date
       and gb.deleted_at is null;

    if not found then
      raise exception 'GROUP_BOARD_NOT_FOUND';
    end if;
    return v_board;
  end;

  insert into public.group_board_cells (
    group_board_id, "position", cell_id, mission_label, mission_capture_label,
    mission_category, mission_caption, mission_hint, mission_icon,
    mission_snapshot, mission_catalog_version
  )
  select v_board.id, c."position", c.cell_id, c.mission_label,
         c.mission_capture_label, c.mission_category, c.mission_caption,
         c.mission_hint, c.mission_icon, c.mission_snapshot,
         c.mission_catalog_version
    from jsonb_to_recordset(p_cells) as c(
      "position" integer,
      cell_id text,
      mission_label text,
      mission_capture_label text,
      mission_category text,
      mission_caption text,
      mission_hint text,
      mission_icon text,
      mission_snapshot jsonb,
      mission_catalog_version text
    )
  on conflict (group_board_id, "position") do nothing;

  return v_board;
end;
$$;

revoke all on function public.get_or_create_group_board(uuid, uuid, date, text, text[], integer, jsonb)
  from public, anon, authenticated;
grant execute on function public.get_or_create_group_board(uuid, uuid, date, text, text[], integer, jsonb)
  to service_role;

-- ---------------------------------------------------------------------------
-- 7. reroll_group_board (AC-8)
--    Guarded single UPDATE (reroll_board 0020 pattern) + first_media_at
--    monotonic lock, then cells replaced in the same transaction. The UPDATE
--    takes the board row lock, so concurrent confirms (which also lock the
--    board row first) serialize against the reroll.
-- ---------------------------------------------------------------------------

create or replace function public.reroll_group_board(
  p_user_id uuid,
  p_group_board_id uuid,
  p_limit integer,
  p_seed_recipe text,
  p_cell_ids text[],
  p_free_position integer,
  p_cells jsonb
) returns public.group_boards
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_now timestamptz := now();
  v_board public.group_boards;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Only service role can manage group boards.'
      using errcode = '42501';
  end if;

  select gb.* into v_board
    from public.group_boards gb
   where gb.id = p_group_board_id
     and gb.deleted_at is null;

  if not found then
    raise exception 'GROUP_BOARD_NOT_FOUND';
  end if;

  if not public.is_active_group_member(v_board.group_id, p_user_id) then
    raise exception 'NOT_GROUP_MEMBER';
  end if;

  if coalesce(array_length(p_cell_ids, 1), 0) <> 9
     or jsonb_typeof(p_cells) is distinct from 'array'
     or jsonb_array_length(p_cells) <> 9 then
    raise exception 'INVALID_BOARD_SEED';
  end if;

  update public.group_boards gb
     set reroll_count = gb.reroll_count + 1,
         seed_recipe = p_seed_recipe,
         cell_ids = p_cell_ids,
         free_position = p_free_position,
         updated_at = v_now
   where gb.id = p_group_board_id
     and gb.ended_at is null
     and gb.deleted_at is null
     and gb.first_media_at is null
     and gb.reroll_count < p_limit
  returning gb.* into v_board;

  if not found then
    raise exception 'REROLL_LOCKED';
  end if;

  -- first_media_at is null (guard above), so no cell media exists; the
  -- composite-FK cascade on group_board_cell_media is a no-op here.
  delete from public.group_board_cells
   where group_board_id = p_group_board_id;

  insert into public.group_board_cells (
    group_board_id, "position", cell_id, mission_label, mission_capture_label,
    mission_category, mission_caption, mission_hint, mission_icon,
    mission_snapshot, mission_catalog_version
  )
  select v_board.id, c."position", c.cell_id, c.mission_label,
         c.mission_capture_label, c.mission_category, c.mission_caption,
         c.mission_hint, c.mission_icon, c.mission_snapshot,
         c.mission_catalog_version
    from jsonb_to_recordset(p_cells) as c(
      "position" integer,
      cell_id text,
      mission_label text,
      mission_capture_label text,
      mission_category text,
      mission_caption text,
      mission_hint text,
      mission_icon text,
      mission_snapshot jsonb,
      mission_catalog_version text
    );

  return v_board;
end;
$$;

revoke all on function public.reroll_group_board(uuid, uuid, integer, text, text[], integer, jsonb)
  from public, anon, authenticated;
grant execute on function public.reroll_group_board(uuid, uuid, integer, text, text[], integer, jsonb)
  to service_role;

-- ---------------------------------------------------------------------------
-- 8. confirm_group_photo_upload (AC-9, AC-10)
--    Locks the board row first so rerolls and confirms serialize, then
--    re-verifies the target cell (CELL_MISMATCH guards the presign->confirm
--    reroll race). completed_at/completed_by/first_media_at are coalesce-set:
--    monotonic, first writer wins, later uploads never move them.
-- ---------------------------------------------------------------------------

create or replace function public.confirm_group_photo_upload(
  p_photo_id uuid,
  p_user_id uuid,
  p_object_etag text,
  p_confirmed_at timestamp with time zone
) returns void
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_photo record;
  v_board public.group_boards;
  v_cell_id text;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Only service role can confirm uploads.'
      using errcode = '42501';
  end if;

  select p.group_board_id, p."position", p.cell_id
    into v_photo
    from public.photos p
   where p.id = p_photo_id
     and p.user_id = p_user_id
     and p.deleted_at is null;

  if not found
     or v_photo.group_board_id is null
     or v_photo."position" is null
     or v_photo.cell_id is null then
    raise exception 'Photo is missing group board metadata.';
  end if;

  select gb.* into v_board
    from public.group_boards gb
   where gb.id = v_photo.group_board_id
     and gb.deleted_at is null
     for update;

  if not found then
    raise exception 'GROUP_BOARD_NOT_FOUND';
  end if;

  if not public.is_active_group_member(v_board.group_id, p_user_id) then
    raise exception 'NOT_GROUP_MEMBER';
  end if;

  -- The free center cell is auto-complete and never a media target; the API
  -- rejects it at presign, this is defense in depth for stale presigns.
  if v_board.free_position is not null
     and v_photo."position" = v_board.free_position then
    raise exception 'FREE_CELL_MEDIA';
  end if;

  select c.cell_id into v_cell_id
    from public.group_board_cells c
   where c.group_board_id = v_board.id
     and c."position" = v_photo."position";

  if not found or v_cell_id <> v_photo.cell_id then
    raise exception 'CELL_MISMATCH';
  end if;

  update public.photos
     set uploaded_at = p_confirmed_at,
         object_etag = p_object_etag
   where id = p_photo_id;

  insert into public.group_board_cell_media (
    group_board_id, "position", user_id, photo_id, clip_id, created_at
  )
  values (v_board.id, v_photo."position", p_user_id, p_photo_id, null, p_confirmed_at)
  on conflict (group_board_id, "position", user_id) where deleted_at is null
  do update set photo_id = excluded.photo_id,
                clip_id = null;

  update public.group_board_cells c
     set completed_at = coalesce(c.completed_at, p_confirmed_at),
         completed_by = coalesce(c.completed_by, p_user_id),
         completion_type = coalesce(c.completion_type, 'photo')
   where c.group_board_id = v_board.id
     and c."position" = v_photo."position";

  update public.group_boards gb
     set first_media_at = coalesce(gb.first_media_at, p_confirmed_at),
         updated_at = p_confirmed_at
   where gb.id = v_board.id;
end;
$$;

revoke all on function public.confirm_group_photo_upload(uuid, uuid, text, timestamp with time zone)
  from public, anon, authenticated;
grant execute on function public.confirm_group_photo_upload(uuid, uuid, text, timestamp with time zone)
  to service_role;

-- ---------------------------------------------------------------------------
-- 9. confirm_group_clip_upload (photo variant + poster etag)
-- ---------------------------------------------------------------------------

create or replace function public.confirm_group_clip_upload(
  p_clip_id uuid,
  p_user_id uuid,
  p_object_etag text,
  p_poster_object_etag text,
  p_confirmed_at timestamp with time zone
) returns void
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_clip record;
  v_board public.group_boards;
  v_cell_id text;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Only service role can confirm uploads.'
      using errcode = '42501';
  end if;

  select cl.group_board_id, cl."position", cl.cell_id
    into v_clip
    from public.clips cl
   where cl.id = p_clip_id
     and cl.user_id = p_user_id
     and cl.deleted_at is null;

  if not found
     or v_clip.group_board_id is null
     or v_clip."position" is null
     or v_clip.cell_id is null then
    raise exception 'Clip is missing group board metadata.';
  end if;

  select gb.* into v_board
    from public.group_boards gb
   where gb.id = v_clip.group_board_id
     and gb.deleted_at is null
     for update;

  if not found then
    raise exception 'GROUP_BOARD_NOT_FOUND';
  end if;

  if not public.is_active_group_member(v_board.group_id, p_user_id) then
    raise exception 'NOT_GROUP_MEMBER';
  end if;

  if v_board.free_position is not null
     and v_clip."position" = v_board.free_position then
    raise exception 'FREE_CELL_MEDIA';
  end if;

  select c.cell_id into v_cell_id
    from public.group_board_cells c
   where c.group_board_id = v_board.id
     and c."position" = v_clip."position";

  if not found or v_cell_id <> v_clip.cell_id then
    raise exception 'CELL_MISMATCH';
  end if;

  update public.clips
     set uploaded_at = p_confirmed_at,
         poster_uploaded_at = p_confirmed_at,
         object_etag = p_object_etag,
         poster_object_etag = p_poster_object_etag
   where id = p_clip_id;

  insert into public.group_board_cell_media (
    group_board_id, "position", user_id, photo_id, clip_id, created_at
  )
  values (v_board.id, v_clip."position", p_user_id, null, p_clip_id, p_confirmed_at)
  on conflict (group_board_id, "position", user_id) where deleted_at is null
  do update set clip_id = excluded.clip_id,
                photo_id = null;

  update public.group_board_cells c
     set completed_at = coalesce(c.completed_at, p_confirmed_at),
         completed_by = coalesce(c.completed_by, p_user_id),
         completion_type = coalesce(c.completion_type, 'clip')
   where c.group_board_id = v_board.id
     and c."position" = v_clip."position";

  update public.group_boards gb
     set first_media_at = coalesce(gb.first_media_at, p_confirmed_at),
         updated_at = p_confirmed_at
   where gb.id = v_board.id;
end;
$$;

revoke all on function public.confirm_group_clip_upload(uuid, uuid, text, text, timestamp with time zone)
  from public, anon, authenticated;
grant execute on function public.confirm_group_clip_upload(uuid, uuid, text, text, timestamp with time zone)
  to service_role;

-- ---------------------------------------------------------------------------
-- 10. close_group_board (AC-11, AC-12)
--     Single-winner ended_at flip only. Award fanout is NOT triggered here —
--     see file header. Returns the current row either way so the caller can
--     decide whether the self-heal award path must fire.
-- ---------------------------------------------------------------------------

create or replace function public.close_group_board(
  p_group_board_id uuid,
  p_reason text
) returns public.group_boards
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_now timestamptz := now();
  v_board public.group_boards;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Only service role can manage group boards.'
      using errcode = '42501';
  end if;

  update public.group_boards gb
     set ended_at = v_now,
         end_reason = p_reason,
         updated_at = v_now
   where gb.id = p_group_board_id
     and gb.ended_at is null
     and gb.deleted_at is null
  returning gb.* into v_board;

  if not found then
    select gb.* into v_board
      from public.group_boards gb
     where gb.id = p_group_board_id
       and gb.deleted_at is null;

    if not found then
      raise exception 'GROUP_BOARD_NOT_FOUND';
    end if;
  end if;

  return v_board;
end;
$$;

revoke all on function public.close_group_board(uuid, text)
  from public, anon, authenticated;
grant execute on function public.close_group_board(uuid, text)
  to service_role;

-- ---------------------------------------------------------------------------
-- 11. award_group_board_badges (AC-11, AC-14)
--     Self-healing idempotent fanout for a completed board:
--       * group_board_completions — streak ledger, written for every
--         close-time active member regardless of badge count.
--       * group_board_badges + user_badges — 0017 pattern per member; only
--         rows actually inserted into group_board_badges roll into
--         user_badges (CTE gating prevents double earned_count increments on
--         concurrent retries). last_board_id is intentionally NOT updated on
--         conflict: group awards must not null out the personal-board pointer.
--     Close-time membership snapshot: joined before close and not left
--     before close (a member who leaves between close and award still gets
--     the payout — AC-11 "everyone" + AC-14 no-revoke).
-- ---------------------------------------------------------------------------

create or replace function public.award_group_board_badges(
  p_group_board_id uuid,
  p_badge_ids text[]
) returns table (user_id uuid, badge_id text, is_first_earn boolean)
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_now timestamptz := now();
  v_board public.group_boards;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Only service role can award badges.'
      using errcode = '42501';
  end if;

  select gb.* into v_board
    from public.group_boards gb
   where gb.id = p_group_board_id
     and gb.deleted_at is null;

  if not found then
    raise exception 'GROUP_BOARD_NOT_FOUND';
  end if;

  if v_board.ended_at is null or v_board.end_reason <> 'completed' then
    raise exception 'GROUP_BOARD_NOT_COMPLETED';
  end if;

  insert into public.group_board_completions (
    group_board_id, user_id, group_id, daily_date, completed_at
  )
  select v_board.id, m.user_id, v_board.group_id, v_board.daily_date,
         v_board.ended_at
    from public.connection_group_members m
   where m.group_id = v_board.group_id
     and m.joined_at <= v_board.ended_at
     and (m.left_at is null or m.left_at > v_board.ended_at)
  on conflict on constraint group_board_completions_pkey do nothing;

  return query
  with members as (
    select m.user_id
      from public.connection_group_members m
     where m.group_id = v_board.group_id
       and m.joined_at <= v_board.ended_at
       and (m.left_at is null or m.left_at > v_board.ended_at)
  ),
  inserted as (
    insert into public.group_board_badges (group_board_id, mission_id, user_id, earned_at)
    select v_board.id, mc.mission_id, mem.user_id, v_now
      from unnest(p_badge_ids) as mission_input(mission_id)
      join public.mission_content mc
        on mc.mission_id = mission_input.mission_id
       and mc.awards_badge = true
       and mc.active = true
      cross join members mem
    on conflict on constraint group_board_badges_pkey do nothing
    returning group_board_badges.mission_id, group_board_badges.user_id
  ),
  rolled as (
    insert into public.user_badges (
      user_id, mission_id, earned_catalog_version, first_board_id,
      last_board_id, first_earned_at, last_earned_at, earned_count
    )
    select i.user_id, i.mission_id, mc.catalog_version, null, null,
           v_now, v_now, 1
      from inserted i
      join public.mission_content mc on mc.mission_id = i.mission_id
    on conflict on constraint user_badges_pkey do update
      set earned_count   = user_badges.earned_count + 1,
          last_earned_at = excluded.last_earned_at
    returning user_badges.user_id, user_badges.mission_id,
              (user_badges.earned_count = 1) as is_first_earn
  )
  select r.user_id, r.mission_id as badge_id, r.is_first_earn
    from rolled r;
end;
$$;

revoke all on function public.award_group_board_badges(uuid, text[])
  from public, anon, authenticated;
grant execute on function public.award_group_board_badges(uuid, text[])
  to service_role;

notify pgrst, 'reload schema';
