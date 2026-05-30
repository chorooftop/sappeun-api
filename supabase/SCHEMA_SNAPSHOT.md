# Supabase 스키마 스냅샷 (Phase 0 진단 결과)

```
조사일:   2026-05-31 KST
방법:     PostgREST OpenAPI + 직접 SQL 진단(psql, ap-south-1 풀러)
프로젝트:  wtptvgxyqkqqsfkdsoox (리전: ap-south-1)
정식 덤프: supabase/migrations/0001_remote_baseline.sql (초기화 기준 schema-only baseline, 1150줄)
진단 도구: scripts/introspect-schema.mjs(REST), scripts/introspect.sql(psql)
```

> **Phase 0 완료.** 컬럼·타입·RLS·FK·CHECK·트리거까지 전부 실측 확정.
> 현재 서비스는 운영 중이 아니므로 별도 운영 마이그레이션, backfill, 레거시 데이터 호환 fallback은 만들지 않는다.
> DB는 `0001_remote_baseline.sql` 기준으로 초기화해 최신 API 스키마와 맞춘다.

---

## public 스키마 객체

테이블: `board_cells, boards, clips, guest_clip_uploads, guest_photo_uploads,
photos, profiles, shares, user_consents`
뷰: `shared_board_view`
함수: `require_current_consents_for_signup()`, `set_updated_at()`,
`confirm_user_photo_upload()`, `confirm_user_clip_upload()`

## media / mission board 기준 스키마 (현행 목표)

### 전제
- 저장소는 R2 전용이다. `storage_provider`는 모든 신규 media 행에서 `r2`만 허용한다.
- Supabase Storage legacy bucket(`photos-private`, `clips-private`) 경로와 missing-column fallback은 사용하지 않는다.
- 운영 중 서비스가 아니므로 과거 데이터 승격, 복구, 마이그레이션 대응은 하지 않는다.

### boards

| 컬럼 | 타입 | NULL | 기본값 |
|---|---|---|---|
| board_kind | text | NO | `mission` (CHECK ∈ {mission, custom}) |
| title | text | YES | — |
| description | text | YES | — |
| deleted_at | timestamptz | YES | — |

### board_cells

| 컬럼 | 타입 | NULL | 비고 |
|---|---|---|---|
| clip_id | uuid | YES | FK→clips, ON DELETE SET NULL |
| completed_at | timestamptz | YES | 완료 시각 |
| completion_type | text | YES | CHECK ∈ {photo, no_photo, clip, no_media, free} |
| mission_snapshot | jsonb | YES | 셀별 미션 스냅샷 |

- `photo_id`와 `clip_id`는 동시에 채울 수 없다(`board_cells_single_media_check`).

### photos / clips

| 테이블 | 필수 저장소 컬럼 |
|---|---|
| photos | `storage_provider`, `bucket_name`, `object_etag` |
| clips | `storage_provider`, `bucket_name`, `object_etag`, `poster_object_etag`, `description` |

### guest uploads

| 테이블 | 필수 저장소/보드 컬럼 |
|---|---|
| guest_photo_uploads | `storage_provider`, `bucket_name`, `object_etag` |
| guest_clip_uploads | `storage_provider`, `bucket_name`, `object_etag`, `poster_object_etag`, `board_kind`, `title`, `description`, `mission_snapshots`, `clip_description` |

- 게스트 영상 승격 후 원본 guest 행은 `upload_status='promoted'`, `promoted_*`, `promoted_at`, `deleted_at`을 함께 기록한다.
- preview 대상은 업로드 완료 상태이고 삭제·만료되지 않은 행만 허용한다.
- 사용자 photo/clip confirm은 DB 함수(`confirm_user_photo_upload`, `confirm_user_clip_upload`)로 media row, `board_cells`, `boards.updated_at`을 같은 DB 트랜잭션에서 확정한다.
- confirm DB 함수는 service-role 전용이다. `auth.role()='service_role'`을 검증하고 `PUBLIC` 실행 권한을 제거한다.
- guest photo promotion은 기존 보드가 있으면 메타데이터/미션 스냅샷을 덮어쓰지 않고 cell 검증 후 연결만 수행한다.
- stale authenticated upload cleanup은 DB에서 cleanup 대상을 먼저 claim한 뒤 R2 객체를 삭제하고, R2 실패 시 retry 가능하도록 claim을 되돌린다.
- expired guest upload cleanup도 DB에서 먼저 `expired`로 claim한 뒤 R2 객체를 삭제하고, R2 실패 시 직전 상태로 되돌린다.
- mission board 복구는 완전한 `mission_snapshot`을 요구한다. 누락된 셀/스냅샷을 placeholder로 합성하지 않는다.

## profiles (실측)

