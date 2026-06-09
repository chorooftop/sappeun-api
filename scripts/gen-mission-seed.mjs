#!/usr/bin/env node
// gen-mission-seed.mjs
// Deterministic generator: sheet.source.json -> 0010_mission_content.sql.
//
// Source of truth for mission CONTENT is the vendored sheet.source.json
// (byte-identical copy of apps/mobile/assets/data/sheet.json). Hand-writing
// a second INSERT is forbidden; this generator is the only writer of
// 0010_mission_content.sql. Re-running produces identical output (determinism),
// so a CI `git diff --exit-code` gate can block catalog drift.
//
// Style mirrors 0006_bingo_editable_badges.sql / 0009_mission_difficulty_sync.sql:
// lowercase SQL, do-block constraint/policy guards, RLS revoke/grant,
// on conflict ... do update, idempotent.
//
// Usage: pnpm gen:mission-seed   (node scripts/gen-mission-seed.mjs)

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');

const SOURCE_PATH = resolve(repoRoot, 'src/missions/sheet.source.json');
const OUTPUT_PATH = resolve(
  repoRoot,
  'supabase/migrations/0010_mission_content.sql',
);

const CATALOG_VERSION = 'api-migration-v1';

// snake_case ordered columns for mission_content (matches table DDL order).
const CONTENT_COLUMNS = [
  'mission_id',
  'catalog_version',
  'label',
  'category',
  'hint',
  'caption',
  'capture_label',
  'icon',
  'variant',
  'difficulty',
  'camera',
  'text_only',
  'font_size',
  'swatch',
  'swatch_label',
  'no_photo',
  'fixed_position',
  'awards_badge',
  'sort_order',
  'active',
];

// camelCase (sheet.json) -> snake_case (db) for content cell fields.
const CELL_KEY_MAP = {
  captureLabel: 'capture_label',
  swatchLabel: 'swatch_label',
  textOnly: 'text_only',
  fontSize: 'font_size',
  noPhoto: 'no_photo',
  fixedPosition: 'fixed_position',
};

/** SQL single-quoted string literal with '' escaping. */
function sqlString(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

/** Render a JS value to a SQL literal for the given column. null -> `null`. */
function sqlLiteral(column, value) {
  if (value === undefined || value === null) {
    return 'null';
  }
  if (
    column === 'text_only' ||
    column === 'no_photo' ||
    column === 'awards_badge' ||
    column === 'active'
  ) {
    return value ? 'true' : 'false';
  }
  if (column === 'font_size' || column === 'sort_order') {
    return String(value);
  }
  return sqlString(value);
}

function buildContentRow(cell, index) {
  // Normalize camelCase source keys to snake_case lookups.
  const normalized = {};
  for (const [key, val] of Object.entries(cell)) {
    normalized[CELL_KEY_MAP[key] ?? key] = val;
  }

  const row = {
    mission_id: cell.id,
    catalog_version: CATALOG_VERSION,
    label: normalized.label,
    category: normalized.category,
    hint: normalized.hint ?? null,
    caption: normalized.caption ?? null,
    capture_label: normalized.capture_label ?? null,
    icon: normalized.icon ?? null, // present-but-null preserved as null literal
    variant: normalized.variant,
    difficulty: normalized.difficulty ?? null,
    camera: normalized.camera ?? null,
    text_only: normalized.text_only ?? null,
    font_size: normalized.font_size ?? null,
    swatch: normalized.swatch ?? null, // name only, no hex
    swatch_label: normalized.swatch_label ?? null,
    no_photo: normalized.no_photo ?? null,
    fixed_position: normalized.fixed_position ?? null,
    awards_badge: normalized.category !== 'special' && cell.id !== 'free',
    sort_order: index * 10,
    active: true,
  };

  return CONTENT_COLUMNS.map((col) => sqlLiteral(col, row[col]));
}

function buildCategoryRow(key, info) {
  return [
    sqlString(CATALOG_VERSION),
    sqlString(key),
    sqlString(info.label),
    info.tone === undefined || info.tone === null
      ? 'null'
      : sqlString(info.tone),
  ];
}

/** Pad each column of each row to align the values block for readability. */
function alignRows(rows) {
  const widths = [];
  for (const row of rows) {
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i] ?? 0, cell.length);
    });
  }
  return rows.map((row) =>
    row.map((cell, i) => cell.padEnd(widths[i])).join(', ').replace(/\s+$/, ''),
  );
}

