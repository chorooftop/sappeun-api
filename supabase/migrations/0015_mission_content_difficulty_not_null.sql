-- Make mission_content.difficulty explicit.
--
-- mission_badges kept a concrete difficulty while mission_content historically
-- represented easy as null. Verify the two stores still agree before
-- normalizing null to easy and making the content value authoritative.

do $$
begin
  if exists (
    select 1
      from public.mission_content c
      join public.mission_badges b using (catalog_version, mission_id)
     where coalesce(c.difficulty, 'easy') <> b.difficulty
  ) then
    raise exception 'difficulty drift between mission_content and mission_badges';
  end if;
end $$;

update public.mission_content
   set difficulty = 'easy'
 where difficulty is null;

alter table public.mission_content
  alter column difficulty set default 'easy',
  alter column difficulty set not null;

notify pgrst, 'reload schema';
