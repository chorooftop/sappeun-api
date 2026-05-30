--
-- PostgreSQL database dump
--

\restrict wDHAEdMh0m1vySyfH29UzfWp4yVMY2kkjnavAu20aulhn3noIJEukfHmgh1xLCo

-- Dumped from database version 17.6
-- Dumped by pg_dump version 18.4

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: public; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA public;


--
-- Name: SCHEMA public; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON SCHEMA public IS 'standard public schema';


--
-- Name: board_mode; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.board_mode AS ENUM (
    '5x5',
    '3x3',
    'standard'
);


--
-- Name: require_current_consents_for_signup(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.require_current_consents_for_signup() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if new.signup_completed_at is not null
    and old.signup_completed_at is null
    and not (
      exists (
        select 1
        from public.user_consents
        where user_id = new.user_id
          and consent_type = 'terms'
          and version = 'terms-2026-05-16'
      )
      and exists (
        select 1
        from public.user_consents
        where user_id = new.user_id
          and consent_type = 'privacy'
          and version = 'privacy-2026-05-16'
      )
    )
  then
    raise exception
      'Current required consent rows are required before completing signup.';
  end if;

  return new;
end;
$$;


--
-- Name: set_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.set_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  new.updated_at = now();
  return new;
end;
$$;

--
-- Name: confirm_user_photo_upload(uuid, uuid, text, timestamp with time zone); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.confirm_user_photo_upload(p_photo_id uuid, p_user_id uuid, p_object_etag text, p_confirmed_at timestamp with time zone) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
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


--
-- Name: confirm_user_clip_upload(uuid, uuid, text, text, timestamp with time zone); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.confirm_user_clip_upload(p_clip_id uuid, p_user_id uuid, p_object_etag text, p_poster_object_etag text, p_confirmed_at timestamp with time zone) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
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


REVOKE ALL ON FUNCTION public.confirm_user_photo_upload(uuid, uuid, text, timestamp with time zone) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.confirm_user_photo_upload(uuid, uuid, text, timestamp with time zone) TO service_role;

REVOKE ALL ON FUNCTION public.confirm_user_clip_upload(uuid, uuid, text, text, timestamp with time zone) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.confirm_user_clip_upload(uuid, uuid, text, text, timestamp with time zone) TO service_role;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: board_cells; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.board_cells (
    board_id uuid NOT NULL,
    "position" integer NOT NULL,
    cell_id text NOT NULL,
    photo_id uuid,
    marked_at timestamp with time zone,
    mission_label text,
    mission_capture_label text,
    mission_category text,
    mission_caption text,
    mission_hint text,
    mission_icon text,
    mission_snapshot jsonb,
    mission_catalog_version text,
    completed_at timestamp with time zone,
    completion_type text,
    clip_id uuid,
    CONSTRAINT board_cells_completion_type_check CHECK (((completion_type IS NULL) OR (completion_type = ANY (ARRAY['photo'::text, 'no_photo'::text, 'clip'::text, 'no_media'::text, 'free'::text])))),
    CONSTRAINT board_cells_single_media_check CHECK ((NOT ((photo_id IS NOT NULL) AND (clip_id IS NOT NULL)))),
    CONSTRAINT board_cells_position_check CHECK ((("position" >= 0) AND ("position" < 25)))
);


--
-- Name: boards; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.boards (
    id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL,
    user_id uuid NOT NULL,
    mode public.board_mode NOT NULL,
    seed_recipe text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    ended_at timestamp with time zone,
    client_session_id text,
    nickname text,
    free_position integer,
    cell_ids text[],
    board_kind text DEFAULT 'mission'::text NOT NULL,
    title text,
    description text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    CONSTRAINT boards_board_kind_check CHECK ((board_kind = ANY (ARRAY['mission'::text, 'custom'::text]))),
    CONSTRAINT boards_free_position_check CHECK (((free_position IS NULL) OR ((free_position >= 0) AND (free_position < 25))))
);


--
-- Name: clips; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.clips (
    id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL,
    user_id uuid NOT NULL,
    board_id uuid NOT NULL,
    "position" integer NOT NULL,
    cell_id text NOT NULL,
    storage_path text NOT NULL,
    poster_storage_path text,
    storage_provider text DEFAULT 'r2'::text NOT NULL,
    bucket_name text NOT NULL,
    object_etag text,
    poster_object_etag text,
    content_type text NOT NULL,
    recorder_mime_type text NOT NULL,
    codec text,
    size_bytes bigint NOT NULL,
    duration_ms integer NOT NULL,
    width integer,
    height integer,
    orientation text,
    poster_content_type text,
    poster_size_bytes bigint,
    poster_width integer,
    poster_height integer,
    poster_uploaded_at timestamp with time zone,
    uploaded_at timestamp with time zone,
    recorded_at timestamp with time zone,
    deleted_at timestamp with time zone,
    source text DEFAULT 'authenticated'::text NOT NULL,
    description text,
    CONSTRAINT clips_duration_ms_check CHECK (((duration_ms > 0) AND (duration_ms <= 3500))),
    CONSTRAINT clips_orientation_check CHECK (((orientation IS NULL) OR (orientation = ANY (ARRAY['portrait'::text, 'landscape'::text, 'square'::text])))),
    CONSTRAINT clips_position_check CHECK ((("position" >= 0) AND ("position" < 25))),
    CONSTRAINT clips_source_check CHECK ((source = ANY (ARRAY['authenticated'::text, 'guest_promoted'::text]))),
    CONSTRAINT clips_storage_provider_check CHECK ((storage_provider = 'r2'::text))
);


--
-- Name: guest_clip_uploads; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.guest_clip_uploads (
    id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL,
    guest_session_id uuid NOT NULL,
    client_board_session_id text NOT NULL,
    mode public.board_mode NOT NULL,
    board_kind text DEFAULT 'mission'::text NOT NULL,
    nickname text NOT NULL,
    title text NOT NULL,
    description text,
    mission_snapshots jsonb NOT NULL,
    free_position integer NOT NULL,
    cell_ids text[] NOT NULL,
    "position" integer NOT NULL,
    cell_id text NOT NULL,
    storage_path text NOT NULL,
    poster_storage_path text,
    storage_provider text DEFAULT 'r2'::text NOT NULL,
    bucket_name text NOT NULL,
    object_etag text,
    poster_object_etag text,
    content_type text NOT NULL,
    recorder_mime_type text NOT NULL,
    codec text,
    size_bytes bigint NOT NULL,
    duration_ms integer NOT NULL,
    width integer,
    height integer,
    orientation text,
    poster_content_type text,
    poster_size_bytes bigint,
    poster_width integer,
    poster_height integer,
    poster_uploaded_at timestamp with time zone,
    upload_status text DEFAULT 'presigned'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    uploaded_at timestamp with time zone,
    expires_at timestamp with time zone DEFAULT (now() + '3 days'::interval) NOT NULL,
    promoted_user_id uuid,
    promoted_clip_id uuid,
    promoted_at timestamp with time zone,
    deleted_at timestamp with time zone,
    clip_description text,
    CONSTRAINT guest_clip_uploads_board_kind_check CHECK ((board_kind = ANY (ARRAY['mission'::text, 'custom'::text]))),
    CONSTRAINT guest_clip_uploads_duration_ms_check CHECK (((duration_ms > 0) AND (duration_ms <= 3500))),
    CONSTRAINT guest_clip_uploads_free_position_check CHECK (((free_position >= 0) AND (free_position < 25))),
    CONSTRAINT guest_clip_uploads_orientation_check CHECK (((orientation IS NULL) OR (orientation = ANY (ARRAY['portrait'::text, 'landscape'::text, 'square'::text])))),
    CONSTRAINT guest_clip_uploads_position_check CHECK ((("position" >= 0) AND ("position" < 25))),
    CONSTRAINT guest_clip_uploads_storage_provider_check CHECK ((storage_provider = 'r2'::text)),
    CONSTRAINT guest_clip_uploads_upload_status_check CHECK ((upload_status = ANY (ARRAY['presigned'::text, 'uploaded'::text, 'failed'::text, 'promoted'::text, 'expired'::text, 'deleted'::text])))
);


--
-- Name: guest_photo_uploads; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.guest_photo_uploads (
    id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL,
    guest_session_id uuid NOT NULL,
    client_board_session_id text NOT NULL,
    mode public.board_mode NOT NULL,
    nickname text NOT NULL,
    free_position integer NOT NULL,
    cell_ids text[] NOT NULL,
    "position" integer NOT NULL,
    cell_id text NOT NULL,
    storage_path text NOT NULL,
    storage_provider text DEFAULT 'r2'::text NOT NULL,
    bucket_name text NOT NULL,
    object_etag text,
    content_type text NOT NULL,
    size_bytes bigint NOT NULL,
    upload_status text DEFAULT 'presigned'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    uploaded_at timestamp with time zone,
    expires_at timestamp with time zone DEFAULT (now() + '3 days'::interval) NOT NULL,
    promoted_user_id uuid,
    promoted_photo_id uuid,
    promoted_at timestamp with time zone,
    deleted_at timestamp with time zone,
    CONSTRAINT guest_photo_uploads_free_position_check CHECK (((free_position >= 0) AND (free_position < 25))),
    CONSTRAINT guest_photo_uploads_position_check CHECK ((("position" >= 0) AND ("position" < 25))),
    CONSTRAINT guest_photo_uploads_storage_provider_check CHECK ((storage_provider = 'r2'::text)),
    CONSTRAINT guest_photo_uploads_upload_status_check CHECK ((upload_status = ANY (ARRAY['presigned'::text, 'uploaded'::text, 'promoted'::text, 'expired'::text, 'deleted'::text])))
);


--
-- Name: photos; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.photos (
    id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL,
    user_id uuid NOT NULL,
    storage_path text NOT NULL,
    storage_provider text DEFAULT 'r2'::text NOT NULL,
    bucket_name text NOT NULL,
    object_etag text,
    content_type text NOT NULL,
    size_bytes bigint NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    uploaded_at timestamp with time zone,
    deleted_at timestamp with time zone,
    source text DEFAULT 'authenticated'::text NOT NULL,
    board_id uuid,
    "position" integer,
    cell_id text,
    captured_at timestamp with time zone,
    mission_snapshot jsonb,
    CONSTRAINT photos_position_check CHECK ((("position" IS NULL) OR (("position" >= 0) AND ("position" < 25)))),
    CONSTRAINT photos_source_check CHECK ((source = ANY (ARRAY['authenticated'::text, 'guest_promoted'::text]))),
    CONSTRAINT photos_storage_provider_check CHECK ((storage_provider = 'r2'::text))
);


--
-- Name: profiles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.profiles (
    user_id uuid NOT NULL,
    display_name text,
    avatar_url text,
    primary_provider text,
    first_login_at timestamp with time zone DEFAULT now() NOT NULL,
    last_seen_at timestamp with time zone,
    first_play_tutorial_completed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    signup_completed_at timestamp with time zone,
    onboarding_completed_at timestamp with time zone,
    signup_source text,
    nickname text,
    nickname_updated_at timestamp with time zone,
    CONSTRAINT profiles_display_name_check CHECK (((display_name IS NULL) OR (char_length(display_name) <= 40))),
    CONSTRAINT profiles_nickname_check CHECK (((nickname IS NULL) OR (char_length(nickname) <= 10))),
    CONSTRAINT profiles_primary_provider_check CHECK (((primary_provider IS NULL) OR (char_length(primary_provider) <= 64))),
    CONSTRAINT profiles_signup_source_check CHECK (((signup_source IS NULL) OR (signup_source = ANY (ARRAY['signup'::text, 'login_recovery'::text]))))
);


--
-- Name: shares; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.shares (
    board_id uuid NOT NULL,
    share_code text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: shared_board_view; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.shared_board_view AS
 SELECT s.share_code,
    s.created_at AS shared_at,
    b.id AS board_id,
    b.mode,
    b.created_at AS board_created_at,
    b.ended_at AS board_ended_at,
    bc."position",
    bc.cell_id,
    bc.marked_at,
    bc.completed_at,
    bc.completion_type,
    bc.mission_label,
    bc.mission_capture_label,
    bc.mission_category,
    bc.mission_snapshot,
    bc.clip_id
   FROM ((public.shares s
     JOIN public.boards b ON ((b.id = s.board_id)))
     LEFT JOIN public.board_cells bc ON ((bc.board_id = b.id)))
  WHERE (b.deleted_at IS NULL);


--
-- Name: user_consents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_consents (
    id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL,
    user_id uuid NOT NULL,
    consent_type text NOT NULL,
    version text NOT NULL,
    accepted_at timestamp with time zone DEFAULT now() NOT NULL,
    source text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT user_consents_consent_type_check CHECK ((consent_type = ANY (ARRAY['terms'::text, 'privacy'::text]))),
    CONSTRAINT user_consents_source_check CHECK ((source = ANY (ARRAY['signup'::text, 'login_recovery'::text]))),
    CONSTRAINT user_consents_version_check CHECK ((char_length(version) <= 40))
);


--
-- Name: board_cells board_cells_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.board_cells
    ADD CONSTRAINT board_cells_pkey PRIMARY KEY (board_id, "position");


--
-- Name: boards boards_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.boards
    ADD CONSTRAINT boards_pkey PRIMARY KEY (id);


--
-- Name: clips clips_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.clips
    ADD CONSTRAINT clips_pkey PRIMARY KEY (id);


--
-- Name: clips clips_storage_path_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.clips
    ADD CONSTRAINT clips_storage_path_key UNIQUE (storage_path);


--
-- Name: guest_clip_uploads guest_clip_uploads_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.guest_clip_uploads
    ADD CONSTRAINT guest_clip_uploads_pkey PRIMARY KEY (id);


--
-- Name: guest_clip_uploads guest_clip_uploads_storage_path_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.guest_clip_uploads
    ADD CONSTRAINT guest_clip_uploads_storage_path_key UNIQUE (storage_path);


--
-- Name: guest_photo_uploads guest_photo_uploads_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.guest_photo_uploads
    ADD CONSTRAINT guest_photo_uploads_pkey PRIMARY KEY (id);


--
-- Name: guest_photo_uploads guest_photo_uploads_storage_path_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.guest_photo_uploads
    ADD CONSTRAINT guest_photo_uploads_storage_path_key UNIQUE (storage_path);


--
-- Name: photos photos_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.photos
    ADD CONSTRAINT photos_pkey PRIMARY KEY (id);


--
-- Name: photos photos_r2_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.photos
    ADD CONSTRAINT photos_r2_key_key UNIQUE (storage_path);


--
-- Name: profiles profiles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.profiles
    ADD CONSTRAINT profiles_pkey PRIMARY KEY (user_id);


--
-- Name: shares shares_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shares
    ADD CONSTRAINT shares_pkey PRIMARY KEY (board_id);


--
-- Name: shares shares_share_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shares
    ADD CONSTRAINT shares_share_code_key UNIQUE (share_code);


--
-- Name: user_consents user_consents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_consents
    ADD CONSTRAINT user_consents_pkey PRIMARY KEY (id);


--
-- Name: user_consents user_consents_user_id_consent_type_version_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_consents
    ADD CONSTRAINT user_consents_user_id_consent_type_version_key UNIQUE (user_id, consent_type, version);


--
-- Name: board_cells_clip_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX board_cells_clip_id_idx ON public.board_cells USING btree (clip_id);


--
-- Name: board_cells_completion_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX board_cells_completion_idx ON public.board_cells USING btree (board_id, completed_at) WHERE (completed_at IS NOT NULL);


--
-- Name: board_cells_photo_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX board_cells_photo_id_idx ON public.board_cells USING btree (photo_id);


--
-- Name: boards_active_user_updated_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX boards_active_user_updated_idx ON public.boards USING btree (user_id, updated_at DESC) WHERE ((ended_at IS NULL) AND (deleted_at IS NULL) AND (client_session_id IS NOT NULL));


--
-- Name: boards_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX boards_created_at_idx ON public.boards USING btree (created_at DESC);


--
-- Name: boards_history_user_updated_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX boards_history_user_updated_idx ON public.boards USING btree (user_id, updated_at DESC) WHERE ((deleted_at IS NULL) AND (client_session_id IS NOT NULL));


--
-- Name: boards_user_client_session_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX boards_user_client_session_uidx ON public.boards USING btree (user_id, client_session_id) WHERE ((client_session_id IS NOT NULL) AND (deleted_at IS NULL));


--
-- Name: boards_user_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX boards_user_id_idx ON public.boards USING btree (user_id);


--
-- Name: boards_user_updated_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX boards_user_updated_at_idx ON public.boards USING btree (user_id, updated_at DESC);


--
-- Name: clips_board_position_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX clips_board_position_idx ON public.clips USING btree (board_id, "position");


--
-- Name: clips_user_board_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX clips_user_board_idx ON public.clips USING btree (user_id, board_id);


--
-- Name: guest_clip_uploads_expires_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX guest_clip_uploads_expires_idx ON public.guest_clip_uploads USING btree (expires_at) WHERE (upload_status = ANY (ARRAY['presigned'::text, 'uploaded'::text, 'failed'::text]));


--
-- Name: guest_clip_uploads_guest_session_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX guest_clip_uploads_guest_session_idx ON public.guest_clip_uploads USING btree (guest_session_id, created_at DESC);


--
-- Name: guest_photo_uploads_expires_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX guest_photo_uploads_expires_idx ON public.guest_photo_uploads USING btree (expires_at) WHERE (upload_status = ANY (ARRAY['presigned'::text, 'uploaded'::text]));


--
-- Name: guest_photo_uploads_guest_session_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX guest_photo_uploads_guest_session_idx ON public.guest_photo_uploads USING btree (guest_session_id, created_at DESC);


--
-- Name: photos_user_board_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX photos_user_board_idx ON public.photos USING btree (user_id, board_id);


--
-- Name: photos_user_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX photos_user_id_idx ON public.photos USING btree (user_id);


--
-- Name: profiles_last_seen_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX profiles_last_seen_at_idx ON public.profiles USING btree (last_seen_at DESC);


--
-- Name: shares_share_code_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX shares_share_code_idx ON public.shares USING btree (share_code);


--
-- Name: user_consents_user_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX user_consents_user_id_idx ON public.user_consents USING btree (user_id, accepted_at DESC);


--
-- Name: profiles profiles_require_signup_consents; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER profiles_require_signup_consents BEFORE UPDATE OF signup_completed_at ON public.profiles FOR EACH ROW EXECUTE FUNCTION public.require_current_consents_for_signup();


--
-- Name: profiles profiles_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER profiles_set_updated_at BEFORE UPDATE ON public.profiles FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: board_cells board_cells_board_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.board_cells
    ADD CONSTRAINT board_cells_board_id_fkey FOREIGN KEY (board_id) REFERENCES public.boards(id) ON DELETE CASCADE;


--
-- Name: board_cells board_cells_clip_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.board_cells
    ADD CONSTRAINT board_cells_clip_id_fkey FOREIGN KEY (clip_id) REFERENCES public.clips(id) ON DELETE SET NULL;


--
-- Name: board_cells board_cells_photo_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.board_cells
    ADD CONSTRAINT board_cells_photo_id_fkey FOREIGN KEY (photo_id) REFERENCES public.photos(id) ON DELETE SET NULL;


--
-- Name: boards boards_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.boards
    ADD CONSTRAINT boards_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: clips clips_board_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.clips
    ADD CONSTRAINT clips_board_id_fkey FOREIGN KEY (board_id) REFERENCES public.boards(id) ON DELETE CASCADE;


--
-- Name: clips clips_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.clips
    ADD CONSTRAINT clips_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: guest_clip_uploads guest_clip_uploads_promoted_clip_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.guest_clip_uploads
    ADD CONSTRAINT guest_clip_uploads_promoted_clip_id_fkey FOREIGN KEY (promoted_clip_id) REFERENCES public.clips(id) ON DELETE SET NULL;


--
-- Name: guest_clip_uploads guest_clip_uploads_promoted_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.guest_clip_uploads
    ADD CONSTRAINT guest_clip_uploads_promoted_user_id_fkey FOREIGN KEY (promoted_user_id) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: guest_photo_uploads guest_photo_uploads_promoted_photo_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.guest_photo_uploads
    ADD CONSTRAINT guest_photo_uploads_promoted_photo_id_fkey FOREIGN KEY (promoted_photo_id) REFERENCES public.photos(id) ON DELETE SET NULL;


--
-- Name: guest_photo_uploads guest_photo_uploads_promoted_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.guest_photo_uploads
    ADD CONSTRAINT guest_photo_uploads_promoted_user_id_fkey FOREIGN KEY (promoted_user_id) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: photos photos_board_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.photos
    ADD CONSTRAINT photos_board_id_fkey FOREIGN KEY (board_id) REFERENCES public.boards(id) ON DELETE CASCADE;


--
-- Name: photos photos_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.photos
    ADD CONSTRAINT photos_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: profiles profiles_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.profiles
    ADD CONSTRAINT profiles_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: shares shares_board_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shares
    ADD CONSTRAINT shares_board_id_fkey FOREIGN KEY (board_id) REFERENCES public.boards(id) ON DELETE CASCADE;


--
-- Name: user_consents user_consents_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_consents
    ADD CONSTRAINT user_consents_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: board_cells; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.board_cells ENABLE ROW LEVEL SECURITY;

--
-- Name: board_cells board_cells_insert_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY board_cells_insert_own ON public.board_cells FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM public.boards b
  WHERE ((b.id = board_cells.board_id) AND (b.user_id = auth.uid())))));


