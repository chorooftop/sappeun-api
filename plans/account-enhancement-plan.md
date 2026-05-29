# 계정(회원가입·로그인) 고도화 기획서

```
Status:        reviewed (정책 결정 반영 완료, 구현 착수 가능)
Created:       2026-05-29 KST
Revised:       2026-05-29 KST (v2 — 정책 결정 반영 + 기술 심화)
Target API:    /Users/oksang/Desktop/sappeun/sappeun-api
Auth provider: Supabase Auth (Kakao / Apple / Google 소셜 로그인, signInWithIdToken)
선행 계획서:    plans/social-login-integration-plan.md (git 677f1eb, 소셜 로그인 연결)
```

> 본 기획서는 코드(`src/**`) 정적 분석 기반으로 작성되었으며, 실제 Supabase DB 스키마는
> 콘솔에서 직접 확인 후 "Phase 0"에서 확정한다. 코드 곳곳의 `isMissingColumnError`
> 폴백(`src/users/users.service.ts`, `src/supabase/supabase.errors.ts`)은 일부 환경에서
> 컬럼이 누락돼 있을 수 있음을 시사하므로, 스키마 확정이 본 작업의 첫 전제 조건이다.

---

## 0. 결정 로그 (2026-05-29 확정)

| # | 결정 사항 | 선택 | 영향 |
|---|---|---|---|
| DEC-1 | 계정 삭제 방식 | **유예 후 파기**: soft delete(`deleted_at`) → N일 유예 → cron hard delete | Phase 2, `account_deletions`, jobs cron, 유예 중 복구 흐름 |
| DEC-2 | 닉네임 유니크 | **미강제(중복 허용)** | 유니크 인덱스/중복검사 API 불필요. 길이·형식 검증만 유지 |
| DEC-3 | 마이그레이션 관리 | **Supabase CLI 도입** (`supabase/migrations/`) | Phase 0, `supabase db push` 워크플로 |
| DEC-4 | 동의·연령 | **필수(약관·개인정보)+선택(마케팅) & 만 14세 미만 가입 차단** | `user_consents` + 연령 게이트, `/signup` 검증 |

> **유예 기간(N) 기본값**: 30일로 가정하고 설계한다(법무 확정 시 조정). 유예 중 동일 소셜 계정으로
> 재로그인하면 **계정 복구(reactivation)** 한다 — 유예 기간에는 `auth.users`가 아직 살아 있으므로
> 같은 `user_id`로 복구 가능.

---

## 1. 목표

소셜 로그인 연결(완료)에 이어, **계정 생애주기(가입 → 로그인 → 온보딩 → 탈퇴/복구) 전체를
DB·API 레벨에서 일관되게 책임지는 구조**로 고도화한다.

- Supabase Auth는 신원(identity)의 단일 진실 원천으로 유지한다.
- `sappeun-api`는 프로필·동의·탈퇴 등 **권한 있는(privileged) 계정 작업의 경계**가 된다.
- 클라이언트(Flutter)가 `profiles`를 직접 쓰는 경로를 제거하고 API로 일원화한다.
- 약관/개인정보 동의 이력과 연령 확인을 법적으로 추적 가능한 형태로 보존한다.

## 2. 비목표 (이번 단계 제외)

- 이메일/비밀번호 로그인 도입 — 제외.
- 커스텀 OAuth 콜백 서버 구축 — 제외(Supabase가 OAuth 교환 담당).
- 멀티 프로바이더 수동 연결/해제 UI — **데이터 가시성(조회)만**, 연결/해제 UI는 후속.
- 14세 미만 법정대리인 동의 플로우 구현 — 이번 단계는 **가입 차단**까지만(동의 플로우는 후속).
- 관리자(admin) 콘솔/대시보드 — 제외.

---

## 3. 계정 생애주기 상태 머신 (신규 — 설계 기준)

가입 흐름이 끊겨 있던 핵심 원인은 상태 전이 책임이 불명확했기 때문이다. 아래 상태를
명시적 기준으로 삼는다. 상태는 `profiles`의 타임스탬프 컬럼 조합으로 표현된다.

```
[게스트]                       guestSessionId 헤더만 존재, profiles 행 없음
   │ 소셜 로그인 + auth-sync
   ▼
[가입대기]  PENDING_CONSENT     profiles 행 존재, signup_completed_at = NULL
   │ POST /users/me/signup  (필수 동의 + 연령 통과)
   ▼
[가입완료]  ONBOARDING_PENDING  signup_completed_at != NULL, onboarding_completed_at = NULL
   │ POST /users/me/onboarding/complete
   ▼
[활성]      ACTIVE              onboarding_completed_at != NULL, deleted_at = NULL
   │ DELETE /users/me
   ▼
[탈퇴유예]  PENDING_DELETION    deleted_at != NULL (auth.users 아직 존재)
   ├─ 유예 중 재로그인 → [활성] 복구 (deleted_at = NULL)
   └─ cron(유예 만료) → [파기] auth.users + 데이터 hard delete
```

