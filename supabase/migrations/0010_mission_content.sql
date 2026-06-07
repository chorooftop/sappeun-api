-- 0010_mission_content.sql
-- GENERATED FILE. Do not edit by hand.
-- Source of truth: src/missions/sheet.source.json (byte-identical copy of
-- apps/mobile/assets/data/sheet.json, v1.3.0).
-- Regenerate with: pnpm gen:mission-seed
--
-- Mission CONTENT master tables (mission_content + mission_categories) for the
-- DB-as-single-source migration (plans/mission-content-db-migration.md Phase 1/2).
-- catalog_version = 'api-migration-v1' (shared natural key with mission_badges;
-- both seeded from the same source so identity columns stay in sync in v1).
--
-- Style matches 0006/0009: lowercase SQL, do-block constraint/policy guards,
-- RLS revoke/grant, on conflict do update, idempotent.
--
-- mission_content holds 48 cells (free/special included).
-- mission_categories holds 7 categories.
-- camelCase sheet.json keys -> snake_case columns (captureLabel -> capture_label,
-- swatchLabel -> swatch_label, textOnly -> text_only, fontSize -> font_size,
-- noPhoto -> no_photo, fixedPosition -> fixed_position). icon absent/null -> null.
-- swatch stores the color NAME only (no hex). difficulty absent -> null.

-- ---------------------------------------------------------------------------
-- 1. mission_content
-- ---------------------------------------------------------------------------

create table if not exists public.mission_content (
  mission_id text not null,
  catalog_version text not null,
  label text not null,
  category text not null,
  hint text,
  caption text,
  capture_label text,
  icon text,
  variant text not null,
  difficulty text,
  camera text,
  text_only boolean,
  font_size integer,
  swatch text,
  swatch_label text,
  no_photo boolean,
  fixed_position text,
  sort_order integer not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  primary key (catalog_version, mission_id)
);

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'mission_content_variant_check'
      and conrelid = 'public.mission_content'::regclass
  ) then
    alter table public.mission_content
      add constraint mission_content_variant_check
      check (variant = any (array['QeQCU'::text, 'k4Srv'::text, 'rAdyJ'::text]));
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'mission_content_difficulty_check'
      and conrelid = 'public.mission_content'::regclass
  ) then
    alter table public.mission_content
      add constraint mission_content_difficulty_check
      check (difficulty is null
        or difficulty = any (array['easy'::text, 'medium'::text, 'hard'::text]));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 2. mission_categories
-- ---------------------------------------------------------------------------

create table if not exists public.mission_categories (
  catalog_version text not null,
  key text not null,
  label text not null,
  tone text,
  count integer,
  created_at timestamptz not null default now(),
  primary key (catalog_version, key)
);

-- ---------------------------------------------------------------------------
-- 3. RLS enable + explicit grants + policies
-- ---------------------------------------------------------------------------

alter table public.mission_content enable row level security;
alter table public.mission_categories enable row level security;

-- Backend-owned tables: the API server uses the service-role client (bypasses
-- RLS). The project default ACL grants broad privileges to anon/authenticated,
-- so explicitly revoke them and grant least-privilege to service_role.
revoke all on table public.mission_content, public.mission_categories
  from public, anon, authenticated;

grant select, insert, update, delete
  on table public.mission_content, public.mission_categories
  to service_role;

-- Authenticated clients may read active content / all categories if direct
-- client SELECT is deliberately granted later. Backend reads use service_role.
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'mission_content'
      and policyname = 'mission_content_select_active'
  ) then
    create policy mission_content_select_active on public.mission_content
      for select
      to authenticated
      using (active = true);
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'mission_categories'
      and policyname = 'mission_categories_select_all'
  ) then
    create policy mission_categories_select_all on public.mission_categories
      for select
      to authenticated
      using (true);
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 4. mission_content seed (catalog_version = 'api-migration-v1')
--    48 cells, source order preserved, sort_order = index * 10.
-- ---------------------------------------------------------------------------

