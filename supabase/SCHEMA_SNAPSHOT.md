# Supabase 스키마 스냅샷 (Phase 0 진단 결과)

```
조사일:   2026-05-31 KST (0001 기준) / 0006 추가: 2026-06-05 / 0013 추가: 2026-06-08
방법:     PostgREST OpenAPI + 직접 SQL 진단(psql, ap-south-1 풀러)
프로젝트:  wtptvgxyqkqqsfkdsoox (리전: ap-south-1)
정식 덤프: supabase/migrations/0001_remote_baseline.sql (초기화 기준 schema-only baseline, 1150줄)
진단 도구: scripts/introspect-schema.mjs(REST), scripts/introspect.sql(psql)
최신 운영 적용 migration: 0013_client_capability_gate.sql
대기 중 migration: 0014_bingo_mission_expansion.sql (assets.sappeun.app custom domain gate 이후 적용)
```

> **Phase 0 완료.** 컬럼·타입·RLS·FK·CHECK·트리거까지 전부 실측 확정.
> 현재 서비스는 운영 중이 아니므로 별도 운영 마이그레이션, backfill, 레거시 데이터 호환 fallback은 만들지 않는다.
> DB는 `0001_remote_baseline.sql` 기준으로 초기화해 최신 API 스키마와 맞춘다.
>
> **0006 추가 (2026-06-05).** `boards.customization_status`, `board_cells` original columns,
> `mission_badges` / `board_badges` / `user_badges` tables, `award_board_badges` RPC,
> 47-mission catalog seed (sheet.json v1.3.0, catalog_version='api-migration-v1').
> 신규 badge tables는 v1에서 backend API 전용으로 닫는다. `service_role`에만 table read/write를
> 명시 grant하고 `anon`/`authenticated`/`public` table privilege는 revoke한다.
>
> **0007 추가 (2026-06-05).** `0006` 적용 후 Supabase performance advisor가 신규 badge table
> FK 미인덱스 INFO를 보고해 보정 인덱스를 추가한다.
>
> **0008 추가 (2026-06-05).** `award_board_badges`의 PL/pgSQL 출력 컬럼 `badge_id`와
> `on conflict` 컬럼 참조 ambiguity를 피하도록 primary-key constraint target을 명시한다.
>
> **0009 추가 (2026-06-07).** `0006` catalog seed가 difficulty 편집 이전 sheet.json을
> 기준으로 해 11개 미션이 'easy'로 남아 있던 것을 현행 sheet.json(v1.3.0, difficulty 갱신)에
> 맞춰 `mission_badges`를 in-place UPDATE한다. medium 8개(n06/m03/m04/m09/a06/t05/c07/c08),
> hard 3개(n08/a04/t06). catalog_version은 `api-migration-v1` 유지 → 기존 user_badges는
> join으로 자동 보정. 운영 미가동(line 13) 상태라 backfill/재발급 불필요.
>
> **0010/0011 추가 (2026-06-08).** `mission_content`, `mission_categories`를 DB-as-source
> 미션 콘텐츠 테이블로 추가하고 `mission_badges(catalog_version, mission_id)`가
> `mission_content`를 FK로 참조하게 한다.
>
> **0012 추가 (2026-06-08).** `mission_content.artwork`, `mission_badges.artwork` JSONB 컬럼을
> 추가한다. 기존 48개 `mission_content` 행은 legacy `icon`/`swatch`/`text_only` 기준으로
> ArtworkSpec v1을 백필한다. `mission_badges.artwork`는 배지 전용 override가 있을 때만 채우며,
> API는 `mission_badges.artwork ?? mission_content.artwork` 순서로 반환한다.
>
> **0013 추가 (2026-06-08).** `mission_content`, `mission_badges`에 capability gate 컬럼
> (`min_app_build`, `required_capabilities`, `active_from`, `active_until`)을 추가한다. API는
> `X-Sappeun-App-Build`, `X-Sappeun-Client-Capabilities` 헤더를 파싱해 legacy client에는
> gated row를 숨긴다.
>
> **0014 준비 완료 / 운영 적용 대기 (2026-06-08).** frontend plan
> `plans/bingo-mission-expansion-candidates.md` 기준 신규 미션 102개를 별도 seed로 추가한다.
> 모든 신규 `mission_content`/`mission_badges` row는 `runtime-artwork-v1` capability로 gate하고,
> color 확장 row는 `swatch-hex-v1`도 요구한다. Pencil `design_v2.pen` export 이미지는
> `artifacts/mission-artwork/v1.4-pencil-export/manifest.json`의 해시 기반 `remoteImage` URL과
> fallback ArtworkSpec으로 연결된다. `assets.sappeun.app` custom domain 공개 접근 검증 전까지
> 운영 DB에는 적용하지 않는다.

---