- 각 API는 **자신의 전이만 책임**진다. `auth-sync`는 [게스트]→[가입대기] 보장과 `last_seen_at`
  갱신만, `/signup`은 [가입대기]→[가입완료] 확정만 담당한다(책임 분리 = A1 결함의 근본 해결).
- 모든 전이는 **멱등**해야 한다(중복 호출/재시도 안전).

---

## 4. 현재 상태 (As-Is)

### 4.1 인증 흐름
- `src/auth/auth.service.ts` — Bearer 토큰을 `supabase.anonClient.auth.getUser(token)`로 검증.
- `src/auth/supabase-auth.guard.ts` — `@UseGuards(SupabaseAuthGuard)`로 보호 라우트 구현.
- 게스트 세션 — `x-sappeun-guest-session-id`(UUID) 헤더, `normalizeGuestSessionId`로 검증.

### 4.2 프로필 / 계정 API (`src/users/`)
| 메서드 | 경로 | 설명 |
|---|---|---|
| GET | `/v1/users/me` | 사용자 + 프로필 조회 |
| PATCH | `/v1/users/me` | 닉네임 변경 |
| POST | `/v1/users/me/auth-sync` | 로그인 후 프로필 생성/갱신, `requiresSignupConsent` 반환 |
| GET | `/api/profile` | 호환 라우트 |
| PATCH | `/api/profile` | 호환 라우트(닉네임) |

### 4.3 `profiles` 테이블 (Phase 0 실측 — 2026-05-29)
```
user_id(PK), display_name, avatar_url, primary_provider,
first_login_at, last_seen_at, first_play_tutorial_completed_at,
created_at, updated_at, signup_completed_at, onboarding_completed_at,
signup_source, nickname, nickname_updated_at
```
- `nickname`/`nickname_updated_at`이 **실제로 존재** → 코드의 `isMissingColumnError` 폴백은 불필요(Phase 1에서 제거).
- `first_play_tutorial_completed_at`, `created_at`, `updated_at`, `signup_source`는 코드/기획서가 인지하지 못했던 기존 컬럼.

### 4.3b `user_consents` 테이블 (Phase 0 실측 — **이미 존재**)
```
id(PK), user_id, consent_type, version, accepted_at, source, created_at
```
- 실제 `consent_type` 값: `'terms'`, `'privacy'`. 유니크 제약 `(user_id, consent_type, version)`.
- `granted` boolean 없음(accept-only). 마케팅 동의/철회는 신규 설계 필요.
- **현재 모바일이 직접 upsert**(`completeSignupConsent`) — API 미경유.

### 4.4 게스트 → 회원 전환 (구현됨)
- `POST /v1/boards/adopt-guest-session` — 게스트 보드 세션 입양.
- `POST /v1/photos/promote-guest`, `POST /v1/clips/promote-guest` — 게스트 미디어 승격.
- 관련 테이블: `guest_photo_uploads`, `guest_clip_uploads`(`promoted_user_id`, `promoted_*_id`, `promoted_at`).

### 4.5 라우트 이중화 (`/v1/*` + `/api/*`)
컨트롤러가 `/v1/...`(신규)과 `/api/...`(호환) 두 벌을 모두 노출한다
(`users.controller.ts`의 `ProfileCompatibilityController`, boards/media/shares 동일 패턴).
→ **신규 엔드포인트의 호환 라우트 제공 여부를 정책으로 정해야 함**(§8.3).

### 4.6 참조 중인 DB 테이블
`profiles`, `boards`, `board_cells`, `photos`, `clips`, `shares`,
`guest_photo_uploads`, `guest_clip_uploads`

---

## 5. 공백 분석 (Gap Analysis) — v2

### 5.1 DB 측면

