# 영상 저장/조회 및 미션 기록 복구 로직 개선 기획서

## 0. 전제

검토일: 2026-05-31 KST

중요 전제:
- 현재 서비스는 운영 중인 프로덕션 서비스가 아니다.
- 기존 운영 데이터 보존, 백필, 레거시 데이터 호환, 단계적 DB 마이그레이션은 필요 없다.
- 새 migration 파일을 추가하는 방식이 아니라, 개발 DB/스키마 기준을 현재 API 의도에 맞게 바로 재정렬한다.
- 스키마를 정리한 뒤 `supabase/SCHEMA_SNAPSHOT.md`와 baseline dump를 새 기준으로 갱신한다.
- 데이터 레거시 대응용 fallback 코드는 남기지 않는다. 스키마가 맞지 않으면 테스트/스모크에서 즉시 실패하게 한다.

검토 범위:
- 영상/사진 업로드 presign, confirm, preview, delete, guest promotion API
- 미션 보드 생성, 셀 완료 기록, 이전 기록 목록/상세/active session 복구 API
- 공유 기록 생성 및 `shared_board_view` 노출 범위
- Supabase live PostgREST OpenAPI 스키마와 `supabase/migrations/0001_remote_baseline.sql`
- `pnpm build`, `pnpm test`

검증 결과:
- `pnpm build`: 통과
- `pnpm test`: 통과, 7 files / 24 tests
- `pnpm lint`: 통과
- live PostgREST OpenAPI 기준으로 `boards`, `photos`, `clips`, `guest_photo_uploads`, `guest_clip_uploads`에 API가 요구하는 컬럼이 누락되어 있다.
- 현재 테스트는 schema 계약 검증을 추가했지만, DB/R2를 포함한 `media`/`boards` 서비스 통합 흐름은 아직 별도 스모크 테스트가 필요하다.

구현 상태(2026-05-31):
- API 코드는 R2-only/current-schema 기준으로 정리했다.
- media presign은 기존 사용자 보드 검증만 수행하고 보드 스냅샷을 덮어쓰지 않는다.
- user photo/clip confirm은 DB 함수로 media row, `board_cells`, `boards.updated_at`을 한 트랜잭션에서 확정한다.
- confirm DB 함수는 service-role 전용으로 제한했다.
- guest photo promotion은 기존 보드 메타데이터/미션 스냅샷을 덮어쓰지 않는 별도 경로로 분리했다.
- 게스트 media preview는 업로드 완료, 미삭제, 미만료 행만 허용한다.
- 게스트 clip promotion은 promotion 완료 후 `deleted_at`까지 기록한다.
- 인증 사용자 stale upload cleanup은 DB claim 후 R2 삭제 순서로 조정하고, R2 실패 시 retry 가능하도록 claim을 되돌린다.
- 만료된 guest upload cleanup도 DB claim 후 R2 삭제 순서로 조정하고, 실패 시 직전 상태로 되돌린다.
- 미션 보드의 이전 기록/current 복구는 완전한 `mission_snapshot`을 요구하며, 누락 데이터를 placeholder로 합성하지 않는다.
- schema 입력 검증, RPC 권한 검증, cleanup rollback 단위 테스트를 추가했다.

결론:
- 코드와 baseline 기준은 R2-only/current-schema 방향으로 정렬했다.
- 운영 데이터 보존이 필요 없으므로, additive migration/backfill 없이 **DB를 baseline 기준으로 초기화한 뒤 실제 R2/Supabase dev smoke test**로 최종 확인한다.

## 1. 핵심 문제

### P0. API와 DB 스키마 계약 불일치

현재 API가 사용하는데 DB에 없는 컬럼:

| 테이블 | 누락 컬럼 |
|---|---|
| `boards` | `board_kind`, `title`, `description` |
| `photos` | `storage_provider`, `bucket_name`, `object_etag` |
| `clips` | `storage_provider`, `bucket_name`, `object_etag`, `poster_object_etag`, `description` |
| `guest_photo_uploads` | `storage_provider`, `bucket_name`, `object_etag` |
| `guest_clip_uploads` | `storage_provider`, `bucket_name`, `object_etag`, `poster_object_etag`, `board_kind`, `title`, `description`, `mission_snapshots`, `clip_description` |