## public 스키마 객체

테이블: `board_cells, boards, clips, guest_clip_uploads, guest_photo_uploads,
photos, profiles, shares, user_consents, mission_content, mission_categories,
mission_badges, board_badges, user_badges` *(0006 추가)*
뷰: `shared_board_view`
함수: `require_current_consents_for_signup()`, `set_updated_at()`,
`confirm_user_photo_upload()`, `confirm_user_clip_upload()`,
`award_board_badges(uuid, uuid, text[])` *(0006 추가, security definer, service_role 전용)*

## media / mission board 기준 스키마 (현행 목표)

### 전제
- 저장소는 R2 전용이다. `storage_provider`는 모든 신규 media 행에서 `r2`만 허용한다.
- Supabase Storage legacy bucket(`photos-private`, `clips-private`) 경로와 missing-column fallback은 사용하지 않는다.
- 운영 중 서비스가 아니므로 과거 데이터 승격, 복구, 마이그레이션 대응은 하지 않는다.

### boards

| 컬럼 | 타입 | NULL | 기본값 |
|---|---|---|---|
| board_kind | text | NO | `mission` (CHECK ∈ {mission, custom}) |
| title | text | YES | — (CHECK char_length ≤ 24 via `boards_title_length_check`) |
| description | text | YES | — |
| deleted_at | timestamptz | YES | — |
| customization_status | text | NO | `official` (CHECK ∈ {official, edited}, `boards_customization_status_check`) *(0006)* |

- `edited_cell_count`는 저장하지 않는다. read-time 파생값: `count(board_cells where original_mission_snapshot IS NOT NULL)`.
- 기존 `board_kind='custom'` 행은 backfill로 `customization_status='edited'` 처리됨.

### board_cells

| 컬럼 | 타입 | NULL | 비고 |
|---|---|---|---|
| clip_id | uuid | YES | FK→clips, ON DELETE SET NULL |
| completed_at | timestamptz | YES | 완료 시각 |
| completion_type | text | YES | CHECK ∈ {photo, no_photo, clip, no_media, free} |
| mission_snapshot | jsonb | YES | 셀별 미션 스냅샷 |
| original_cell_id | text | YES | 편집 전 원본 cell_id *(0006)* |
| original_mission_snapshot | jsonb | YES | 편집 전 원본 스냅샷 (IS NOT NULL이면 편집된 셀) *(0006)* |
| edited_at | timestamptz | YES | 최초 편집 시각 *(0006)* |

- `photo_id`와 `clip_id`는 동시에 채울 수 없다(`board_cells_single_media_check`).

### mission_badges *(0006)*

| 컬럼 | 타입 | NULL | 비고 |
|---|---|---|---|
| id | text | NO | PK. 형식: `mission:<mission_id>:v1` |
| mission_id | text | NO | sheet.json cell id (n01, m01, sf01 등) |
| catalog_version | text | NO | 현재: `api-migration-v1` |
| title | text | NO | CHECK char_length ≤ 40 |
| category | text | YES | nature/manmade/animal/time/self/color |
| difficulty | text | NO | CHECK ∈ {easy, medium, hard} |
| grade_label | text | NO | easy→'일상 배지', medium→'도전 배지' |
| grade_color | text | NO | easy→'#6ED6A0', medium→'#F5A623' |
| artwork_key | text | YES | 예: `mission/n01` |
| artwork | jsonb | YES | ArtworkSpec v1 override. NULL이면 `mission_content.artwork` fallback *(0012)* |
| min_app_build | integer | YES | row 노출 최소 `X-Sappeun-App-Build` *(0013)* |
| required_capabilities | text[] | NO | default `{}`. row 노출에 필요한 client capabilities *(0013)* |
| active_from | timestamptz | YES | 예약 공개 시작 시각 *(0013)* |
| active_until | timestamptz | YES | 예약 공개 종료 시각(exclusive) *(0013)* |
| sort_order | integer | NO | 0 default, 10 단위 증가 |
| active | boolean | NO | true default |
| created_at | timestamptz | NO | now() |

- UNIQUE `(catalog_version, mission_id)`.
- `artwork`는 배지 전용 override만 저장한다. 일반 배지는 `mission_content.artwork`를 사용한다.
- Table privileges: `service_role` read/write only. `public`/`anon`/`authenticated` revoked.
- RLS enabled. `mission_badges_select_active`: `active = true` 인 행만 authenticated 조회
  (향후 table SELECT grant를 열 때 적용; backend API는 service_role으로 RLS 우회).
- 47개 시드 (`api-migration-v1`, sheet.json v1.3.0). 제외: `id='free'` (category='special', 중앙 free 슬롯).

### mission_content / mission_categories *(0010, 0012, 0013; 0014 pending)*