| # | 공백 | 영향 | 심각도 | 결정 반영 |
|---|---|---|---|---|
| D1 | 마이그레이션이 리포지토리에 없음(콘솔 수동 관리) | 드리프트·재현성·리뷰 불가 | 높음 | **DEC-3: CLI 도입** |
| D2 | ~~`profiles` 스키마 불확정~~ → Phase 0 실측: `nickname*` **존재 확인**. 폴백은 불필요 | 폴백 코드 제거로 단순화 | 해소 | Phase 1에서 폴백 제거 |
| D3 | 동의 이력 테이블은 **이미 존재**(`user_consents`). 단 **연령(birth_date)·마케팅 동의 미보존** | 14세 차단·마케팅 동의 불가 | 중간 | **DEC-4**, 기존 테이블 보정 |
| D4 | 계정 삭제 데이터 모델 부재 | 탈퇴/파기 의무 미충족 | 높음 | **DEC-1: 유예+파기** |
| D5 | 소셜 identity 가시성 부재 | 연결 계정 표시·확장 제약 | 중간 | 읽기 뷰만 |
| D6 | RLS·클라이언트 직접쓰기 미강화 | API 우회 위험 | 중간 | Phase 4 |
| D7 | ~~닉네임 유니크/정규화 부재~~ → **DEC-2로 유니크 미적용**. 길이/형식만 | 부적절 입력 | 낮음 | **DEC-2** |
| D8 | 로그인/디바이스 감사 테이블 부재 | 보안 추적 불가 | 낮음 | Phase 6(선택) |

### 5.2 API 측면

| # | 공백 | 영향 | 심각도 |
|---|---|---|---|
| A1 | **회원가입 완료가 클라이언트 직접쓰기로 처리됨** — `signup_completed_at`·`user_consents`를 모바일이 Supabase에 직접 write(API 미경유). 가입 완료 **API 엔드포인트는 부재** | API 경계 우회, 서버 규칙 강제 불가 | 높음 |
| A2 | **계정 삭제 엔드포인트 부재** | 탈퇴 불가, README 약속 미이행 | 높음 |
| A3 | 동의 수집/조회 엔드포인트 부재 | 동의 수집 불가 | 높음 |
| A4 | 온보딩 완료 엔드포인트 부재 | 상태 전이 불가 | 중간 |
| A5 | ~~닉네임 가용성 검사~~ → **DEC-2로 불필요**. 형식 검증만 클라이언트/서버 공유 | — | 낮음(제외) |
| A6 | 소셜 연결 조회 엔드포인트 부재 | 연결 계정 표시 불가 | 낮음 |
| A7 | 토큰 검증 캐시 없음(매 요청 `getUser`) | 지연·rate 부담 | 낮음 |
| A8 | 신규 흐름 테스트 미커버 | 회귀 위험 | 중간 |
| A9 | **(신규) `last_seen_at` 매 요청 쓰기** — auth-sync마다 UPDATE | 쓰기 부하 | 낮음 |
| A10 | **(신규) 삭제 등 파괴적 작업의 재인증/확인 부재** | 오삭제·탈취 시 위험 | 중간 |

---

## 6. 목표 데이터 모델 (To-Be)

> 모든 변경은 `supabase/migrations/`에 멱등 SQL로 커밋(DEC-3). `auth.users` 참조 컬럼은
> `on delete cascade` 정합성을 Phase 0에서 확인한다(특히 `profiles.user_id`).

### 6.1 마이그레이션 디렉터리 (DEC-3)
```
supabase/
  config.toml
  migrations/
    0001_baseline.sql                 # 콘솔 현행 스키마 스냅샷(profiles 등)
    0002_profiles_account_columns.sql # birth_date, deleted_at, 유예 컬럼, 폴백 컬럼 보정
    0003_user_consents.sql
    0004_account_deletions.sql
    0005_user_identities_view.sql
    0006_rls_policies.sql
```
워크플로: 로컬 작성 → `supabase db diff`/`db push`로 적용 → PR 리뷰 → 운영 반영.

### 6.2 `profiles` 보정 (D2, DEC-2, DEC-4, DEC-1)
> Phase 0 실측: `nickname`/`nickname_updated_at`은 **이미 존재** → 추가하지 않는다.
> 신규로 필요한 컬럼만 추가한다.
```sql
-- 0002
alter table public.profiles
  add column if not exists birth_date          date,        -- 연령 게이트(DEC-4)
  add column if not exists deleted_at           timestamptz, -- soft delete(DEC-1)
  add column if not exists deletion_reason      text,
  add column if not exists purge_scheduled_at   timestamptz; -- 유예 만료 = 파기 예정 시각
```
> 닉네임 길이 CHECK(`profiles_nickname_check`, ≤10)는 **이미 존재** → 추가하지 않는다(DEC-2: 유니크 미적용).
> 한국어 닉네임은 저장 전 **NFC 정규화 + trim**을 서버에서 적용(혼동 방지).