insert into public.mission_content (
  mission_id, catalog_version, label, category, hint, caption, capture_label, icon, variant, difficulty, camera, text_only, font_size, swatch, swatch_label, no_photo, fixed_position, sort_order, active
)
values
  ('n01' , 'api-migration-v1', '꽃'       , 'nature' , '길가·화단·가게 앞에서 꽃이 잘 보이게 찍어요'          , null   , null          , 'flower-2'       , 'QeQCU', null    , null   , null, null, null     , null  , null, null    , 0  , true),
  ('n02' , 'api-migration-v1', '나뭇잎'     , 'nature' , '나무나 화분에서 잎 모양이 잘 보이게 찍어요'           , null   , null          , 'leaf'           , 'QeQCU', null    , null   , null, null, null     , null  , null, null    , 10 , true),
  ('n03' , 'api-migration-v1', '민들레'     , 'nature' , '풀밭이나 길가에서 민들레를 찾아요'                 , null   , null          , 'sprout'         , 'QeQCU', null    , null   , null, null, null     , null  , null, null    , 20 , true),
  ('n04' , 'api-migration-v1', '화분'      , 'nature' , '가게 앞이나 건물 입구 근처의 화분을 찾아요'           , null   , null          , 'flower'         , 'QeQCU', null    , null   , null, null, null     , null  , null, null    , 30 , true),
  ('n05' , 'api-migration-v1', '나무'      , 'nature' , '줄기나 가지가 보이게 나무를 찍어요'                , null   , null          , 'trees'          , 'QeQCU', null    , null   , null, null, null     , null  , null, null    , 40 , true),
  ('n06' , 'api-migration-v1', '구름'      , 'nature' , '하늘에 떠 있는 구름이 보이게 찍어요'               , null   , null          , 'cloud'          , 'QeQCU', 'medium', null   , null, null, null     , null  , null, null    , 50 , true),
  ('n07' , 'api-migration-v1', '햇빛'      , 'nature' , '바닥·벽·잎에 햇빛이 밝게 닿은 곳을 찾아요'           , null   , '햇빛이 드는 곳'    , 'sun'            , 'QeQCU', null    , null   , null, null, null     , null  , null, null    , 60 , true),
  ('n08' , 'api-migration-v1', '무지개'     , 'nature' , '하늘·간판·소품에서 무지개색을 찾아요'               , null   , null          , 'rainbow'        , 'QeQCU', 'hard'  , null   , null, null, null     , null  , null, null    , 70 , true),
  ('m01' , 'api-migration-v1', '자판기'     , 'manmade', '길가나 건물 안의 자판기를 찾아요'                 , null   , null          , 'package'        , 'QeQCU', null    , null   , null, null, null     , null  , null, null    , 80 , true),
  ('m02' , 'api-migration-v1', '표지판'     , 'manmade', '길 안내·안전 안내 표지판을 찾아요'                , null   , null          , 'signpost'       , 'QeQCU', null    , null   , null, null, null     , null  , null, null    , 90 , true),
  ('m03' , 'api-migration-v1', '공중전화'    , 'manmade', '공중전화나 전화부스 표시를 찾아요'                 , null   , '공중전화 또는 전화부스', 'phone'          , 'QeQCU', 'medium', null   , null, null, null     , null  , null, null    , 100, true),
  ('m04' , 'api-migration-v1', '우체통'     , 'manmade', '우체통이나 우편함 표시를 찾아요'                  , null   , null          , 'mail'           , 'QeQCU', 'medium', null   , null, null, null     , null  , null, null    , 110, true),
  ('m05' , 'api-migration-v1', '가로등'     , 'manmade', '길 위 가로등 기둥이나 등을 찾아요'                , null   , null          , 'lamp'           , 'QeQCU', null    , null   , null, null, null     , null  , null, null    , 120, true),
  ('m06' , 'api-migration-v1', '자전거'     , 'manmade', '세워진 자전거나 자전거 표식을 찾아요'               , null   , null          , 'bike'           , 'QeQCU', null    , null   , null, null, null     , null  , null, null    , 130, true),
  ('m07' , 'api-migration-v1', '우산'      , 'manmade', '우산이나 우산 그림이 보이는 표식을 찾아요'            , null   , null          , 'umbrella'       , 'QeQCU', null    , null   , null, null, null     , null  , null, null    , 140, true),
  ('m08' , 'api-migration-v1', '의자'      , 'manmade', '공원·가게 앞·건물 안의 의자를 찾아요'              , null   , null          , 'armchair'       , 'QeQCU', null    , null   , null, null, null     , null  , null, null    , 150, true),
  ('m09' , 'api-migration-v1', '벽화'      , 'manmade', '벽에 그려진 그림이나 큰 그래픽을 찾아요'             , null   , null          , 'brush'          , 'QeQCU', 'medium', null   , null, null, null     , null  , null, null    , 160, true),
  ('m10' , 'api-migration-v1', '횡단보도'    , 'manmade', '도로 위 흰 줄무늬 횡단보도를 찾아요'               , null   , null          , 'square-asterisk', 'QeQCU', null    , null   , null, null, null     , null  , null, null    , 170, true),
  ('a01' , 'api-migration-v1', '고양이'     , 'animal' , '멀리서 보이는 고양이를 방해하지 않고 찍어요'           , null   , null          , 'cat'            , 'QeQCU', null    , null   , null, null, null     , null  , null, null    , 180, true),
  ('a02' , 'api-migration-v1', '강아지'     , 'animal' , '산책 중인 강아지는 보호자와 거리를 두고 찍어요'         , null   , null          , 'dog'            , 'QeQCU', null    , null   , null, null, null     , null  , null, null    , 190, true),
  ('a03' , 'api-migration-v1', '참새'      , 'animal' , '전봇대·나무·바닥 근처의 작은 새를 찾아요'            , null   , null          , 'bird'           , 'QeQCU', null    , null   , null, null, null     , null  , null, null    , 200, true),
  ('a04' , 'api-migration-v1', '나비'      , 'animal' , '꽃이나 풀 근처에서 나비를 찾아요'                 , null   , null          , 'bug'            , 'QeQCU', 'hard'  , null   , null, null, null     , null  , null, null    , 210, true),
  ('a05' , 'api-migration-v1', '비둘기'     , 'animal' , '광장이나 길가의 비둘기를 멀리서 찍어요'              , null   , null          , 'bird'           , 'QeQCU', null    , null   , null, null, null     , null  , null, null    , 220, true),
  ('a06' , 'api-migration-v1', '물고기'     , 'animal' , '연못·수조·간판 속 물고기를 찾아요'                , null   , null          , 'fish'           , 'QeQCU', 'medium', null   , null, null, null     , null  , null, null    , 230, true),
  ('t01' , 'api-migration-v1', '7'       , 'time'   , '간판·주소·버스 번호처럼 보이는 숫자 7을 찾아요'        , '숫자 찾기', '숫자 7'        , null             , 'QeQCU', null    , null   , true, 34  , null     , null  , null, null    , 240, true),
  ('t02' , 'api-migration-v1', '5'       , 'time'   , '간판·주소·가격표처럼 보이는 숫자 5를 찾아요'          , '숫자 찾기', '숫자 5'        , null             , 'QeQCU', null    , null   , true, 34  , null     , null  , null, null    , 250, true),
  ('t03' , 'api-migration-v1', 'T'       , 'time'   , '간판·로고·티셔츠처럼 보이는 T 글자를 찾아요'          , '글자 찾기', 'T 글자'        , null             , 'QeQCU', null    , null   , true, 30  , null     , null  , null, null    , 260, true),
  ('t04' , 'api-migration-v1', '시계'      , 'time'   , '건물 벽·간판·손목 위에서 시간이 보이는 시계를 찾아요'     , null   , null          , 'clock'          , 'QeQCU', null    , null   , null, null, null     , null  , null, null    , 270, true),
  ('t05' , 'api-migration-v1', '달'       , 'time'   , '하늘이나 간판·소품에서 달 모양을 찾아요'             , null   , '달 모양'        , 'moon'           , 'QeQCU', 'medium', null   , null, null, null     , null  , null, null    , 280, true),
  ('t06' , 'api-migration-v1', '별'       , 'time'   , '간판·스티커·장식에서 별 모양을 찾아요'              , null   , '별 모양'        , 'star'           , 'QeQCU', 'hard'  , null   , null, null, null     , null  , null, null    , 290, true),
  ('sf01', 'api-migration-v1', '활짝 웃은 셀카', 'self'   , '얼굴이 보이게 활짝 웃은 셀카를 찍어요'              , null   , null          , 'smile'          , 'k4Srv', 'easy'  , 'front', null, null, null     , null  , null, null    , 300, true),
  ('sf02', 'api-migration-v1', '손가락 하트'  , 'self'   , '손가락 하트가 화면 중앙에 보이게 찍어요'             , null   , null          , 'heart'          , 'k4Srv', 'easy'  , 'front', null, null, null     , null  , null, null    , 310, true),
  ('sf03', 'api-migration-v1', '엄지척 셀카'  , 'self'   , '엄지척 포즈가 보이게 셀카를 찍어요'                , null   , null          , 'thumbs-up'      , 'k4Srv', 'easy'  , 'front', null, null, null     , null  , null, null    , 320, true),
  ('sf04', 'api-migration-v1', '브이 포즈'   , 'self'   , '브이 손 모양이 잘 보이게 찍어요'                 , null   , null          , 'hand'           , 'k4Srv', 'easy'  , 'front', null, null, null     , null  , null, null    , 330, true),
  ('sf05', 'api-migration-v1', '오늘의 신발'  , 'self'   , '오늘 신고 나온 신발이 보이게 찍어요'               , null   , null          , 'footprints'     , 'k4Srv', 'easy'  , 'back' , null, null, null     , null  , null, null    , 340, true),
  ('sf06', 'api-migration-v1', '내 그림자'   , 'self'   , '바닥이나 벽에 생긴 내 그림자를 찍어요'              , null   , null          , 'cloud-sun'      , 'k4Srv', 'medium', 'back' , null, null, null     , null  , null, null    , 350, true),
  ('sf07', 'api-migration-v1', '거울 셀카'   , 'self'   , '거울에 비친 내 모습이 보이게 찍어요'               , null   , null          , 'scan-face'      , 'k4Srv', 'medium', 'back' , null, null, null     , null  , null, null    , 360, true),
  ('sf08', 'api-migration-v1', '표정 셀카'   , 'self'   , '오늘 기분이 드러나는 표정으로 셀카를 찍어요'           , null   , null          , 'laugh'          , 'k4Srv', 'easy'  , 'front', null, null, null     , null  , null, null    , 370, true),
  ('sf09', 'api-migration-v1', '옷 색 셀카'  , 'self'   , '오늘 입은 옷 색이 보이게 찍어요'                 , null   , '옷 색 셀카'      , 'shirt'          , 'k4Srv', 'easy'  , 'front', null, null, null     , null  , null, null    , 380, true),
  ('c01' , 'api-migration-v1', '빨간색'     , 'color'  , '간판·꽃·옷·포장지처럼 빨간 부분을 찾아요'            , '색 찾기' , '빨간색'         , null             , 'QeQCU', null    , null   , null, null, 'red'    , '빨강'  , null, null    , 390, true),
  ('c02' , 'api-migration-v1', '노란색'     , 'color'  , '표지판·불빛·문구류처럼 노란 부분을 찾아요'            , '색 찾기' , '노란색'         , null             , 'QeQCU', null    , null   , null, null, 'yellow' , '노랑'  , null, null    , 400, true),
  ('c03' , 'api-migration-v1', '초록색'     , 'color'  , '잎·문·간판처럼 초록 부분을 찾아요'                , '색 찾기' , '초록색'         , null             , 'QeQCU', null    , null   , null, null, 'green'  , '초록'  , null, null    , 410, true),
  ('c04' , 'api-migration-v1', '파란색'     , 'color'  , '하늘·표지·차량처럼 파란 부분을 찾아요'              , '색 찾기' , '파란색'         , null             , 'QeQCU', null    , null   , null, null, 'blue'   , '파랑'  , null, null    , 420, true),
  ('c05' , 'api-migration-v1', '분홍색'     , 'color'  , '꽃·소품·간판처럼 분홍 부분을 찾아요'               , '색 찾기' , '분홍색'         , null             , 'QeQCU', null    , null   , null, null, 'pink'   , '분홍'  , null, null    , 430, true),
  ('c06' , 'api-migration-v1', '하얀색'     , 'color'  , '벽·구름·표지처럼 하얀 부분을 찾아요'               , '색 찾기' , '하얀색'         , null             , 'QeQCU', null    , null   , null, null, 'white'  , '하양'  , null, null    , 440, true),
  ('c07' , 'api-migration-v1', '검은색'     , 'color'  , '글자·그림자·문처럼 검은 부분을 찾아요'              , '색 찾기' , '검은색'         , null             , 'QeQCU', 'medium', null   , null, null, 'black'  , '검정'  , null, null    , 450, true),
  ('c08' , 'api-migration-v1', '알록달록'    , 'color'  , '여러 색이 함께 보이는 대상을 찾아요'               , '색 찾기' , '알록달록한 색'     , null             , 'QeQCU', 'medium', null   , null, null, 'rainbow', '여러 색', null, null    , 460, true),
  ('free', 'api-migration-v1', 'FREE'    , 'special', '지금 보이는 풍경이나 함께 시작하고 싶은 장면을 자유롭게 담아요', null   , '오늘의 FREE 클립' , 'camera'         , 'rAdyJ', null    , 'back' , null, null, null     , null  , null, 'center', 470, true)
