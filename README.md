# sappeun-api

NestJS API for the Sappeun Flutter app.

## Local Setup

```bash
pnpm install
cp .env.example .env
pnpm dev
```

## Scripts

- `pnpm dev`: run NestJS in watch mode
- `pnpm build`: compile the API
- `pnpm start`: run the compiled API
- `pnpm test`: run unit tests
- `pnpm gen:mission-seed`: regenerate `supabase/migrations/0010_mission_content.sql` from `src/missions/sheet.source.json` (the single source of truth for mission content)
- `pnpm verify:mission-seed`: drift gate — regenerate the seed and fail if the committed migration changes

## Mission Seed Drift Gate

Mission content lives in one source of truth: `src/missions/sheet.source.json`
(a byte-identical copy of the Flutter bundle `apps/mobile/assets/data/sheet.json`).
The migration `supabase/migrations/0010_mission_content.sql` is generated from it
and must never be hand-edited. To keep the two in sync:

- Regenerate after any source change: `pnpm gen:mission-seed`.
- The parity contract test `src/missions/mission-seed-parity.spec.ts` re-derives the
  expected rows from the generator and matches them against the committed SQL, so
  `pnpm test` already fails on drift (stale regen or manual edits).
- When CI is added (no `.github/workflows` yet), run `pnpm verify:mission-seed` as a
  step so a stale seed blocks the build via `git diff --exit-code`.

## Runtime Boundary

Flutter calls this API for privileged operations such as Cloudflare R2 presigned URLs, media confirmation, guest promotion, account deletion, and cleanup jobs. Supabase remains the Auth/Postgres provider.