### 6.3 동의 이력 + 연령 (D3, DEC-4) — **기존 `user_consents` 재사용**
> Phase 0 실측: `user_consents`는 이미 존재하며 컬럼은
> `{id, user_id, consent_type, version, accepted_at, source, created_at}`,
> 유니크 `(user_id, consent_type, version)`. **새 테이블을 만들지 않고 이 스키마를 따른다.**
> 현재 값 컨벤션: `consent_type ∈ {'terms','privacy'}`, `source='signup'`.

마케팅 동의(DEC-4 선택 항목)는 현재 CHECK가 `{terms,privacy}`만 허용하므로 **제약 확장 + 철회 컬럼 추가**:
```sql
-- 0003 (기존 테이블 보정)
alter table public.user_consents
  add column if not exists revoked_at timestamptz;  -- 마케팅 철회 지원(필수 동의는 NULL 유지)

-- consent_type CHECK에 'marketing' 추가 (기존 제약 교체)
alter table public.user_consents drop constraint user_consents_consent_type_check;
alter table public.user_consents add constraint user_consents_consent_type_check
  check (consent_type = any (array['terms','privacy','marketing']));
```
- **동의 타입 컨벤션 고정**(`src/users/consents.constants.ts` 후보):
  필수 = `'terms'`, `'privacy'`; 선택 = `'marketing'`. (기존 값 유지)
- ⚠️ **현재 필수 버전(트리거 강제)**: `terms-2026-05-16`, `privacy-2026-05-16`. `/signup`은 이 버전으로
  동의 행을 먼저 insert한 뒤 `signup_completed_at`을 갱신해야 트리거를 통과한다(§7.2).
- 현재 상태 판정: `(user_id, consent_type)`의 최신 `version` 행에서 `revoked_at IS NULL`이면 동의 중.
- **연령 게이트**: `/signup`에서 `birth_date` 수신 → 만 14세 미만이면 가입 거부(`422`),
  `profiles.birth_date`에 저장(법정대리인 동의 플로우는 후속, 이번엔 차단).

### 6.4 계정 삭제 (D4, DEC-1)
```sql
-- 0004 : 통계/감사용. auth.users 파기 후에도 보존되어야 하므로 FK 없음(기록 전용).
create table if not exists public.account_deletions (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null,
  primary_provider text,
  reason           text,
  requested_at     timestamptz not null default now(),
  purge_scheduled_at timestamptz not null,
  hard_deleted_at  timestamptz,
  restored_at      timestamptz
);
create index if not exists account_deletions_purge_idx
  on public.account_deletions (purge_scheduled_at)
  where hard_deleted_at is null and restored_at is null;
```
**파기 순서 (Phase 0 FK 실측 반영)**:
1. 대상 `boards`(user_id) 조회 → 연관 R2 객체(photos/clips storage_path) 삭제.
2. `boards` 삭제 → `board_cells`/`photos`/`clips`/`shares`는 `board_id` **CASCADE 자동 삭제**.
3. `guest_*_uploads`(promoted_user_id 기준) 정리.
4. `auth.admin.deleteUser(userId)` → `profiles`·`user_consents`는 auth.users FK **CASCADE 자동 삭제**.

> 핵심: profiles/user_consents는 수동 삭제 불필요(cascade). 단 **boards는 auth.users FK가 없어**
> 자동 삭제되지 않으므로 반드시 user_id 기준 명시 삭제 + R2 정리가 선행돼야 한다.

### 6.5 소셜 연결 가시성 (D5)
```sql
-- 0005 : 중복 저장 없이 auth.identities 노출용 읽기 뷰
create or replace view public.user_identities_v as
select user_id, provider, identity_data->>'email' as email, created_at, last_sign_in_at
from auth.identities;
```

### 6.6 RLS (D6, Phase 4)
> Phase 0 실측: RLS는 이미 켜져 있고 본인 행 정책이 존재한다. 강화 = **쓰기 정책 제거**(읽기는 유지).
```sql
-- 0006 (요지) : 클라이언트 직접쓰기 차단 → service_role(API)만 쓰기
drop policy if exists profiles_insert_own on public.profiles;
drop policy if exists profiles_update_own on public.profiles;
drop policy if exists user_consents_insert_own on public.user_consents;
-- 읽기 정책(*_select_own)은 유지. 활성 사용자만 노출하려면 SELECT에 deleted_at IS NULL 조건 추가.
-- account_deletions : 신규 테이블, RLS 켜되 클라이언트 정책 미부여(service_role 전용).
```
- ⚠️ **반드시** 모바일의 직접쓰기(`ensureCurrentProfile`/`completeSignupConsent`)를 API로 이관·배포한
  **뒤에** 위 정책을 제거해야 한다(순서 어기면 로그인/가입 회귀). service_role은 RLS 우회이므로 API는 무영향.