/**
 * Build the SQL-literal row arrays from a parsed sheet object.
 * Exported so the parity contract test can compare the generator's mapping
 * against the committed migration without re-implementing the logic.
 */
export function buildSeedRows(sheet) {
  const cells = sheet.cells ?? [];
  const categories = sheet.categories ?? {};

  const contentRows = cells.map((cell, i) => buildContentRow(cell, i));
  const categoryRows = Object.entries(categories).map(([key, info]) =>
    buildCategoryRow(key, info),
  );

  return { contentRows, categoryRows };
}

export { CONTENT_COLUMNS, CATALOG_VERSION, SOURCE_PATH, OUTPUT_PATH };

function generate() {
  const raw = readFileSync(SOURCE_PATH, 'utf8');
  const sheet = JSON.parse(raw);

  const cells = sheet.cells ?? [];

  const { contentRows, categoryRows } = buildSeedRows(sheet);

  const contentValues = alignRows(contentRows)
    .map((line) => `  (${line})`)
    .join(',\n');

  const categoryValues = alignRows(categoryRows)
    .map((line) => `  (${line})`)
    .join(',\n');

  const contentCols = CONTENT_COLUMNS.join(', ');

  const contentUpdateCols = CONTENT_COLUMNS.filter(
    (c) => c !== 'catalog_version' && c !== 'mission_id',
  );
  const contentUpdateSet = contentUpdateCols
    .map((c) => `      ${c} = excluded.${c}`)
    .join(',\n');

  const categoryUpdateSet = ['label', 'tone']
    .map((c) => `      ${c} = excluded.${c}`)
    .join(',\n');

  const sql = `-- 0010_mission_content.sql
-- GENERATED FILE. Do not edit by hand.
-- Source of truth: src/missions/sheet.source.json (byte-identical copy of
-- apps/mobile/assets/data/sheet.json, v${sheet.version}).
-- Regenerate with: pnpm gen:mission-seed
--
-- Mission CONTENT master tables (mission_content + mission_categories) for the
-- DB-as-single-source migration (plans/mission-content-db-migration.md Phase 1/2).
-- catalog_version = '${CATALOG_VERSION}'.
--
-- Style matches 0006/0009: lowercase SQL, do-block constraint/policy guards,
-- RLS revoke/grant, on conflict do update, idempotent.
--
-- mission_content holds ${cells.length} cells (free/special included).
-- mission_categories holds ${categoryRows.length} categories.
-- camelCase sheet.json keys -> snake_case columns (captureLabel -> capture_label,
-- swatchLabel -> swatch_label, textOnly -> text_only, fontSize -> font_size,
-- noPhoto -> no_photo, fixedPosition -> fixed_position). icon absent/null -> null.
-- swatch stores the color NAME only (no hex). difficulty absent -> null.
-- awards_badge is false only for the free/special center cell.

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
  awards_badge boolean not null default true,
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
-- 4. mission_content seed (catalog_version = '${CATALOG_VERSION}')
--    ${cells.length} cells, source order preserved, sort_order = index * 10.
-- ---------------------------------------------------------------------------

insert into public.mission_content (
  ${contentCols}
)
values
${contentValues}
on conflict (catalog_version, mission_id) do update
  set
${contentUpdateSet};

-- ---------------------------------------------------------------------------
-- 5. mission_categories seed (catalog_version = '${CATALOG_VERSION}')
--    ${categoryRows.length} categories.
-- ---------------------------------------------------------------------------

insert into public.mission_categories (
  catalog_version, key, label, tone
)
values
${categoryValues}
on conflict (catalog_version, key) do update
  set
${categoryUpdateSet};
`;

  writeFileSync(OUTPUT_PATH, sql, 'utf8');
  process.stdout.write(
    `wrote ${OUTPUT_PATH}\n` +
      `  mission_content rows: ${contentRows.length}\n` +
      `  mission_categories rows: ${categoryRows.length}\n`,
  );
}

// Run the CLI only when executed directly (node scripts/gen-mission-seed.mjs).
// When imported by the parity test, only the helpers above are exposed.
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  generate();
}
