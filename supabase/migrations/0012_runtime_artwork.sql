-- Runtime mission/badge artwork contract.
--
-- v1 keeps artwork inline as additive jsonb so existing clients can continue
-- reading icon/swatch/text fields while runtime-artwork clients prefer this
-- richer contract.

alter table public.mission_content
  add column if not exists artwork jsonb;

alter table public.mission_badges
  add column if not exists artwork jsonb;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'mission_content_artwork_object_check'
      and conrelid = 'public.mission_content'::regclass
  ) then
    alter table public.mission_content
      add constraint mission_content_artwork_object_check
      check (artwork is null or jsonb_typeof(artwork) = 'object');
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'mission_badges_artwork_object_check'
      and conrelid = 'public.mission_badges'::regclass
  ) then
    alter table public.mission_badges
      add constraint mission_badges_artwork_object_check
      check (artwork is null or jsonb_typeof(artwork) = 'object');
  end if;
end $$;

-- mission_content owns the default visual core. mission_badges.artwork remains
-- null unless a badge needs a visual override; the API falls back to the joined
-- mission_content.artwork.
update public.mission_content
set artwork =
  case
    when icon is not null then
      jsonb_strip_nulls(jsonb_build_object(
        'schemaVersion', 1,
        'type', 'lucide',
        'key', icon,
        'alt', label,
        'paletteMode', 'mono'
      ))
    when swatch is not null then
      jsonb_strip_nulls(jsonb_build_object(
        'schemaVersion', 1,
        'type', 'swatch',
        'key', swatch,
        'label', swatch_label,
        'effect', case when swatch = 'rainbow' then 'rainbow' else 'solid' end,
        'alt', label
      ))
    when text_only is true then
      jsonb_strip_nulls(jsonb_build_object(
        'schemaVersion', 1,
        'type', 'text',
        'label', label,
        'fontSize', coalesce(font_size, 30),
        'alt', label,
        'paletteMode', 'mono'
      ))
    else artwork
  end
where artwork is null
  and (icon is not null or swatch is not null or text_only is true);

comment on column public.mission_content.artwork is
  'Runtime ArtworkSpec v1. Default mission visual core; legacy icon/swatch/text fields are retained.';

comment on column public.mission_badges.artwork is
  'Optional badge-specific ArtworkSpec v1 override. Null means use mission_content.artwork.';

notify pgrst, 'reload schema';