영향:
- presign insert, confirm update, preview select, guest promotion select/insert가 런타임에서 실패할 수 있다.
- 일부 helper는 DB 스키마 오류를 `NotFoundException`으로 숨겨 원인 파악을 어렵게 만든다.

수정 방향:
- 현재 API 의도에 맞는 clean schema로 DB를 재정렬한다.
- missing-column fallback은 제거한다.
- R2만 지원하는 현재 경계로 단순화한다.

### P0. 미션 v4 보드 메타데이터가 저장되지 못함

`ensureUserBoard`는 `board_kind`, `title`, `description`을 저장하려 하지만 DB에 컬럼이 없다.

영향:
- `boards/session`, 영상 presign, 게스트 승격 중 보드 생성/갱신이 실패할 수 있다.
- 이전 기록 복구 시 보드 종류/제목/설명이 기본값으로만 복구된다.

수정 방향:
- `boards`에 v4 보드 메타데이터 컬럼을 정식 추가한다.
- `board_kind`, `title`은 신규 데이터 기준 not null로 둔다.
- `description`은 선택값이므로 nullable로 둔다.

### P1. 불완전한 media 요청이 보드 스냅샷을 덮어쓸 수 있음

`ensureUserBoard`는 호출될 때마다 보드 metadata와 seed recipe를 갱신한다. 하지만 photo presign에는 `boardKind`, `title`, `description`, `missionSnapshots`가 없고, clip presign에서도 `missionSnapshots`는 optional이다.

영향:
- 완전한 v4 보드가 이후 media presign 요청으로 `title=nickname`, `description=null`, fallback mission snapshot 상태로 퇴화할 수 있다.
- 이전 기록 복구 기준이 “생성 당시 보드”가 아니라 “마지막 media 요청의 부분 스냅샷”이 될 수 있다.

수정 방향:
- `ensureUserBoard`를 두 경로로 분리한다.
  - `ensureUserBoardFromSnapshot`: `/boards/session` 또는 완전한 board snapshot에서만 metadata/snapshot 갱신
  - `ensureUserBoardForMedia`: 기존 보드 확인 및 position/cell 검증만 수행
- media 요청은 board snapshot을 덮어쓰지 않는다.

### P1. 미션 스냅샷 검증이 약함

`missionSnapshots` 누락 또는 `cellIds`와의 불일치가 fallback snapshot으로 조용히 저장될 수 있다.

영향:
- 이전 기록에서 사용자가 실제로 봤던 미션 문구 대신 `cellId` 기반 placeholder가 보일 수 있다.

수정 방향:
- 신규 저장 경로에서는 fallback snapshot을 만들지 않는다.
- version 4 또는 `boardKind='mission'`이면 `missionSnapshots.length === cellIds.length`를 강제한다.
- 각 `cellIds[position]`에 대응하는 `missionSnapshots[position].id` 또는 id set 일치 여부를 검증한다.
- 검증 실패는 400으로 반환한다.

### P1. 같은 셀에 `photo_id`와 `clip_id`가 동시에 남을 수 있음

photo confirm은 `photo_id`만 세팅하고 clip confirm은 `clip_id`만 세팅한다.

영향:
- 한 셀에 사진과 영상이 동시에 연결될 수 있다.
- 상세 조회에서 photo와 clip이 모두 반환되어 대표 완료 상태가 모호해진다.

결정:
- 한 셀의 대표 완료 미디어는 하나만 허용한다.
- 새 미디어가 저장되면 같은 셀의 기존 반대 타입 미디어 연결은 해제한다.

수정 방향:
- clip confirm 시 `photo_id=null`
- photo confirm 시 `clip_id=null`
- DB check constraint로 `photo_id is null or clip_id is null`을 둔다.
- `completion_type='clip'`이면 `clip_id is not null and photo_id is null`
- `completion_type='photo'`이면 `photo_id is not null and clip_id is null`