--
-- Name: board_cells board_cells_select_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY board_cells_select_own ON public.board_cells FOR SELECT USING ((EXISTS ( SELECT 1
   FROM public.boards b
  WHERE ((b.id = board_cells.board_id) AND (b.user_id = auth.uid())))));


--
-- Name: board_cells board_cells_update_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY board_cells_update_own ON public.board_cells FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM public.boards b
  WHERE ((b.id = board_cells.board_id) AND (b.user_id = auth.uid())))));


--
-- Name: boards; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.boards ENABLE ROW LEVEL SECURITY;

--
-- Name: boards boards_delete_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY boards_delete_own ON public.boards FOR DELETE USING ((auth.uid() = user_id));


--
-- Name: boards boards_insert_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY boards_insert_own ON public.boards FOR INSERT WITH CHECK ((auth.uid() = user_id));


--
-- Name: boards boards_select_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY boards_select_own ON public.boards FOR SELECT USING ((auth.uid() = user_id));


--
-- Name: boards boards_update_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY boards_update_own ON public.boards FOR UPDATE USING ((auth.uid() = user_id));


--
-- Name: clips; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.clips ENABLE ROW LEVEL SECURITY;

--
-- Name: clips clips_delete_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY clips_delete_own ON public.clips FOR DELETE USING ((auth.uid() = user_id));


