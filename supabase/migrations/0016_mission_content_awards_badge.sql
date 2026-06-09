-- Add the mission-owned badge eligibility flag.
--
-- This column may already exist when the rewritten 0014 expansion migration was
-- applied first on an existing 0013 database. Keep this migration idempotent so
-- both fresh and forward-upgraded chains converge.

alter table public.mission_content
  add column if not exists awards_badge boolean not null default true;

update public.mission_content
   set awards_badge = false
 where category = 'special'
    or mission_id = 'free';

notify pgrst, 'reload schema';