### P1. 게스트 clip promotion 상태가 photo promotion과 다름

photo promotion은 guest row에 `deleted_at`을 찍지만, clip promotion은 temp R2 객체를 삭제한 뒤 guest row를 계속 노출 가능한 상태로 남긴다.

영향:
- 같은 guest session으로 clip preview를 다시 요청하면 이미 삭제된 temp object에 대한 signed URL이 발급될 수 있다.
- promoted guest clip row가 cleanup 대상도 아니고 active preview 대상도 되는 애매한 상태가 된다.

결정:
- photo/clip 모두 promotion 완료 후 guest row는 `upload_status='promoted'`, `deleted_at=now()`로 통일한다.
- guest preview는 `upload_status='uploaded'`이고 `deleted_at is null`인 row만 허용한다.
- 만료된 guest media는 promotion하지 않는다.

### P1. confirm 전 미디어도 preview/update 대상이 될 수 있음

현재 조회 helper가 `uploaded_at` 또는 `upload_status='uploaded'` 조건 없이 row를 반환한다.

영향:
- presign만 된 row도 preview URL을 받을 수 있다.
- confirm 실패 객체와 DB row가 오래 남을 수 있다.

수정 방향:
- helper를 목적별로 분리한다.
  - `get*ForConfirm`: presign row 허용
  - `get*ForPreview`: confirm/uploaded row만 허용
  - `get*ForDelete`: owner 검증 후 presign/confirmed 모두 허용
- preview 조건:
  - user media: `uploaded_at is not null`
  - guest media: `upload_status='uploaded'`, `deleted_at is null`, `expires_at > now()`
- 인증 사용자 stale upload cleanup job을 추가한다.

### P1. DB 작업이 원자적으로 묶여 있지 않음

confirm/promotion은 여러 DB 요청과 R2 작업이 순차 실행된다.

영향:
- media row는 uploaded인데 board cell에는 연결되지 않는 부분 성공 상태가 생길 수 있다.
- guest promotion 중간 실패 시 복사된 R2 객체, user media row, guest row 상태가 어긋날 수 있다.

수정 방향:
- DB 원자성이 필요한 부분은 Supabase RPC로 묶는다.
- R2 작업은 DB transaction 밖에서 수행하되, 순서와 상태 전이를 고정한다.
- guest promotion 순서:
  1. source object 존재/metadata 확인
  2. destination object copy
  3. destination metadata 확인
  4. DB RPC로 user media + board cell + guest row 상태 확정
  5. source temp object 삭제

### P1. `boards.updated_at`이 기록 변경을 반영하지 않음

목록과 active session은 `boards.updated_at` 기준인데, media confirm/description update는 board timestamp를 갱신하지 않는다.

수정 방향:
- media confirm, clip description update, board snapshot update 시 `boards.updated_at=now()` 갱신.
- 가능하면 confirm/promotion RPC 안에서 함께 갱신한다.

### P2. 공유 기록 read 경로가 불완전함

`shared_board_view`는 `clip_id`, `completion_type`, `mission_snapshot` 중심이고 photo id 또는 clip/poster storage 정보를 제공하지 않는다. API에도 share code로 signed URL을 조립하는 read endpoint가 없다.

결정:
- 공유 화면이 이번 범위에 포함되면 `GET /shares/:shareCode`를 추가한다.
- 포함되지 않으면 P2 후속 작업으로 명시하고 core media/history 작업과 분리한다.

권장:
- storage path는 public view에 직접 노출하지 않는다.
- service-role API가 board/cells/media를 조립하고 짧은 만료의 signed URL만 반환한다.

### P2. 모드별 위치 검증이 느슨함

현재 schema는 `mode='3x3'`에서도 position 0..24와 cellIds 9..25를 허용한다.

수정 방향:
- `mode='3x3'`: `cellIds.length === 9`, `position/freePosition < 9`
- `mode='5x5'`: `cellIds.length === 25`, `position/freePosition < 25`
- `markedPositions`, `clips`, `photos`의 position도 mode 범위 안으로 제한한다.