| 컬럼 | 타입 | NULL | 비고 |
|---|---|---|---|
| mission_id | text | NO | sheet.json cell id. PK part |
| catalog_version | text | NO | 현재: `api-migration-v1`. PK part |
| label/category/hint/caption/capture_label | text | mixed | mission copy/cue content |
| icon | text | YES | legacy lucide cue key |
| variant | text | NO | CHECK ∈ {QeQCU, k4Srv, rAdyJ} |
| difficulty | text | YES | CHECK ∈ {easy, medium, hard} |
| camera/text_only/font_size/swatch/swatch_label/no_photo/fixed_position | mixed | YES | legacy renderer fields |
| artwork | jsonb | YES | ArtworkSpec v1. 기존 48개 active row는 0012에서 백필됨 |
| min_app_build | integer | YES | row 노출 최소 `X-Sappeun-App-Build` |
| required_capabilities | text[] | NO | default `{}`. 예: `runtime-artwork-v1`, `swatch-hex-v1` |
| active_from | timestamptz | YES | 예약 공개 시작 시각 |
| active_until | timestamptz | YES | 예약 공개 종료 시각(exclusive) |
| sort_order | integer | NO | source order * 10 |
| active | boolean | NO | true default |

- `mission_content.artwork`가 미션 기본 시각 core의 정본이다.
- 0014 pending 신규 102개 row는 `remoteImage` artwork와 fallback을 함께 가진다. 실제 public R2
  업로드 대상은 `artifacts/mission-artwork/v1.4-pencil-export/manifest.json`의 `objectKey`.
- active row는 API service-role query 후 client capability/window 필터를 거쳐 반환된다.
- Verification query: `select count(*) from public.mission_content where active = true and artwork is null;`
  expected `0` after 0012 backfill.

### board_badges *(0006)*

| 컬럼 | 타입 | NULL | 비고 |
|---|---|---|---|
| board_id | uuid | NO | FK→boards ON DELETE CASCADE |
| badge_id | text | NO | FK→mission_badges ON DELETE RESTRICT |
| user_id | uuid | NO | FK→auth.users ON DELETE CASCADE |
| earned_at | timestamptz | NO | now() default |

- PK `(board_id, badge_id)`.
- INDEX `board_badges_user_board_idx (user_id, board_id)`.
- INDEX `board_badges_badge_idx (badge_id)` *(0007)*.
- Table privileges: `service_role` read/write only. `public`/`anon`/`authenticated` revoked.
- RLS enabled. `board_badges_select_own`: `(select auth.uid()) = user_id`
  (향후 table SELECT grant를 열 때 적용; backend API는 service_role으로 RLS 우회).
- soft-delete 전용 repo이므로 ON DELETE CASCADE는 안전망 전용 (CORR-9).

### user_badges *(0006)*

| 컬럼 | 타입 | NULL | 비고 |
|---|---|---|---|
| user_id | uuid | NO | FK→auth.users ON DELETE CASCADE |
| badge_id | text | NO | FK→mission_badges ON DELETE RESTRICT |
| first_board_id | uuid | YES | FK→boards ON DELETE SET NULL |
| last_board_id | uuid | YES | FK→boards ON DELETE SET NULL |
| first_earned_at | timestamptz | NO | now() default |
| last_earned_at | timestamptz | NO | now() default |
| earned_count | integer | NO | 1 default, CHECK ≥ 1 |

- PK `(user_id, badge_id)`.
- INDEX `user_badges_badge_idx (badge_id)` *(0007)*.
- INDEX `user_badges_first_board_idx (first_board_id)` *(0007)*.
- INDEX `user_badges_last_board_idx (last_board_id)` *(0007)*.
- Table privileges: `service_role` read/write only. `public`/`anon`/`authenticated` revoked.
- RLS enabled. `user_badges_select_own`: `(select auth.uid()) = user_id`
  (향후 table SELECT grant를 열 때 적용; backend API는 service_role으로 RLS 우회).
- board soft-delete는 earned_count를 감소시키지 않는다 (badge = 영구 achievement, CORR-9).

### RPC award_board_badges *(0006)*

```sql
public.award_board_badges(p_user_id uuid, p_board_id uuid, p_badge_ids text[])
returns table (badge_id text, is_first_earn boolean)
```

- `security definer set search_path to 'public'`.
- service_role 전용(`auth.role() <> 'service_role'` → raise 42501).
- 원자적 CTE: `board_badges` insert (on-conflict-do-nothing) → `user_badges` upsert (earned_count +1).
- `on conflict`는 `board_badges_pkey`, `user_badges_pkey` constraint target을 명시한다(0008).
- 동일 board 재호출은 board_badges에서 conflict → user_badges rollup 미발생 → earned_count 불변 (idempotent self-heal).
- `revoke all from public/anon/authenticated; grant execute to service_role`.

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