--
-- Name: clips clips_insert_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY clips_insert_own ON public.clips FOR INSERT WITH CHECK ((auth.uid() = user_id));


--
-- Name: clips clips_select_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY clips_select_own ON public.clips FOR SELECT USING ((auth.uid() = user_id));


--
-- Name: clips clips_update_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY clips_update_own ON public.clips FOR UPDATE USING ((auth.uid() = user_id));


--
-- Name: guest_clip_uploads; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.guest_clip_uploads ENABLE ROW LEVEL SECURITY;

--
-- Name: guest_photo_uploads; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.guest_photo_uploads ENABLE ROW LEVEL SECURITY;

--
-- Name: photos; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.photos ENABLE ROW LEVEL SECURITY;

--
-- Name: photos photos_delete_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY photos_delete_own ON public.photos FOR DELETE USING ((auth.uid() = user_id));


--
-- Name: photos photos_insert_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY photos_insert_own ON public.photos FOR INSERT WITH CHECK ((auth.uid() = user_id));


--
-- Name: photos photos_select_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY photos_select_own ON public.photos FOR SELECT USING ((auth.uid() = user_id));


--
-- Name: profiles; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

--
-- Name: profiles profiles_insert_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY profiles_insert_own ON public.profiles FOR INSERT WITH CHECK ((auth.uid() = user_id));