## 2. 목표 스키마 계약

운영 데이터 보존이 필요 없으므로 신규 데이터 기준으로 강하게 잡는다.

### `boards`

추가/정리:
- `board_kind text not null default 'mission'`
- `title text not null`
- `description text`

제약:
- `board_kind in ('mission', 'custom')`
- `char_length(title) between 1 and 24`
- `description is null or char_length(description) <= 120`
- `mode in ('5x5', '3x3')`
- `cell_ids`는 mode에 맞는 길이만 허용한다. DB check가 복잡하면 API에서 강제하고 테스트로 고정한다.

### `photos`

추가/정리:
- `storage_provider text not null default 'r2'`
- `bucket_name text not null`
- `object_etag text`

제약:
- `storage_provider = 'r2'`
- `uploaded_at is null or object_etag is not null`은 multipart/etag 정책이 확실해진 뒤 선택 적용한다.

### `clips`

추가/정리:
- `storage_provider text not null default 'r2'`
- `bucket_name text not null`
- `object_etag text`
- `poster_object_etag text`
- `description text`

제약:
- `storage_provider = 'r2'`
- `description is null or char_length(description) <= 160`
- `poster_storage_path`, `poster_content_type`, `poster_size_bytes`는 신규 clip row에서 not null로 강제한다.

### `guest_photo_uploads`

추가/정리:
- `storage_provider text not null default 'r2'`
- `bucket_name text not null`
- `object_etag text`

제약:
- `storage_provider = 'r2'`
- `upload_status in ('presigned', 'uploaded', 'promoted', 'expired', 'deleted')`

### `guest_clip_uploads`

추가/정리:
- `storage_provider text not null default 'r2'`
- `bucket_name text not null`
- `object_etag text`
- `poster_object_etag text`
- `board_kind text not null default 'mission'`
- `title text not null`
- `description text`
- `mission_snapshots jsonb not null`
- `clip_description text`

제약:
- `storage_provider = 'r2'`
- `board_kind in ('mission', 'custom')`
- `char_length(title) between 1 and 24`
- `description is null or char_length(description) <= 120`
- `clip_description is null or char_length(clip_description) <= 160`

### `board_cells`

정책:
- 한 셀의 대표 media는 하나만 허용한다.

제약:
- `photo_id is null or clip_id is null`
- `completion_type is null`이면 media id도 둘 다 null이어야 한다.
- `completion_type='photo'`이면 `photo_id is not null and clip_id is null`
- `completion_type='clip'`이면 `clip_id is not null and photo_id is null`
- `completion_type='no_media'`이면 media id 둘 다 null

## 3. 코드 수정 계획

### Phase 1. 스키마 기준 재정렬

작업:
- 개발 DB를 목표 스키마로 직접 정리한다.
- 새 migration 파일은 만들지 않는다.
- 필요하면 DB를 reset/recreate 한다.
- `supabase/SCHEMA_SNAPSHOT.md`와 baseline dump를 새 스키마 기준으로 갱신한다.
- R2-only 정책에 맞춰 Supabase Storage legacy bucket 경로는 제거 대상에 올린다.

완료 기준:
- live PostgREST OpenAPI에서 목표 컬럼이 모두 확인된다.
- API가 사용하는 select/insert/update 컬럼과 DB 컬럼이 1:1로 맞는다.

### Phase 2. MediaService R2-only/current-schema 단순화

수정 대상:
- `src/media/media.service.ts`
- `src/storage/r2.service.ts`는 필요한 경우만 최소 수정

작업:
- `isR2Object` 분기와 Supabase Storage copy/remove fallback을 제거한다.
- `PHOTO_BUCKET`, `CLIP_BUCKET` legacy storage 상수 사용 경로를 제거한다.
- preview/delete/copy는 R2만 사용한다.
- `getUserPhoto`, `getGuestPhoto`, `getUserClip`, `getGuestClip`을 목적별 helper로 분리한다.
- missing-column 에러를 404로 감추는 로직을 제거한다.

