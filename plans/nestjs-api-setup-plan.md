# Sappeun API NestJS Setup Plan

Status: active plan
Created: 2026-05-27
Source app: `/Users/oksang/Desktop/sappeun/sappeun`

## Decision

Build `sappeun-api` as a NestJS modular monolith that owns the mobile API boundary. Flutter should call this API for all privileged operations, while Supabase remains the identity and metadata database and Cloudflare R2 remains the private media object store.

The initial design favors a modular monolith over microservices because Sappeun's current domain is still tightly coupled: board sessions, media uploads, guest promotion, sharing, and account deletion all touch the same ownership and storage invariants.

## Architecture Pattern

- `auth`: resolves Supabase access tokens, exposes current user decorators/guards, and validates mobile guest session headers.
- `supabase`: centralizes anon and service-role Supabase clients.
- `storage`: wraps Cloudflare R2 S3-compatible access, object key generation, presigned upload/preview URLs, copy, head, and delete operations.
- `media`: owns photo and clip upload lifecycle APIs.
- `boards`: owns board session persistence, history, cell state changes, and guest board adoption.
- `shares`: owns public share creation, deletion, and public read models.
- `users`: owns profile/account APIs and future account deletion orchestration.
- `jobs`: owns cron-protected cleanup endpoints.
- `common`: pipes, filters, domain errors, request helpers.

Controllers should remain thin. Business rules should live in services. Supabase queries should stay behind feature services first; introduce a dedicated repository layer only where query volume or duplication becomes painful.

## API Boundary

Use versioned REST routes under `/v1` for new Flutter integration. Keep compatibility aliases in the migration plan for the old Next.js paths where they reduce Flutter churn.

Preferred new routes:

- `GET /v1/health`
- `GET /v1/users/me`
- `PATCH /v1/users/me`
- `GET /v1/boards`
- `POST /v1/boards/session`
- `GET /v1/boards/current`
- `DELETE /v1/boards/current`
- `GET /v1/boards/:boardId`
- `DELETE /v1/boards/:boardId`
- `POST /v1/boards/:boardId/end`
- `PATCH /v1/boards/:boardId/cells/:position`
- `POST /v1/boards/:boardId/cells/:position`
- `POST /v1/boards/adopt-guest-session`
- `POST /v1/media/photos/presign`
- `POST /v1/media/photos/confirm`
- `POST /v1/media/photos/preview`
- `DELETE /v1/media/photos/:photoId`
- `POST /v1/media/clips/presign`
- `POST /v1/media/clips/confirm`
- `POST /v1/media/clips/preview`
- `PATCH /v1/media/clips/:clipId`
- `DELETE /v1/media/clips/:clipId`
- `POST /v1/shares/:boardId`
- `DELETE /v1/shares/:boardId`
- `GET /v1/shares/:shareCode`
- `POST /v1/jobs/cleanup-temp-photos`
- `POST /v1/jobs/cleanup-temp-clips`

## Auth And Ownership

- Flutter sends `Authorization: Bearer <Supabase access_token>` for authenticated users.
- Flutter sends `X-Sappeun-Guest-Session-Id` for guest media/session operations.
- Invalid bearer headers fail with `401`.
- Invalid guest session headers fail with `400`.
- Server-side ownership checks happen before issuing R2 URLs or mutating metadata.
- Supabase service-role access is server-only and never exposed to Flutter.

## Media Storage

Cloudflare R2 remains private. The API issues short-lived presigned URLs. Client uploads go directly to R2 with signed `Content-Type`; the API confirms uploads by calling `HEAD` and comparing content type and size before marking DB rows uploaded.

Object keys should not expose raw user ids. Use HMAC owner prefixes:

- `users/{ownerHash}/boards/{boardId}/cells/{position}/photos/{photoId}.{ext}`
- `users/{ownerHash}/boards/{boardId}/cells/{position}/clips/{clipId}.{ext}`
- `users/{ownerHash}/boards/{boardId}/cells/{position}/posters/{clipId}.{ext}`
- `temp/{guestHash}/boards/{clientBoardSessionId}/cells/{position}/...`

## Validation Strategy

Use Zod schemas in the API layer because the current Next.js API already defines its request contracts with Zod. NestJS DTO classes can be introduced later if Swagger generation becomes a priority, but preserving contract parity is more important during migration.

## Environment

Required runtime variables:

- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`
- `R2_ACCOUNT_ID`
- `R2_ACCESS_KEY_ID`
- `R2_SECRET_ACCESS_KEY`
- `R2_BUCKET`
- `R2_OWNER_HASH_SECRET`

Optional runtime variables:

- `PORT`
- `API_PREFIX`
- `CORS_ORIGINS`
- `R2_ENDPOINT`
- `R2_REGION`
- `CRON_SECRET`

## Testing Strategy

- Unit test pure auth parsing, guest session parsing, env validation, and R2 key generation.
- Unit test media service with mocked Supabase and R2 adapters.
- Add e2e tests after the first route parity slice lands.
- Keep external R2 smoke tests separate from normal CI because they require real credentials.

## Initial Implementation Slice

1. Bootstrap NestJS with config validation, health route, CORS, Helmet, and TypeScript build/test scripts.
2. Add Supabase anon/admin client providers.
3. Add auth/guest request resolution.
4. Add R2 service with current Sappeun object key policy.
5. Add media schemas and first photo/clip presign/confirm/preview/delete controller surface.
6. Add migration plan for the rest of the Next.js API.

## Review Notes

The main risk is silently changing existing API semantics while moving out of Next.js. To reduce that risk, the migration should keep request/response shapes compatible until Flutter is explicitly updated to the new `/v1` routes.

The second risk is duplicating board/media logic. During the transition, `sappeun-api` becomes the source of truth for mobile API behavior and the Next.js app should gradually downgrade to shared web pages, policy pages, and reference implementation only.