---

## 7. 목표 API (To-Be)

### 7.1 신규/변경 엔드포인트

| 메서드 | 경로 | 목적 | 상태 전이 | 공백 |
|---|---|---|---|---|
| POST | `/v1/users/me/signup` | 동의 수집 + 연령 검증 + `signup_completed_at` 확정 | 가입대기→가입완료 | A1,A3,D3 |
| GET | `/v1/users/me/consents` | 동의 현황 조회 | — | A3 |
| POST | `/v1/users/me/onboarding/complete` | `onboarding_completed_at` 설정 | 가입완료→활성 | A4 |
| DELETE | `/v1/users/me` | soft delete + 파기 예약(동의/사유 기록) | 활성→탈퇴유예 | A2,D4 |
| POST | `/v1/users/me/restore` | 유예 중 복구(선택, auth-sync로 흡수 가능) | 탈퇴유예→활성 | D4 |
| GET | `/v1/users/me/identities` | 연결된 소셜 계정 목록 | — | A6 |

> 기존 `auth-sync`는 유지하되 **가입 완료 책임을 `/signup`으로 분리**. `auth-sync`는
> "프로필 존재 보장 + `last_seen_at` 갱신 + `requiresSignupConsent` 신호 + 유예 중이면 복구"만 담당.

### 7.2 회원가입 완료 (A1·A3·DEC-4) — 핵심
> 본질은 **신규 구현이 아니라 이관**이다. 현재 모바일 `completeSignupConsent`가 직접 하는
> `user_consents` upsert + `profiles.signup_completed_at` 갱신을 **API로 옮기고**, 여기에
> 연령 게이트·마케팅 동의를 추가한다. 기존 컬럼/값(`'terms'`,`'privacy'`,`version`,`accepted_at`,
> `source`, 유니크 `(user_id,consent_type,version)`)을 그대로 따른다.

요청:
```json
{
  "birthDate": "2000-01-01",
  "consents": [
    { "type": "terms",     "version": "terms-2026-05",   "granted": true },
    { "type": "privacy",   "version": "privacy-2026-05", "granted": true },
    { "type": "marketing", "version": "mkt-2026-05",      "granted": false }
  ]
}
```
서버 처리:
1. 필수 동의(`terms`,`privacy`) `granted=true` 검증 → 누락 시 `422`.
2. 만 14세 미만이면 `422`(가입 차단, 사유 코드 명시).
3. `user_consents` upsert(`onConflict (user_id,consent_type,version)`, `source='signup'`),
   `granted=false`(마케팅 미동의/철회)는 `revoked_at` 세팅. `profiles.birth_date` 저장.
4. `signup_completed_at`이 NULL이면 `now()`로 설정(이미 있으면 멱등 통과), `signup_source='signup'`.
5. 갱신된 프로필 + `requiresSignupConsent:false` 반환.

**멱등성/동시성**: 동일 요청 재시도 시 완료 상태 유지. 프로필 행 생성 경쟁은 기존
`insertProfile`의 23505 처리 패턴 재사용. 동의는 유니크 키 기준 upsert.

> ⚠️ **이관 순서**: API `/signup`을 배포·검증한 뒤에야 모바일의 직접쓰기를 제거하고
> Phase 4에서 RLS로 잠근다(병행 기간 동안 양쪽 호환 유지).

### 7.3 계정 삭제 + 복구 (A2·DEC-1)
- `DELETE /v1/users/me` (+ 선택 `{ "reason": "..." }`):
  1. `account_deletions` 기록(`purge_scheduled_at = now() + 30d`).
  2. `profiles.deleted_at = now()`, `purge_scheduled_at` 설정(soft delete).
  3. **즉시 hard delete 하지 않음** — auth 세션은 살아 있되, 보호 라우트는 `deleted_at` 사용자
     접근을 차단(가드/서비스에서 검사).
- **유예 중 재로그인** → `auth-sync`(또는 `/restore`)가 `deleted_at`/`purge_scheduled_at`을
  NULL로 되돌리고 `account_deletions.restored_at` 기록 → [활성] 복구.
- **cron 파기**: `jobs` 컨트롤러에 `POST /jobs/purge-deleted-accounts` 추가
  (`CRON_SECRET` 가드 재사용). `purge_scheduled_at <= now()` 대상에 §6.4 순서로 데이터/R2 정리 후
  `supabase.adminClient.auth.admin.deleteUser(userId)`, `hard_deleted_at` 기록.