on conflict (catalog_version, mission_id) do update
  set
      label = excluded.label,
      category = excluded.category,
      hint = excluded.hint,
      caption = excluded.caption,
      capture_label = excluded.capture_label,
      icon = excluded.icon,
      variant = excluded.variant,
      difficulty = excluded.difficulty,
      camera = excluded.camera,
      text_only = excluded.text_only,
      font_size = excluded.font_size,
      swatch = excluded.swatch,
      swatch_label = excluded.swatch_label,
      no_photo = excluded.no_photo,
      fixed_position = excluded.fixed_position,
      sort_order = excluded.sort_order,
      active = excluded.active;

-- ---------------------------------------------------------------------------
-- 5. mission_categories seed (catalog_version = 'api-migration-v1')
--    7 categories.
-- ---------------------------------------------------------------------------

insert into public.mission_categories (
  catalog_version, key, label, tone, count
)
values
  ('api-migration-v1', 'nature' , '자연·식물', 'brand-primary', 8),
  ('api-migration-v1', 'manmade', '인공물'  , 'brand-primary', 10),
  ('api-migration-v1', 'animal' , '동물'   , 'brand-primary', 6),
  ('api-migration-v1', 'time'   , '시간·숫자', 'brand-primary', 6),
  ('api-migration-v1', 'self'   , '셀프'   , 'cat-self'     , 9),
  ('api-migration-v1', 'color'  , '색깔'   , 'cat-color'    , 8),
  ('api-migration-v1', 'special', '특수'   , 'brand-accent' , 1)
on conflict (catalog_version, key) do update
  set
      label = excluded.label,
      tone = excluded.tone,
      count = excluded.count;
