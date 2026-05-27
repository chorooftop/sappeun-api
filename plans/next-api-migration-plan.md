# Next.js API To NestJS Migration Plan

Status: active plan
Created: 2026-05-27
Source routes: `/Users/oksang/Desktop/sappeun/sappeun/src/app/api/**`
Source server logic: `/Users/oksang/Desktop/sappeun/sappeun/src/lib/{boards,photos,clips,share,auth,api,storage,supabase}/**`

## Inventory

The current Next.js API surface has 22 route handlers:

| Current route                            | Methods           | Main source logic                                                      | NestJS target |
| ---------------------------------------- | ----------------- | ---------------------------------------------------------------------- | ------------- |
| `/api/profile`                           | `GET`, `PATCH`    | `auth/session.ts`, `supabase/server.ts`                                | `users`       |
| `/api/boards`                            | `GET`             | `boards/server.ts:listUserBoards`                                      | `boards`      |
| `/api/boards/active`                     | `GET`             | `boards/server.ts:getLatestUserBoardSession`                           | `boards`      |
| `/api/boards/current`                    | `GET`, `DELETE`   | `boards/server.ts:getLatestUserBoardSession`, `deleteActiveUserBoards` | `boards`      |
| `/api/boards/session`                    | `POST`            | `boards/server.ts:ensureUserBoardFromSession`                          | `boards`      |
| `/api/boards/adopt-guest-session`        | `POST`            | `boards/server.ts:adoptGuestBoardSession`                              | `boards`      |
| `/api/boards/[boardId]`                  | `GET`, `DELETE`   | `boards/server.ts:getUserBoardDetail`, `deleteUserBoard`               | `boards`      |
| `/api/boards/[boardId]/end`              | `POST`            | `boards/server.ts:endUserBoard`                                        | `boards`      |
| `/api/boards/[boardId]/cells/[position]` | `PATCH`, `POST`   | `boards/server.ts:markUserBoardCell`, `replaceUserBoardCell`           | `boards`      |
| `/api/photos/presign`                    | `POST`            | `photos/server.ts:preparePhotoUpload`                                  | `media`       |
| `/api/photos/confirm`                    | `POST`            | `photos/server.ts:confirmPhotoUpload`                                  | `media`       |
| `/api/photos/preview`                    | `POST`            | `photos/server.ts:createPhotoPreviewUrls`                              | `media`       |
| `/api/photos/[photoId]`                  | `DELETE`          | `photos/server.ts:deletePhoto`                                         | `media`       |
| `/api/photos/promote-guest`              | `POST`            | `photos/server.ts:promoteGuestPhotosForUser`                           | `media`       |
| `/api/clips/presign`                     | `POST`            | `clips/server.ts:prepareClipUpload`                                    | `media`       |
| `/api/clips/confirm`                     | `POST`            | `clips/server.ts:confirmClipUpload`                                    | `media`       |
| `/api/clips/preview`                     | `POST`            | `clips/server.ts:createClipPreviewUrls`                                | `media`       |
| `/api/clips/[clipId]`                    | `DELETE`, `PATCH` | `clips/server.ts:deleteClip`, `updateClipDescription`                  | `media`       |
| `/api/clips/promote-guest`               | `POST`            | `clips/server.ts:promoteGuestClipsForUser`                             | `media`       |
| `/api/share/[boardId]`                   | `POST`, `DELETE`  | `share/server.ts:createBoardShare`, `deleteBoardShare`                 | `shares`      |
| `/api/jobs/cleanup-temp-photos`          | `GET`             | `photos/server.ts:cleanupExpiredGuestPhotos`                           | `jobs`        |
| `/api/jobs/cleanup-temp-clips`           | `GET`             | `clips/server.ts:cleanupExpiredGuestClips`                             | `jobs`        |

## Cross-Cutting Contracts To Preserve

- Current bearer auth accepts `Authorization: Bearer <token>` and validates with Supabase `auth.getUser(token)`.
- Mobile guest sessions use `X-Sappeun-Guest-Session-Id`, must be UUIDs, and override web cookies.
- Upload responses must preserve `storageProvider`, `bucketName`, `uploadHeaders`, `path`, `token`, `expiresAt`, media id, and owner kind fields until Flutter is deliberately updated.
- Photo and clip preview responses must return short-lived R2 preview URLs with expiry timestamps.
- Cron cleanup remains protected by `CRON_SECRET`.
- Existing DB schema remains Supabase Postgres; do not introduce a new database ownership layer during the first migration.

## Migration Order

### Phase 1. Foundation And Media Upload Boundary

Move:

- Auth request resolution
- Guest session resolution
- R2 object key generation and signed URL creation
- Photo presign/confirm/preview/delete
- Clip presign/confirm/preview/delete/update description
- Guest photo/clip promotion

Reason: media upload is the strongest reason to separate API security from Flutter. This phase proves the NestJS API can own R2 credentials and service-role operations.

### Phase 2. Board Session And History

Move:

- List boards
- Get board detail
- Ensure board from session
- Current/active board session
- Mark/replace cells
- End/delete boards
- Adopt guest board session

Reason: board behavior is shared by media confirmation, history, sharing, and Flutter resume flows. Move after media primitives exist so the board service can call media helpers instead of duplicating preview logic.

### Phase 3. Sharing

Move:

- Create share
- Delete share
- Public shared board detail
- Share URL/OG image URL assembly policy

Reason: share reads combine board cells, photos, clips, and preview URL generation. Port after boards and media are stable.

### Phase 4. Users And Account Lifecycle

Move:

- Current profile read/update
- Sign-up/onboarding status
- Account deletion orchestration
- User-owned board/media/share purge policy

Reason: account deletion crosses Supabase Auth, metadata rows, and R2 objects. It should be implemented only after media delete semantics are settled in NestJS.

### Phase 5. Jobs And Operations

Move:

- Cleanup expired guest photos
- Cleanup expired guest clips
- Future repair/reconciliation jobs

Reason: job endpoints should run against the same services as user-facing endpoints so cleanup cannot drift from upload semantics.

## Route Compatibility

New Flutter work should target `/v1/**`. If needed, add temporary compatibility controllers for existing Next.js paths:

- `/api/photos/*` -> `media`
- `/api/clips/*` -> `media`
- `/api/boards/*` -> `boards`
- `/api/share/*` -> `shares`

Compatibility aliases should be removed after Flutter and web callers are updated.

## Gaps To Improve During Migration

- Add a unified media object table or view only if photo/clip duplication becomes costly. Keep current schema for the first migration.
- Add request id logging before production deployment.
- Add rate limits to presign endpoints to reduce R2 URL abuse.
- Add object reconciliation jobs that compare pending DB rows against R2 `HEAD` results.
- Add OpenAPI once route parity stabilizes; do not block the first migration on Swagger DTO conversion.
- Add explicit public share code route (`GET /v1/shares/:shareCode`) if Next.js page code currently fetches share details directly from server functions.

## Review Result

The plan is suitable for the first implementation pass with one adjustment: keep request/response compatibility for media APIs while placing new routes under `/v1/media/**`. That lets Flutter migrate with minimal data contract churn and leaves path changes as a small client concern.

No additional pre-implementation blockers were found. Proceed with the foundation and media boundary first.