- **재가입**: 파기 후 동일 소셜로 로그인하면 Supabase가 **새 user_id** 발급 → 신규 가입 처리(정상).
- **A10 재인증/확인**: 삭제는 파괴적이므로 클라이언트에서 명시적 확인을 요구하고, 서버는
  유효한 access token + (선택) 확인 플래그를 요구. MVP는 유예 기간이 안전망 역할.

### 7.4 비기능 / 하드닝
- **A9 `last_seen_at` 쓰기 스로틀**: 마지막 갱신이 N분(예: 10분) 이내면 UPDATE 생략.
- **A7 토큰 검증 캐시(선택)**: `getUser` 결과를 access token 잔여수명 이하 TTL로 메모리 캐시.
- **Rate limiting**: `/signup`, `DELETE /users/me`에 IP/유저 기준 제한(글로벌 보안 규칙 준수).
- **입력 검증**: 모든 신규 엔드포인트 `ZodValidationPipe` 적용, `birthDate`는 과거 날짜 검증.
- **에러 응답**: 기존 라우트 형태 유지(모바일 파서 호환), 신규는 일관 코드/메시지 체계.

---

## 8. 설계 결정 — 기술 세부 (신규)

### 8.1 `auth-sync` vs `signup` 책임 분리
- `auth-sync`: 멱등 upsert + `last_seen_at` + `requiresSignupConsent` + (유예 중) 복구 신호.
- `signup`: 동의·연령·`signup_completed_at` 확정. **두 엔드포인트가 같은 컬럼을 두고 경쟁하지 않도록**
  `signup_completed_at`은 `signup`만 기록한다.

### 8.2 보호 가드의 탈퇴유예 처리
`SupabaseAuthGuard` 통과 후, 서비스 레벨에서 `deleted_at != NULL`이면 복구/재가입 안내 외
일반 기능 접근을 차단. (가드 자체보다 서비스에서 처리해 `/restore`·`auth-sync`는 허용.)

### 8.3 `/api/*` 호환 라우트 정책 ⚠️ 결정 필요
기존 엔드포인트는 `/v1/*`와 `/api/*` 두 벌을 노출한다. **신규 계정 엔드포인트도 호환 라우트를
제공할지** 결정 필요 → §11(O-1).

### 8.4 FK/cascade 정합성
Phase 0에서 `profiles.user_id`, `user_consents.user_id` 등이 `auth.users(id)`에
`on delete cascade`인지 확인. cascade가 있으면 hard delete 시 자동 정리, 없으면 명시 삭제 필요.

---

## 9. 구현 단계 (Phases)

### Phase 0 선행조건 체크리스트 (환경 준비) — 코드 착수 전 필수 🔴

> 2026-05-29 환경 검증 결과 아래 항목이 미충족이라 현재는 Phase 0 착수가 **차단**된 상태다.
> 이 체크리스트가 모두 충족돼야 스키마 진단(Phase 0) 및 이후 단계로 막힘없이 진행된다.

**도구/런타임**
- [ ] Supabase CLI 설치 (`brew install supabase/tap/supabase`) — *현재 미설치(잔여)*.
- [x] Node 20.x / pnpm ≥10 (`package.json` engines 일치).

**자격증명 / 연결**
- [x] `.env` 생성 + `SUPABASE_URL`/`ANON_KEY`/`SERVICE_ROLE_KEY` 주입(웹 모노레포 자격증명 재사용).
- [x] 자격증명 커밋 금지 확인 — `.gitignore`에 `.env` 포함(`git check-ignore .env` 통과).
- [x] **DB 비밀번호** 확보 → `pg_dump`로 정식 baseline 생성 완료(`0001_remote_baseline.sql`). RLS/FK/제약/트리거 확정.

**정책 입력값** *(코드 상수/검증에 필요)*
- [x] O-2: 동의 버전 — DB 트리거가 `terms-2026-05-16`/`privacy-2026-05-16` 강제(확인됨). 마케팅 버전만 추가 확정 필요.
- [ ] O-3: 유예 기간 N 확정(기본 30일로 진행 가능 — soft).
- [ ] O-1: 신규 엔드포인트 `/api/*` 호환 라우트 제공 여부(모바일 base path 확인 후) — soft.

**확인된 가용 사항 (재확인 불필요)**
- [x] `@supabase/supabase-js@2.105.4` — `auth.admin.deleteUser` 사용 가능.
- [x] vitest + supertest — 단위/E2E 테스트 기반 존재.

**의존성 추가 (해당 Phase 진입 시)**
- [ ] `@nestjs/throttler` — rate limiting(§7.4, Phase 6) 진입 시 설치.

**크로스 레포 조정**
- [ ] Phase 4(RLS 강화)는 모바일 레포 `apps/mobile`의 `profiles` 직접 upsert 폴백 제거와
      **동시 진행** 필요 — 일정/배포 순서 사전 합의.