권장 helper:
- `getUserClipForConfirm`
- `getUserClipForPreview`
- `getUserClipForDelete`
- `getGuestClipForConfirm`
- `getGuestClipForPreview`
- `getGuestClipForDelete`
- photo도 동일 패턴 적용

### Phase 3. BoardsService 스냅샷 정책 분리

수정 대상:
- `src/boards/boards.service.ts`
- `src/boards/boards.schemas.ts`
- `src/media/media.schemas.ts`

작업:
- `ensureUserBoardFromSession`은 완전한 board snapshot 저장/갱신 전용으로 둔다.
- media presign은 `ensureUserBoardForMedia`를 사용해 board 존재와 cell 일치만 검증한다.
- mode별 position/cellIds/markedPositions/media position 검증을 zod refine 또는 service-level validation으로 추가한다.
- 신규 저장 경로에서 `missionSnapshotFor(cellId)` fallback을 사용하지 않는다.
- board metadata와 mission snapshot은 완전한 snapshot 입력에서만 갱신한다.

### Phase 4. Confirm/Promotion RPC 설계

DB RPC 또는 service-level transaction 대체 수단을 정한다. Supabase JS에서 일반 transaction을 직접 열기 어렵기 때문에 RPC가 권장이다.

필요 RPC:
- `confirm_user_photo_upload`
- `confirm_user_clip_upload`
- `promote_guest_photo_upload`
- `promote_guest_clip_upload`

각 RPC 책임:
- media row 상태 확정
- `board_cells` upsert
- 반대 타입 media 연결 null 처리
- `boards.updated_at` 갱신
- guest row `upload_status`, `promoted_*`, `deleted_at` 갱신

R2 책임은 RPC 밖에서 수행:
- confirm: object metadata 검증 후 RPC 호출
- promotion: copy/verify 후 RPC 호출, RPC 성공 후 temp object delete

### Phase 5. 상태 전이 정리

User media:
- presign: row 생성, `uploaded_at=null`
- confirm 성공: `uploaded_at`, etag 저장, board cell 연결
- confirm 실패: row는 미완료 상태로 남고 cleanup 대상
- preview: `uploaded_at is not null`만 허용
- delete: R2 삭제 후 row soft-delete

Guest media:
- presign: `upload_status='presigned'`
- confirm 성공: `upload_status='uploaded'`
- promotion 성공: `upload_status='promoted'`, `deleted_at=now()`
- expire/cleanup: `upload_status='expired'`, `deleted_at=now()`
- preview: `upload_status='uploaded'`, `deleted_at is null`, `expires_at > now()`만 허용

### Phase 6. Cleanup job 추가

수정 대상:
- `src/jobs/jobs.controller.ts`
- `src/media/media.service.ts`

작업:
- `cleanupStaleUserPhotos`
- `cleanupStaleUserClips`
- 통합 endpoint `POST /jobs/cleanup-stale-user-media`
- compatibility endpoint는 앱/cron에서 필요할 때만 추가한다.

대상:
- `uploaded_at is null`
- `deleted_at is null`
- `created_at < now() - SIGNED_UPLOAD_EXPIRES_SECONDS`

동작:
- DB row를 먼저 `deleted_at=now()`로 claim한다.
- claim된 row의 R2 object를 삭제한다.
- R2 삭제 실패 시 claim을 되돌려 다음 cleanup에서 재시도할 수 있게 한다.
- guest 만료 cleanup도 동일하게 먼저 `expired`로 claim하고, 실패 시 직전 `upload_status`와 `deleted_at=null`로 복구한다.

### Phase 7. 공유 기록 API 여부 결정

이번 핵심 범위:
- 개인 이전 기록 `/boards`, `/boards/current`, `/boards/:boardId`

공유 기록까지 포함할 경우:
- `GET /shares/:shareCode` 추가
- service-role로 `shares -> boards -> board_cells -> photos/clips` 조립
- R2 signed preview URL 발급
- public view에 storage path를 직접 노출하지 않는다.

공유 기록이 이번 범위가 아니면:
- 기획서상 P2 후속 작업으로 유지하고 core media/history 안정화 뒤 진행한다.