--
-- Name: profiles profiles_select_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY profiles_select_own ON public.profiles FOR SELECT USING ((auth.uid() = user_id));


--
-- Name: profiles profiles_update_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY profiles_update_own ON public.profiles FOR UPDATE USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));


--
-- Name: shares; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.shares ENABLE ROW LEVEL SECURITY;

--
-- Name: shares shares_delete_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY shares_delete_own ON public.shares FOR DELETE USING ((EXISTS ( SELECT 1
   FROM public.boards b
  WHERE ((b.id = shares.board_id) AND (b.user_id = auth.uid())))));


--
-- Name: shares shares_insert_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY shares_insert_own ON public.shares FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM public.boards b
  WHERE ((b.id = shares.board_id) AND (b.user_id = auth.uid())))));


--
-- Name: shares shares_public_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY shares_public_select ON public.shares FOR SELECT USING (true);


--
-- Name: user_consents; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.user_consents ENABLE ROW LEVEL SECURITY;

--
-- Name: user_consents user_consents_insert_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY user_consents_insert_own ON public.user_consents FOR INSERT WITH CHECK ((auth.uid() = user_id));


--
-- Name: user_consents user_consents_select_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY user_consents_select_own ON public.user_consents FOR SELECT USING ((auth.uid() = user_id));


--
-- PostgreSQL database dump complete
--

\unrestrict wDHAEdMh0m1vySyfH29UzfWp4yVMY2kkjnavAu20aulhn3noIJEukfHmgh1xLCo
