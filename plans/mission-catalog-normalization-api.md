# Mission Catalog Normalization — API Plan

- Status: active implementation plan
- Created: 2026-06-08
- Scope: Normalize mission identity/content into `mission_content` while keeping `mission_badges` focused on reward metadata and earned-badge linkage.

## Goal

The Flutter app previously carried mission labels, hints, capture labels, icon metadata, category text, and visual variant metadata in bundled `sheet.json`. That mission content now belongs in Supabase `mission_content`.

`mission_badges` must not become the mission content table. It is the reward catalog used by `board_badges`, `user_badges`, and the `award_board_badges` RPC. Badge rows should point to the mission content master by `(catalog_version, mission_id)`.

## Target DB Shape

`mission_content`

- Primary key: `(catalog_version, mission_id)`
- Owns mission identity/content: `label`, `category`, `hint`, `caption`, `capture_label`, `icon`, `variant`, `difficulty`, `camera`, `text_only`, `font_size`, `swatch`, `swatch_label`, `no_photo`, `fixed_position`, `sort_order`, `active`
- Includes `free` / `special` because it is board content, even though it does not mint a badge.

`mission_categories`

- Primary key: `(catalog_version, key)`
- Owns category display metadata: `label`, `tone`, `count`

`mission_badges`

- Primary key: `id` (`mission:<mission_id>:v1`)
- Unique key: `(catalog_version, mission_id)`
- Foreign key: `(catalog_version, mission_id) -> mission_content(catalog_version, mission_id)`
- Owns reward metadata only: `grade_label`, `grade_color`, `artwork_key`, `sort_order`, `active`, `created_at`
- Legacy columns `title`, `category`, `difficulty` are deploy-compatibility columns only and should be removed after all API reads join `mission_content`.

`board_badges` / `user_badges`

- Continue to reference `mission_badges(id)`, because they record badge awards, not mission content rows.

## Deployment Order

1. Apply additive DB migration `0011_mission_badges_content_fk.sql`.
2. Deploy API code that reads badge title/category/difficulty from `mission_content` via the FK join.
3. Verify:
   - `GET /v1/badges/catalog`
   - `GET /v1/users/me/badges`
   - `GET /v1/users/me/badges/:badgeId`
   - board completion badge awarding
4. After deployed API is confirmed, add cleanup migration:
   - Drop `mission_badges.title`
   - Drop `mission_badges.category`
   - Drop `mission_badges.difficulty`
   - Drop `mission_badges_title_check`
   - Drop `mission_badges_difficulty_check`
5. Keep `mission_badges.id` stable forever for historical `board_badges` / `user_badges`.

## Acceptance Criteria

- Every active badge row has a matching mission content row.
- Badge APIs do not select `mission_badges.title`, `mission_badges.category`, or `mission_badges.difficulty`.
- Mission content changes flow to badge catalog display through the join.
- The `free` mission content row does not create a badge.
- Historical earned badges remain readable by `mission_badges.id`.

## Verification Queries

```sql
select count(*) filter (where mc.mission_id is null) as badge_without_content_count
from public.mission_badges mb
left join public.mission_content mc
  on mc.catalog_version = mb.catalog_version
 and mc.mission_id = mb.mission_id;
```

Expected: `0`.

```sql
select conname, pg_get_constraintdef(oid)
from pg_constraint
where conname = 'mission_badges_mission_content_fkey';
```

Expected: FK from `mission_badges(catalog_version, mission_id)` to `mission_content(catalog_version, mission_id)`.
