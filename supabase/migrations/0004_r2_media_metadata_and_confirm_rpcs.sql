alter table public.boards
  add column if not exists board_kind text not null default 'mission',
  add column if not exists title text,
  add column if not exists description text;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'boards_board_kind_check'
      and conrelid = 'public.boards'::regclass
  ) then
    alter table public.boards
      add constraint boards_board_kind_check
      check (board_kind = any (array['mission'::text, 'custom'::text]));
  end if;
end $$;

alter table public.photos
  add column if not exists storage_provider text not null default 'r2',
  add column if not exists bucket_name text,
  add column if not exists object_etag text;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'photos_storage_provider_check'
      and conrelid = 'public.photos'::regclass
  ) then
    alter table public.photos
      add constraint photos_storage_provider_check
      check (storage_provider = 'r2'::text);
  end if;
end $$;

alter table public.guest_photo_uploads
  add column if not exists storage_provider text not null default 'r2',
  add column if not exists bucket_name text,
  add column if not exists object_etag text;

alter table public.guest_photo_uploads
  drop constraint if exists guest_photo_uploads_upload_status_check;

alter table public.guest_photo_uploads
  add constraint guest_photo_uploads_upload_status_check
  check (
    upload_status = any (
      array[
        'presigned'::text,
        'uploaded'::text,
        'failed'::text,
        'promoted'::text,
        'expired'::text,
        'deleted'::text
      ]
    )
  );

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'guest_photo_uploads_storage_provider_check'
      and conrelid = 'public.guest_photo_uploads'::regclass
  ) then
    alter table public.guest_photo_uploads
      add constraint guest_photo_uploads_storage_provider_check
      check (storage_provider = 'r2'::text);
  end if;
end $$;

alter table public.clips
  add column if not exists storage_provider text not null default 'r2',
  add column if not exists bucket_name text,
  add column if not exists object_etag text,
  add column if not exists poster_object_etag text,
  add column if not exists description text;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'clips_storage_provider_check'
      and conrelid = 'public.clips'::regclass
  ) then
    alter table public.clips
      add constraint clips_storage_provider_check
      check (storage_provider = 'r2'::text);
  end if;
end $$;

alter table public.guest_clip_uploads
  add column if not exists board_kind text not null default 'mission',
  add column if not exists title text,
  add column if not exists description text,
  add column if not exists mission_snapshots jsonb,
  add column if not exists storage_provider text not null default 'r2',
  add column if not exists bucket_name text,
  add column if not exists object_etag text,
  add column if not exists poster_object_etag text,
  add column if not exists clip_description text;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'guest_clip_uploads_board_kind_check'
      and conrelid = 'public.guest_clip_uploads'::regclass
  ) then
    alter table public.guest_clip_uploads
      add constraint guest_clip_uploads_board_kind_check
      check (board_kind = any (array['mission'::text, 'custom'::text]));
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'guest_clip_uploads_storage_provider_check'
      and conrelid = 'public.guest_clip_uploads'::regclass
  ) then
    alter table public.guest_clip_uploads
      add constraint guest_clip_uploads_storage_provider_check
      check (storage_provider = 'r2'::text);
  end if;
end $$;

create or replace function public.confirm_user_photo_upload(
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
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Only service role can confirm uploads.'
      using errcode = '42501';
  end if;

  update public.photos
     set uploaded_at = p_confirmed_at,
         object_etag = p_object_etag
   where id = p_photo_id
     and user_id = p_user_id
     and deleted_at is null
   returning board_id, "position", cell_id
        into v_photo;

  if not found or v_photo.board_id is null or v_photo."position" is null or v_photo.cell_id is null then
    raise exception 'Photo is missing board metadata.';
  end if;

  insert into public.board_cells (
    board_id,
    "position",
    cell_id,
    photo_id,
    clip_id,
    marked_at,
    completed_at,
    completion_type
  )
  values (
    v_photo.board_id,
    v_photo."position",
    v_photo.cell_id,
    p_photo_id,
    null,
    p_confirmed_at,
    p_confirmed_at,
    'photo'
  )
  on conflict (board_id, "position") do update
     set cell_id = excluded.cell_id,
         photo_id = excluded.photo_id,
         clip_id = null,
         marked_at = excluded.marked_at,
         completed_at = excluded.completed_at,
         completion_type = excluded.completion_type;

  update public.boards
     set updated_at = p_confirmed_at
   where id = v_photo.board_id
     and user_id = p_user_id;
end;
$$;

revoke all on function public.confirm_user_photo_upload(
  uuid,
  uuid,
  text,
  timestamp with time zone
) from public;
grant execute on function public.confirm_user_photo_upload(
  uuid,
  uuid,
  text,
  timestamp with time zone
) to service_role;

create or replace function public.confirm_user_clip_upload(
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
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Only service role can confirm uploads.'
      using errcode = '42501';
  end if;

  update public.clips
     set uploaded_at = p_confirmed_at,
         poster_uploaded_at = p_confirmed_at,
         object_etag = p_object_etag,
         poster_object_etag = p_poster_object_etag
   where id = p_clip_id
     and user_id = p_user_id
     and deleted_at is null
   returning board_id, "position", cell_id
        into v_clip;

  if not found or v_clip.board_id is null or v_clip."position" is null or v_clip.cell_id is null then
    raise exception 'Clip is missing board metadata.';
  end if;

  insert into public.board_cells (
    board_id,
    "position",
    cell_id,
    photo_id,
    clip_id,
    marked_at,
    completed_at,
    completion_type
  )
  values (
    v_clip.board_id,
    v_clip."position",
    v_clip.cell_id,
    null,
    p_clip_id,
    p_confirmed_at,
    p_confirmed_at,
    'clip'
  )
  on conflict (board_id, "position") do update
     set cell_id = excluded.cell_id,
         photo_id = null,
         clip_id = excluded.clip_id,
         marked_at = excluded.marked_at,
         completed_at = excluded.completed_at,
         completion_type = excluded.completion_type;

  update public.boards
     set updated_at = p_confirmed_at
   where id = v_clip.board_id
     and user_id = p_user_id;
end;
$$;

revoke all on function public.confirm_user_clip_upload(
  uuid,
  uuid,
  text,
  text,
  timestamp with time zone
) from public;
grant execute on function public.confirm_user_clip_upload(
  uuid,
  uuid,
  text,
  text,
  timestamp with time zone
) to service_role;