---

### Phase 0 — 스키마 진단 + 마이그레이션 베이스라인 (선행 필수, DEC-3) — ✅ 완료 (2026-05-29)

- [x] 진단 스크립트(`scripts/introspect-schema.mjs` REST, `scripts/introspect.sql` psql) 작성·실행.
- [x] **정식 baseline 덤프** `supabase/migrations/0001_remote_baseline.sql`(pg_dump, 983줄).
- [x] `profiles` 컬럼 확정 — `nickname`/`nickname_updated_at` **존재**, 닉네임 CHECK(≤10) **존재** → 폴백·신규 CHECK 불필요.
- [x] `user_consents` **이미 존재** — `consent_type` CHECK는 `{terms,privacy}`만, 유니크 `(user_id,consent_type,version)`.
- [x] **RLS 전 테이블 활성화** + profiles/consents 본인 행 insert/update 정책 확인(직접쓰기 허용 원인).
- [x] **FK on-delete**: profiles/user_consents → auth.users **CASCADE**, boards는 auth.users FK 없음(수동 삭제).
- [x] **O-2 해소**: 동의 트리거가 필수 버전 `terms-2026-05-16`/`privacy-2026-05-16`를 강제(§6.3).
- [x] `account_deletions`·`user_identities_v` 부재 확인.
- [x] 모바일 직접쓰기 현황(`completeSignupConsent`/`ensureCurrentProfile`) 파악.
- [x] 결과를 §4·§5·§6·§7·§8에 반영.

> 상세 실측 결과는 **`supabase/SCHEMA_SNAPSHOT.md`** 참조. baseline은 ap-south-1 원격 상태 스냅샷.

### Phase 1 — 회원가입 완료 + 동의 + 연령 (A1·A3·D3·DEC-4) ⭐ 최우선 — ✅ 완료 (2026-05-29)
- [x] `0002_profiles_account_columns.sql`(birth_date/deleted_at/deletion_reason/purge_scheduled_at + purge 인덱스). **DB 적용·검증 완료**.
- [x] `0003_user_consents_revoked_at.sql`(`revoked_at` 추가 + consent_type CHECK에 `marketing` 추가). **DB 적용·검증 완료**.
- [x] `src/users/consents.constants.ts`(필수=`terms`,`privacy` / 선택=`marketing`, 현재 버전 `*-2026-05-16`, 연령계산).
- [x] `POST /v1/users/me/signup`(연령 게이트 → 동의 insert → signup_completed_at 확정, 멱등), `GET /v1/users/me/consents`.
- [x] 연령 게이트(만 14세 미만 `422 UnprocessableEntity`, code=`AGE_RESTRICTION`).
- [x] `isMissingColumnError` 폴백 제거(`users.service.ts`). ※ `supabase.errors.ts`는 boards.service가 사용 중이라 유지.
- [x] 단위 테스트 4종(최초 가입 / 재요청 멱등 / 필수동의 누락 거부 / 14세 미만 거부) — 통과(10/10).
- [x] `pnpm lint`(clean) / `pnpm test`(10 passed) / `pnpm build`(성공).
- [ ] (모바일 병행) 직접쓰기 제거는 API 검증·배포 후 Phase 4에서 수행.

> 닉네임 길이 CHECK는 0002에서 추가하지 않음 — `profiles_nickname_check`(≤10)가 이미 존재(Phase 0 확인).
> ⚠️ 미배포: API는 로컬 검증만 완료. 실제 배포(Render) 및 모바일 연동 전환은 별도 진행.

### Phase 2 — 계정 삭제 + 유예 파기 + 복구 (A2·D4·DEC-1)
- [ ] `0004_account_deletions.sql`.
- [ ] `DELETE /v1/users/me`(soft delete + 파기 예약), `POST /v1/users/me/restore`.
- [ ] `auth-sync`에 유예 중 복구 로직 통합.
- [ ] `POST /jobs/purge-deleted-accounts`(CRON_SECRET 가드) + R2/데이터 일괄 정리.
- [ ] `MediaService`에 사용자 단위 일괄 파기 메서드 추가(현재 게스트 cleanup만 존재).
- [ ] 보호 가드/서비스의 `deleted_at` 접근 차단.
- [ ] 테스트: soft delete→복구 / 유예만료 파기 / 부분실패 재시도 / 재가입(신규 user_id).
- [ ] README account deletion 정합성 반영.