### Phase 8. 테스트 보강

필수 unit test:
- schema validation
  - 3x3 position 9 이상 거부
  - 5x5 cellIds 25개 요구
  - missionSnapshots/cellIds 불일치 거부
- media confirm
  - confirm 전 preview 거부
  - confirm 성공 시 board cell 연결 및 `boards.updated_at` 갱신
  - clip confirm 시 `photo_id=null`
  - photo confirm 시 `clip_id=null`
- guest promotion
  - 만료된 guest media promotion 거부
  - promotion 후 guest preview 거부
  - user board detail/current에서 promoted clip 복구
- board snapshot
  - media presign이 기존 v4 board metadata를 덮어쓰지 않음
- cleanup
  - stale user media soft-delete
  - cleanup 재실행 idempotent

권장 integration/smoke:
- 인증 사용자 clip presign -> R2 upload -> confirm -> preview -> `/boards/current`
- guest clip presign -> confirm -> login promote -> `/boards/:boardId`
- 같은 셀에 photo 후 clip 저장 시 clip만 대표 media로 남음

## 4. 실행 순서

1. 목표 스키마를 개발 DB에 직접 반영한다.
2. `supabase/SCHEMA_SNAPSHOT.md`와 baseline dump를 새 기준으로 갱신한다.
3. `MediaService`를 R2-only/current-schema 기준으로 단순화한다.
4. `BoardsService`의 snapshot 갱신 경로와 media 검증 경로를 분리한다.
5. confirm/promotion RPC 또는 동등한 원자적 DB 확정 경로를 구현한다.
6. preview confirmed-only 정책과 cleanup job을 추가한다.
7. mode별 zod/service validation을 추가한다.
8. 테스트를 추가하고 `pnpm build`, `pnpm test`를 통과시킨다.
9. 실제 R2/Supabase dev 환경에서 smoke test를 수행한다.

## 5. 우선순위

1. P0 clean schema 정렬
2. P0 API 컬럼 계약과 DB 컬럼 계약 일치
3. P1 preview/confirm/delete helper 분리
4. P1 board snapshot 덮어쓰기 방지
5. P1 mission snapshot/mode validation 강화
6. P1 guest promotion 상태 정책 통일
7. P1 대표 media 단일화
8. P1 confirm/promotion 원자성 보강
9. P1 stale user media cleanup
10. P1 `boards.updated_at` 갱신
11. P2 공유 기록 read endpoint 여부 결정

## 6. 명시적 비목표

이번 작업에서 하지 않는다:
- 운영 DB 무중단 migration
- 기존 row backfill
- Supabase Storage legacy object 복구
- `storage_provider='supabase'` 호환
- missing-column fallback 유지
- 과거 v2/v3 데이터 복구 보장

유지할 수 있는 것:
- `/api/...` compatibility controller는 데이터 레거시가 아니라 URL 호환성 문제이므로, 앱이 사용 중이면 유지한다.

## 7. 완료 기준

- live/dev DB에 API가 사용하는 컬럼이 모두 존재한다.
- 코드에 DB 스키마 불일치 대응용 missing-column fallback이 남아 있지 않다.
- 인증 사용자 영상 presign -> R2 upload -> confirm -> preview -> `/boards/current` 복구가 성공한다.
- 게스트 영상 presign -> confirm -> 로그인 후 promote -> `/boards/:boardId` 상세 복구가 성공한다.
- promotion 후 guest temp object가 삭제되어도 guest preview endpoint가 깨진 URL을 반환하지 않는다.
- confirm 전 또는 검증 실패 media는 preview되지 않으며 cleanup 대상이 된다.
- 미션 문구/캡처 라벨/카테고리/아이콘이 이전 기록에서 원본과 동일하게 복구된다.
- 같은 셀에 중복 미디어를 저장해도 정책에 맞는 단일 완료 상태가 유지된다.
- 최근 미디어 저장/설명 변경이 `/boards`와 `/boards/current` 정렬에 반영된다.
- `pnpm build`, `pnpm test`, 핵심 smoke test가 통과한다.
