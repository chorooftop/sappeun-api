-- Link badge reward metadata to the mission content master catalog.
--
-- Deployment note:
-- This is intentionally additive. Keep the legacy mission_badges
-- title/category/difficulty columns until the API version that reads mission
-- identity from mission_content has been deployed everywhere. A follow-up
-- cleanup migration can drop those columns after that cutover.

do $$
begin
  if not exists (
    select 1
      from pg_constraint
     where conname = 'mission_badges_mission_content_fkey'
       and conrelid = 'public.mission_badges'::regclass
  ) then
    alter table public.mission_badges
      add constraint mission_badges_mission_content_fkey
      foreign key (catalog_version, mission_id)
      references public.mission_content (catalog_version, mission_id)
      on update cascade
      on delete restrict;
  end if;
end $$;

notify pgrst, 'reload schema';