### Phase 3 — 온보딩 + 닉네임 형식 (A4·DEC-2)
- [ ] `POST /v1/users/me/onboarding/complete`.
- [ ] 닉네임 길이/형식 검증을 서버·클라이언트 공유 상수로 정리(유니크/중복검사 **미도입** — DEC-2).
- [ ] 닉네임 저장 시 NFC 정규화 + trim 적용.

### Phase 4 — RLS 강화 + 클라이언트 직접쓰기 제거 (D6)
- [ ] `0006_rls_policies.sql` 적용(profiles 본인 read, 쓰기 service-role 전용; consents/deletions 잠금).
- [ ] 모바일 `profiles` 직접 upsert 폴백 제거(선행 계획서 미체크 항목 종료).
- [ ] 전 구간 회귀 스모크: 로그인→가입완료→온보딩→조회→탈퇴→복구.

### Phase 5 — 소셜 연결 가시성 (A6·D5) [후속]
- [ ] `0005_user_identities_view.sql` + `GET /v1/users/me/identities`.

### Phase 6 — 비기능/관측 [선택]
- [ ] `last_seen_at` 스로틀(A9), 토큰 검증 캐시(A7), 로그인/탈퇴 감사 로그(D8), rate limiting.

---

## 10. 테스트 전략 (A8, 글로벌 80% 기준)

- **단위**: signup(동의/연령/멱등), 삭제·복구 상태 전이, 닉네임 정규화. 기존 `users.service.spec.ts` 확장.
- **통합**: Supabase admin 클라이언트 모킹 또는 테스트 프로젝트로 profiles/consents 왕복.
- **E2E(핵심 플로우)**: 게스트→로그인→auth-sync→signup→온보딩→탈퇴→유예복구.
- **회귀 가드**: 폴백 코드 제거 전후 동작 동일성 확인(Phase 0/1 경계).

---

## 11. 영향 받는 파일 (예상)

API:
- `src/users/users.controller.ts` — signup/consents/onboarding/delete/restore/identities 라우트.
- `src/users/users.service.ts` — 상태 전이 로직, 폴백 제거.
- `src/users/consents.service.ts`, `src/users/consents.constants.ts` (신규).
- `src/users/account-deletion.service.ts` (신규) — 삭제/복구/파기 오케스트레이션.
- `src/users/users.service.spec.ts` — 테스트 보강.
- `src/jobs/jobs.controller.ts` — `purge-deleted-accounts` cron 추가.
- `src/media/media.service.ts` — 사용자 단위 R2/미디어 일괄 파기 메서드.
- `src/auth/supabase-auth.guard.ts` 또는 서비스 — `deleted_at` 접근 처리.

DB:
- `supabase/config.toml`, `supabase/migrations/0001~0006_*.sql`.

문서:
- `README.md`, `plans/social-login-integration-plan.md`(RLS·폴백 제거 항목 종료).

---

## 12. 남은 결정 사항 (착수 전/중 확정)

- **O-1 (§8.3)**: 신규 계정 엔드포인트에 `/api/*` 호환 라우트를 제공할지, `/v1/*`만 둘지.
  → 모바일 클라이언트의 base path 사용 현황 확인 후 결정 권장.
- **O-2** ✅ 해소: 필수 동의 버전은 DB 트리거에 정의됨(`terms-2026-05-16`/`privacy-2026-05-16`).
  잔여: 마케팅 버전 문자열·동의 본문·차기 버전 관리(트리거 하드코딩 개선) — product/legal.
- **O-3**: 유예 기간 N(기본 30일) 법무 확정.
- **O-4**: 14세 미만 차단 방식 — 생년월일 입력 vs 연령 확인 체크. (현 설계: `birthDate` 입력)
- **O-5**: 탈퇴 시 추가 재인증(A10)을 MVP에 둘지, 유예 안전망으로 충분하다고 볼지.

---

## 13. 리스크

- **스키마 드리프트(D1/D2)**: Phase 0 미선행 시 폴백에 가려진 불일치가 운영 장애로 표면화 → Phase 0 강제.
- **파기 비가역성(DEC-1)**: hard delete는 되돌릴 수 없음 → 유예 + 복구 + cron 멱등 + 충분한 테스트.
- **부분 삭제 실패**: R2/DB 정리 중 중단 가능 → §6.4 순서 + 재시도 가능한 멱등 cron.
- **RLS 강화 회귀(D6)**: 모바일 직접쓰기 제거와 동시 진행 필요 → Phase 4 묶음 + 스모크.
- **법적 리스크(DEC-4)**: 동의 이력/연령 누락은 컴플라이언스 문제 → Phase 1 최우선.
- **재가입 혼동**: 파기 후 동일 소셜 = 신규 user_id. 과거 데이터 미연결을 UX에 명시.
```
