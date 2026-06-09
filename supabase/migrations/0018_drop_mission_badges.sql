-- mission_content is now the single mission/badge catalog source.

drop table if exists public.mission_badges;

notify pgrst, 'reload schema';
