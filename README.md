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
- When build CI is added, run `pnpm verify:mission-seed` as a step so a stale
  seed blocks the build via `git diff --exit-code`.

## Runtime Boundary

Flutter calls this API for privileged operations such as Cloudflare R2 presigned URLs, media confirmation, guest promotion, account deletion, and cleanup jobs. Supabase remains the Auth/Postgres provider.

## Render Runtime Debugging

Runtime failures are triaged from Render Events, Logs, and `/v1/health`.
The app emits structured one-line logs for bootstrap, request completion, 5xx
exceptions, and process-level failures. See
[`plans/render-runtime-debugging.md`](plans/render-runtime-debugging.md) for the
incident checklist.

## Render Free Keep-Warm

The [keep-warm workflow](.github/workflows/keep-render-warm.yml) calls the public
`/v1/health` endpoint every 10 minutes from 09:00 through 22:50 in the
`Asia/Seoul` timezone. The final request keeps the service inside Render's
15-minute idle window until roughly 23:00, after which it can spin down overnight.

The workflow:

- can also be run manually with `workflow_dispatch`;
- retries until a 180-second wall-clock deadline when Render is already waking
  up;
- only succeeds when the endpoint returns HTTP 200 and valid JSON containing
  `"ok": true` and `"service": "sappeun-api"`;
- uses no repository secrets and does not check out the source code.

This 14-hour daily warm window uses roughly 437 instance hours in a 31-day month,
including Render's normal 15-minute spin-down window. That is within Render's
750-hour monthly workspace allowance. Adding another Free service would share
that allowance and can exhaust it earlier. Health-check responses also count
toward Render's outbound bandwidth allowance; their payload is tiny, but
workspace usage should still be monitored. GitHub can delay or drop scheduled
runs, and scheduled workflows in public repositories are disabled after 60 days
without repository activity, so this reduces cold starts but is not an uptime
guarantee.
