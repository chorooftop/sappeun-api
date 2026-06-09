-- Replace stored category counts with a derived view. The API already returns
-- runtime-visible counts computed from mission_content rows.

alter table public.mission_categories
  drop column if exists count;

create or replace view public.mission_category_counts as
  select catalog_version,
         category as key,
         count(*)::int as count
    from public.mission_content
   where active = true
     and awards_badge = true
   group by catalog_version, category;

revoke all on table public.mission_category_counts
  from public, anon, authenticated;

grant select on table public.mission_category_counts
  to service_role;

notify pgrst, 'reload schema';
