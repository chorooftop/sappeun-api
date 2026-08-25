> **⚠️ ARCHIVED (2026-08-25)** — 이 레포는 모노레포 [chorooftop/sappeun](https://github.com/chorooftop/sappeun)의 `apps/api/`로 병합되었다 (히스토리 보존). 이후 작업은 모노레포에서 진행한다.

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

## Deployment (Google Cloud Run)

```
project   sappeun (640444807734)
service   sappeun-api        region asia-northeast1 (Tokyo)
url       https://sappeun-api-640444807734.asia-northeast1.run.app
image     asia-northeast1-docker.pkg.dev/sappeun/sappeun/api:<git-sha>
scaling   --min-instances 0 --max-instances 3 --concurrency 80 --cpu-boost
```

Routine deploys go through the script:

```bash
./scripts/deploy-cloud-run.sh              # build + deploy + smoke
./scripts/deploy-cloud-run.sh --no-build   # redeploy an already-built sha
```

It tags the image with the current commit sha, **refuses to run when any build
input is uncommitted** (so the tag never lies about what is running), replaces
only the image so env vars and secrets are inherited from the previous revision,
and runs a smoke suite that prints rollback instructions on failure. Changing the
env vars or secrets themselves needs the full deploy command instead — see
[`plans/cloud-run-migration.md`](plans/cloud-run-migration.md) §5 Phase 2.

Images are built with **Cloud Build** (`gcloud builds submit`), not locally — this
repo is developed without a container runtime. Note that `gcloud builds submit`
honours `.gcloudignore` (gitignore syntax), not `.dockerignore`, so directory
excludes there must be root-anchored (`/supabase`, not `supabase`) or they will
also strip `src/supabase/`.

Credentials live in **Secret Manager** and are injected with `--set-secrets`.
Non-credential values go through `--env-vars-file` (a YAML file is required
because `CORS_ORIGINS` contains commas, which `--set-env-vars` treats as a
separator).

Scheduled cleanup runs on **Cloud Scheduler** — `cleanup-temp-photos` (03:10 KST),
`cleanup-temp-clips` (03:20), `cleanup-stale-user-media` (03:30). Each one touches
Postgres, which doubles as the keep-alive that stops Supabase Free from pausing
the project after 7 idle days, so no separate ping job is needed.

Full migration record, deploy commands, rollback, and measured cold-start numbers:
[`plans/cloud-run-migration.md`](plans/cloud-run-migration.md).

## Runtime Debugging

Runtime failures are triaged from Cloud Run logs and `/v1/health`. The app emits
structured one-line logs for bootstrap, request completion, 5xx exceptions, and
process-level failures.

```bash
gcloud logging read \
  'resource.type=cloud_run_revision AND resource.labels.service_name=sappeun-api' \
  --project sappeun --limit 20
```

`app_bootstrap_started` and `app_listening` carry `uptimeMs`, which separates
application boot time from Cloud Run container startup when diagnosing latency.

## Render (being retired)

Render is still the host that already-released Flutter builds point at, so the
service stays up until the app is rebuilt against the Cloud Run URL. The
[keep-warm workflow](.github/workflows/keep-render-warm.yml) exists only to mask
Render Free's ~43s cold start during that window; delete it together with the
Render service, not before.