| 컬럼 | 타입 | NULL | 기본값 |
|---|---|---|---|
| user_id | uuid | NO | — (PK, FK→auth.users **ON DELETE CASCADE**) |
| display_name | text | YES | — (CHECK ≤40) |
| avatar_url | text | YES | — |
| primary_provider | text | YES | — (CHECK ≤64) |
| first_login_at | timestamptz | NO | now() |
| last_seen_at | timestamptz | YES | — |
| first_play_tutorial_completed_at | timestamptz | YES | — |
| created_at | timestamptz | NO | now() |
| updated_at | timestamptz | NO | now() (트리거 자동갱신) |
| signup_completed_at | timestamptz | YES | — (설정 시 동의 트리거 검증) |
| onboarding_completed_at | timestamptz | YES | — |
| signup_source | text | YES | — (CHECK ∈ {signup, login_recovery}) |
| nickname | text | YES | — (**CHECK ≤10 이미 존재**) |
| nickname_updated_at | timestamptz | YES | — |

- **추가 필요(0002)**: `birth_date`, `deleted_at`, `deletion_reason`, `purge_scheduled_at`.
- 닉네임 길이 CHECK는 **이미 존재**(`profiles_nickname_check`) → 기획서의 신규 CHECK 불필요.
- `updated_at`은 트리거 `profiles_set_updated_at`이 자동 갱신.

### ⚠️ 트리거: `profiles_require_signup_consents`
`signup_completed_at`을 NULL→값으로 UPDATE할 때, 아래 동의 행이 **반드시 선행 존재**해야 함
(없으면 예외 발생):
- `user_consents(consent_type='terms',   version='terms-2026-05-16')`
- `user_consents(consent_type='privacy', version='privacy-2026-05-16')`

→ **O-2 해소**: 현재 필수 동의 버전 = `terms-2026-05-16`, `privacy-2026-05-16`.
→ `/signup` API는 **동의 행 insert → 그 다음 `signup_completed_at` 갱신** 순서를 지켜야 한다.
→ (개선 여지) 버전이 트리거에 하드코딩 → 향후 config 테이블/파라미터화 검토.

## user_consents (실측)

| 컬럼 | 타입 | NULL | 기본값 |
|---|---|---|---|
| id | uuid | NO | uuid_generate_v4() (PK) |
| user_id | uuid | NO | FK→auth.users **ON DELETE CASCADE** |
| consent_type | text | NO | **CHECK ∈ {terms, privacy}** |
| version | text | NO | CHECK ≤40 |
| accepted_at | timestamptz | NO | now() |
| source | text | NO | CHECK ∈ {signup, login_recovery} |
| created_at | timestamptz | NO | now() |

- 유니크: `(user_id, consent_type, version)`.
- **`granted` 없음(accept-only)**. 마케팅 동의/철회는 신규 설계 필요.
- ⚠️ **마케팅(DEC-4) 추가 시**: `consent_type` CHECK에 `'marketing'`을, 필요 시 `source` CHECK도 확장해야 함.

## account_deletions / user_identities_v
- 둘 다 **없음** → 생성 필요 (0004 / Phase 5).

## RLS 정책 (실측 — 전 테이블 RLS 활성화, FORCE 아님)

| 테이블 | 정책 | 동작 |
|---|---|---|
| profiles | `profiles_select_own` / `_insert_own` / `_update_own` | 본인 행 SELECT/INSERT/UPDATE (DELETE 정책 없음) |
| user_consents | `user_consents_select_own` / `_insert_own` | 본인 행 SELECT/INSERT (UPDATE/DELETE 정책 없음) |
| boards/clips/photos | select/insert/update/(delete) own | 본인 행 |
| shares | `shares_insert_own`/`_delete_own`/`shares_public_select` | 공개 조회 허용 |

→ **현재 클라이언트(authenticated)가 본인 profiles/consents를 직접 INSERT/UPDATE 가능** =
  모바일 직접쓰기가 성립하는 이유. **Phase 4**는 `profiles_insert_own`·`profiles_update_own`·
  `user_consents_insert_own` 정책을 제거(또는 service-role 전용화)해 API로만 쓰도록 잠근다.
  (service_role은 RLS를 우회하므로 API는 영향 없음.)

## 계정 삭제 시 cascade 영향 (실측 FK)

- `auth.users` 삭제 → **profiles, user_consents 자동 CASCADE 삭제**.
- **`boards`는 auth.users FK 없음** → 삭제가 cascade되지 않음. boards는 `user_id`로 수동 삭제 필요.
  - boards 삭제 시 cascade: `board_cells`, `clips`, `photos`, `shares` (모두 `board_id` CASCADE).
  - `board_cells.photo_id/clip_id`는 SET NULL.
- `guest_*_uploads.promoted_*_id`는 photos/clips SET NULL. 게스트 행 자체는 `promoted_user_id`로 수동 정리.
- **R2 객체는 FK 무관 → API/cron이 명시적으로 삭제**.

→ 삭제 순서(파기 cron): boards 조회 → R2 객체 삭제 → boards 삭제(cascade로 cells/clips/photos/shares)
   → guest_* 정리 → `auth.admin.deleteUser`(profiles/consents 자동 cascade).

---

## Phase 0 잔여 → 모두 해소됨
- [x] 정식 baseline 덤프(`0001_remote_baseline.sql`).
- [x] RLS / FK on-delete / 기본값 / CHECK / 트리거 확정.
- [x] 동의 필수 버전 확인(O-2).
