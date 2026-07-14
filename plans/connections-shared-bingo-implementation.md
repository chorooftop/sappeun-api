# 구현 계획서 (최종 v4): 유저 연결 & 공유 빙고 (sappeun-api)

- 대상: `sappeun-api` (NestJS 11 + Supabase PostgreSQL 17 + Cloudflare R2)
- 기반 기획서: `plans/connections-shared-bingo.md` (딥인터뷰 확정, 모호도 14.5%)
- 모드: **Deliberate** (브라운필드 + 동시성 + RLS 격리 + 마이그레이션 회귀 + service-role 우회 + close/award 원자성 리스크)
- 합의 상태: Planner → Architect(SOUND_WITH_CHANGES → 재검토 후 SOUND) → Critic(ITERATE 6건 → **APPROVE**) → **구현 전 코드 대조 검토 4건 반영 (2026-07-14, v4)**
- 실행 상태: **pending approval** (구현 착수는 별도 승인 필요)

---

## 리뷰 이력 (합의 루프 요약)

- **Architect 1차: SOUND_WITH_CHANGES → 반영.** 별도 `group_boards` 테이블(Option B) 아키텍처 승인.
- **Critic 1차: ITERATE 6건 → 전건 반영.**
  1. 스트릭 **UNION + DISTINCT daily_date** + 솔로 golden 회귀 테스트 (§3, §5).
  2. photos/clips XOR CHECK를 **NOT VALID**로 걸고 기존 NULL행 확인 후 별도 `validate constraint` (§1-0024). *(→ v4에서 가드 내장 방식으로 대체, 아래 참조)*
  3. AC-14 **완료·뱃지 단조 불변(캐시 모델)** 확정 (§1-0023, §3, ADR).
  4. **원자적 lazy close** `close_group_board()` 단일 승자 (§1-0025, §3, §5).
  5. **app-layer 활성 멤버십 가드** + Pre-mortem 시나리오 4 (§RALPLAN-DR, §3, §5).
  6. AC-8 리롤 잠금을 **`group_boards.first_media_at` 단조 컬럼** 기준으로 확정 (§1-0023, §1-0025).
- **Architect 재검토: 6건 해소 확인, 잔여 1건(award self-heal 분리) → 반영.** `close_group_board`의 단일 승자 게이팅을 `ended_at` 플립에만 국한하고, `award_group_board_badges`는 종료됐으나 미지급인 보드를 조회하는 모든 활성 멤버가 멱등 재시도하는 self-heal 경로로 분리(개인 보드 `resolveAlreadyEndedClose:1478-1521` 패턴 이식). 승자 크래시로 인한 award 영구 유실 구멍 제거.
- **Critic 최종: APPROVE.** self-heal 멱등성이 실코드(0008 마이그레이션의 on-conflict 시맨틱)로 검증됨. 비차단 오픈 퀘스천 1건: award 팬아웃의 멤버십 스냅샷 시점 — **구현 시 close-시점 활성 멤버십 기준으로 팬아웃하도록 확정 권장** (close 후 award 전 탈퇴자 경계 명확화).
- **구현 전 코드 대조 검토 (2026-07-14, v4): 4건 반영.**
  1. **스트릭 파생 기준을 `group_board_completions` 단조 원장으로 확정** (§1-0023, §1-0025 #11, §3). 기존 "활성 멤버 필터 UNION"은 탈퇴 시 과거 날짜가 소급 소멸(AC-14 위반)하고 늦은 합류자에게 소급 편입되는 결함. close-시점 활성 멤버 전원에게 유저별 완료 레코드를 멱등 팬아웃하고 스트릭은 이 원장에서 파생 — Critic 오픈 퀘스천(팬아웃 스냅샷 시점)도 동일 메커니즘으로 해소.
  2. **XOR CHECK는 NOT VALID 대신 마이그레이션 가드 내장** (§1-0024). NOT VALID는 기존 행 UPDATE 시점에 체크가 재적용되어 레거시 NULL/NULL 행의 soft-delete/confirm이 런타임에서 실패함. 0020의 dedupe 가드 패턴과 동일하게 오염 행 존재 시 배포 자체를 차단하고, 통과 시 즉시 유효 CHECK 도입.
  3. **`is_active_group_member`를 `security definer`로 선언** (§1-0021). `connection_group_members` 자체 SELECT 정책이 같은 테이블을 조회하는 헬퍼를 호출하면 RLS 무한 재귀(infinite recursion detected in policy) 발생 — definer + `set search_path`로 차단.
  4. **Phase 0 추출 리팩터 스킵** (§3, §4). `computeLifecycle`/KST 헬퍼는 이미 `src/common/time/kst.ts`에 존재(boards.service.ts:27-32 import), `summarizeBoardCompletion`도 이미 export된 순수 함수(boards.service.ts:379). 기존 파일 무변경 + 그룹 전용 `summarizeGroupBoardCompletion` 신규 작성으로 대체 → AC-15 리스크 구조적 0.

---

## RALPLAN-DR 요약

### Principles (원칙)
1. **개인 보드 경로 불가침(Regression-first)**: `boards`, `board_cells`, `boards_user_daily_uidx`, 기존 confirm/reroll RPC, 기존 spec 무회귀. 기획서 확정 사항, AC-15 하드 제약.
2. **DB 레벨 원자성 우선**: 앱 락 대신 유니크 인덱스 + `SECURITY DEFINER` RPC로 경합 해소. **close의 `ended_at` 플립은 `where ended_at is null returning *` 단일 승자로 원자화하되, award는 멱등 self-heal로 분리**하여 승자 크래시 시에도 복구되게 한다.
3. **RLS + app-layer 이중 격리**: 신규 그룹 테이블은 `is_active_group_member()` RLS로 방어하고, service-role 우회 API 경로는 **서비스 레이어 활성 멤버십 검증**을 추가 강제(AC-13).
4. **순수 신규 추가, 공유는 헬퍼로**: 그룹 보드는 별도 테이블 신설, 순수 함수만 추출 재사용.
5. **완료·뱃지·스트릭은 단조 불변**: 첫 발생 시점에 확정되는 단조 캐시. 미디어를 나중에 삭제해도 되돌리지 않는다(AC-14). **스트릭은 close-시점에 팬아웃된 `group_board_completions` 단조 원장에서 파생 — 탈퇴·재합류와 무관하게 불변.**
6. **레이블은 메타데이터**: 연인/친구/가족은 표시용, 기능 분기 금지.

### Decision Drivers (상위 3)
1. **AC-15 회귀 없음** — 기존 개인 보드 전체 테스트 무변경 통과.
2. **AC-7 / AC-13 동시성·격리** — 그룹당 하루 1보드 원자 + 비멤버/탈퇴자 완전 차단(RLS + app-layer).
3. **AC-9~11 셀 모델 불일치** — "셀당 멤버별 미디어 N개"가 기존 단일 미디어 셀 제약과 충돌 → 별도 미디어 테이블 불가피.

### Viable Options — 그룹 보드 저장 방식 (승인됨)

| | **Option A: `boards` nullable `group_id` 확장** | **Option B: 별도 `group_boards` 신설 (선택·승인)** |
|---|---|---|
| 장점 | 컬럼 재사용, 단일 라이프사이클 경로 | 기존 `boards`/`board_cells`/RLS/streak/uidx **완전 무변경** → AC-15 구조적 보장; 멤버십 RLS 국한; 멤버별 미디어 자연; `(group_id, daily_date)` 독립 유니크 |
| 단점 | `boards.user_id` NOT NULL → nullable화(대규모 회귀) 또는 오버로드; 모든 기존 쿼리에 `group_id IS NULL` 추가 = 검증 코드 전면 수정 | 라이프사이클/DTO 일부 중복(→순수 헬퍼 추출로 완화); 그룹 전용 RPC 필요 |

**탈락 무효화**
- **Option A**: `boards_user_daily_uidx (user_id, daily_date)`가 생성자 개인 보드와 거짓 유니크 충돌 → AC-7 차단; `auth.uid()=user_id` RLS로 그룹 보드가 생성자에게만 노출 → AC-13/16 위반. 양립 불가.
- **Option C(그룹 미디어 별도 `group_photos/clips`)**: R2 presign/etag 파이프라인 통째 복제 비용 과다. `photos/clips`에 nullable `group_board_id` 추가가 저비용.

### Pre-mortem (4 실패 시나리오 + 완화)
1. **동시 보드 생성 레이스** → `group_boards_group_daily_uidx (group_id, daily_date) WHERE deleted_at IS NULL` + `get_or_create_group_board()` `23505` catch 재select 수렴. 테스트: 병렬 5요청 → 보드 1개.
2. **RLS 누수(탈퇴자/외부인 조회)** → 전 그룹 테이블 `is_active_group_member()`(`left_at IS NULL`) SELECT 정책. 테스트: anon 직접 쿼리 0행.
3. **마이그레이션 개인 보드 회귀** → additive-only, XOR CHECK는 **가드 내장(오염 행 존재 시 배포 차단) 후 즉시 유효**, `boards/board_cells/uidx` 무변경, streak union no-op. 테스트: 기존 spec 무수정 통과.
4. **service-role 우회로 인한 멤버십 누수** → RLS만으론 AC-13 미충족. **모든 그룹 엔드포인트 서비스 레이어 멤버십 검증** + RPC 내부 재검증. 테스트: 비멤버/탈퇴자 GET/POST → 403/404 전수, 비멤버 RPC 직접 호출 거부.

### 확장 테스트 계획 개요
- **Unit**: 캡(5/6/7일), invite 코드 충돌 재시도, streak UNION+DISTINCT no-op(솔로 golden), 셀 완료 캐시 단조, `first_media_at` 단조 잠금, 라이프사이클 순수함수.
- **Integration**: 그룹 CRUD/초대/수락/탈퇴 RPC, `get_or_create_group_board` 병렬, `reroll_group_board` 잠금, group confirm RPC, **`close_group_board` 단일 승자 + award self-heal(승자 크래시 시뮬)**, `award_group_board_badges` 팬아웃 멱등(뱃지+완료 원장), **탈퇴 후 스트릭 날짜 유지(원장 불변)**, RLS + app-layer 가드, 비멤버 RPC 전수 거부.
- **E2E**: 2인 그룹 전체 플로우.
- **Observability**: 그룹 보드 생성/완료 카운터, 캡·RLS·app-guard 거부율, close 승자/패자·self-heal 발화 로그, RPC 에러코드 계측.

---

## 본문

### 1. DB 마이그레이션 계획 (0021~0025, 순수 SQL)

기존 스타일: `do $$ ... pg_constraint 가드 ... end $$;`, `create ... if not exists`, 말미 `notify pgrst, 'reload schema';`, RLS는 `revoke all from public,anon,authenticated; grant ... to service_role;` + authenticated SELECT 정책(0006 패턴).

#### 0021_connection_groups.sql
- **`connection_groups`**: `id uuid pk default uuid_generate_v4()`, `name text not null`(1~40 앱검증), `relationship_label text not null check in ('lover','friend','family','custom')`, `theme text`, `emoji text`, `created_by uuid not null references auth.users(id)`, `created_at/updated_at`, `deleted_at timestamptz`(마지막 멤버 탈퇴 시).
- **`connection_group_members`**: PK `(group_id, user_id)`(재합류=행 재활성), `group_id ... on delete cascade`, `user_id ... on delete cascade`, `joined_at`, `left_at timestamptz`(null=활성). 인덱스 `..._user_active_idx on (user_id) where left_at is null`.
- **헬퍼** `is_active_group_member(p_group_id, p_user_id) returns boolean language sql stable` — **반드시 `security definer set search_path = public`로 선언** (v4 이슈 3): `connection_group_members` 자체의 SELECT 정책이 이 헬퍼를 호출하므로, definer가 아니면 정책 평가가 같은 테이블 RLS를 재귀 호출해 "infinite recursion detected in policy" 발생. `grant execute to authenticated`(정책 평가용) + `service_role`.
- RLS: service-role 전권 + authenticated SELECT = `is_active_group_member(...)`.
- 캡(5개)은 RPC 원자 검증(0025).

#### 0022_connection_invites_requests.sql
- **`connection_group_invites`**: `id uuid pk`, `group_id ... cascade`, `invite_code text not null`(8자, `shares` 알파벳), `created_by`, `created_at`, `expires_at`(생성+7일), `revoked_at`. 유니크 `(invite_code)`.
- **`connection_group_join_requests`**: `id uuid pk`, `group_id`, `user_id`, `invite_id references invites(id)`, `status check in ('pending','approved','rejected') default 'pending'`, `decided_by`, `decided_at`, `created_at`. 부분 유니크 `(group_id, user_id) where status='pending'`.
- RLS: 멤버 SELECT + 요청 당사자 자기 요청 SELECT.

#### 0023_group_boards.sql
- **`group_boards`**: `id uuid pk`, `group_id ... cascade`, `daily_date date not null`, `mode default '3x3'`(기존 enum `public.board_mode` 재사용), `seed_recipe text not null`, `cell_ids text[]`, `free_position integer`, `reroll_count integer not null default 0`, **`first_media_at timestamptz`(단조 잠금 기준 — AC-8/AC-14: 첫 미디어 시 세팅, 이후 삭제해도 불변)**, `created_by`, `created_at/updated_at`, `ended_at`, `end_reason check (null or in ('completed','auto_grace_expired'))`, `deleted_at`.
  - **동시성 유니크**: `group_boards_group_daily_uidx on (group_id, daily_date) where deleted_at is null` (AC-7).
- **`group_board_cells`**: PK `(group_board_id, position)`, `position check 0..8`, `cell_id text not null`, 미션 스냅샷 컬럼(`board_cells` 미러), **`completed_at timestamptz`(단조 캐시 — 첫 미디어 시각 고정, 이후 전부 삭제돼도 미완료로 되돌리지 않음 — AC-14)**, `completed_by uuid`(첫 업로더), `completion_type text`. `photo_id/clip_id` 없음.
- **`group_board_cell_media`**: `id uuid pk`, `group_board_id`, `position`, `user_id not null references auth.users(id)`, `photo_id references photos(id)`, `clip_id references clips(id)`, `created_at`, `deleted_at`(본인 삭제 AC-14). 체크 `((photo_id is not null) <> (clip_id is not null))`. 유니크 `(group_board_id, position, user_id) where deleted_at is null`. 복합 FK `(group_board_id, position) → group_board_cells`.
- **`group_board_badges`**(팬아웃 저장; 기존 `board_badges.board_id`가 `boards` FK라 재사용 불가): PK `(group_board_id, mission_id, user_id)`, `earned_at`.
- **`group_board_completions`**(스트릭 파생 원장 — v4 이슈 1): PK `(group_board_id, user_id)`, `group_id uuid not null references connection_groups(id) on delete cascade`, `daily_date date not null`(보드에서 복제 저장 — 스트릭 쿼리 조인 제거), `completed_at timestamptz not null`. 인덱스 `group_board_completions_user_daily_idx on (user_id, daily_date desc)`. 보드 완료 시 **close-시점 활성 멤버 전원**에게 멱등 팬아웃(0025 #11). **한 번 기록되면 탈퇴·재합류와 무관하게 불변** → 스트릭이 이 원장에서 파생되므로 (a) 탈퇴 시 스트릭 소급 소멸(AC-14 위반), (b) 늦은 합류자의 합류 전 날짜 소급 편입, (c) 재합류 행 재활성으로 인한 멤버십 이력 유실 문제를 모두 구조적으로 해소. 뱃지(close-시점 스냅샷)와 스트릭의 멤버십 시맨틱 통일.
- RLS: 전부 `is_active_group_member(group_id, auth.uid())` SELECT + service-role 전권 (`group_board_completions`는 본인 행 `user_id = auth.uid()` SELECT 추가 — 탈퇴 후에도 자기 스트릭 원장 조회 가능).

#### 0024_group_media_extension.sql (기존 테이블 additive 확장)
- `alter table photos add column if not exists group_board_id uuid references group_boards(id)`.
- `alter table clips add column if not exists group_board_id uuid references group_boards(id)`.
- `alter table clips alter column board_id drop not null` (그룹 클립은 board_id 없음, 기존 행 무영향).
- **XOR CHECK는 가드 내장 후 즉시 유효 도입 — NOT VALID 미사용** (v4 이슈 2):
  - 근거: NOT VALID는 기존 행의 일괄 검증만 유예할 뿐 **기존 행을 UPDATE하는 순간 체크가 재적용**된다. 레거시 NULL/NULL photos 행이 남아 있으면 해당 사진의 soft-delete(`deletePhoto`의 `update photos set deleted_at`)·confirm의 `uploaded_at` 갱신이 런타임에서 즉시 실패 → "배포 후 count 확인"으로는 늦음.
  - 방식(0020의 dedupe 가드 패턴과 동일): `do $$ ... if exists (select 1 from photos where board_id is null and group_board_id is null) then raise exception 'photos with neither board_id nor group_board_id exist; reconcile before applying XOR check'; end if; ... end $$;` — **soft-delete된 행 포함 전수 검사**(CHECK는 테이블 전체에 적용되므로). `clips`도 동일 가드(단 `clips.board_id`는 0001에서 NOT NULL이라 사실상 통과).
  - 가드 통과 후: `alter table photos add constraint photos_owner_target_check check ((board_id is not null) <> (group_board_id is not null));` — 즉시 유효, 별도 `validate constraint` 후속 스텝 불필요. `clips` 동일.
  - 오염 행이 존재하면 배포가 실패하므로 런타임 사고 대신 **배포 시점에 차단**(정합 조치 후 재배포).
  - 참고(신규 경로 안전성 확인됨): 신규 개인 photos는 presign에서 `ensureUserBoardForMedia`가 보드 부재 시 throw하므로 `board_id`가 항상 세팅됨(boards.service.ts:970-1007, media.service.ts:205-226).

#### 0025_group_rpcs_rls.sql (모든 RPC — `security definer set search_path=public`, service-role만 execute grant; 각 RPC 내부 멤버십/에러 재검증)
1. **`create_connection_group(p_user_id, p_name, p_label, p_theme)`**: 활성 그룹 `<5`(초과→`GROUP_LIMIT`), 그룹 insert + creator 멤버 insert. 원자.
2. **`request_group_join(p_user_id, p_invite_code)`**: invite 유효(미만료·미회수)·그룹 미삭제, 유저 활성 그룹 `<5`, 이미 활성 멤버 아님, join_request upsert(pending 부분유니크). 만료→`INVITE_EXPIRED`.
3. **`approve_group_join(p_decider_id, p_request_id)`**: decider 활성 멤버 검증, 활성 멤버 `<6`(초과→`MEMBER_LIMIT`), approved, 멤버 upsert(재합류 `left_at=null`). 원자 캡.
4. **`reject_group_join(p_decider_id, p_request_id)`**: 멤버 검증 후 rejected.
5. **`leave_group(p_user_id, p_group_id)`**: `left_at=now`; 활성 멤버 0명 → `connection_groups.deleted_at`. 기지급 뱃지/스트릭 무회수(AC-14 — 스트릭은 `group_board_completions` 원장이라 자동 보존).
6. **`get_or_create_group_board(p_user_id, p_group_id, p_daily_date, p_seed_recipe, p_cell_ids, p_free_position, p_mission_snapshots)`**: 활성 멤버 검증 → insert, `23505` catch → 재select 수렴, 셀 9개 시드 (AC-7).
7. **`reroll_group_board(p_user_id, p_group_board_id, p_limit)`**: 활성 멤버 검증 → **`update ... where reroll_count < p_limit and ended_at is null and deleted_at is null and first_media_at is null returning reroll_count`** (AC-8: `first_media_at` 세팅 시 영구 잠금, 미디어 전부 삭제돼도 재개방 안 함 — 단조 캐시 모델과 일관). 0행 → `REROLL_LOCKED`. (기존 `reroll_board` 0020의 원자 UPDATE 패턴 + `first_media_at` 조건 추가.)
8. **`confirm_group_photo_upload(p_photo_id, p_user_id, p_object_etag, p_confirmed_at)`**: `photos`에서 `group_board_id/position/cell_id` 읽어 업로더 활성 멤버 검증 → **현재 `group_board_cells.cell_id`와 photo의 `cell_id` 일치 재검증**(presign→confirm 사이 리롤로 셀이 교체된 경우 `CELL_MISMATCH` 거부 — v4 부수 이슈) → `photos` uploaded → `group_board_cell_media` upsert → `group_board_cells.completed_at = coalesce(completed_at, p_confirmed_at)`, `completed_by = coalesce(...)`, `completion_type` → **`group_boards.first_media_at = coalesce(first_media_at, p_confirmed_at)`(단조 세팅)** + `updated_at` touch. (AC-9 첫 완료 고정, AC-10 추가 업로드 시각 불변).
9. **`confirm_group_clip_upload(...)`**: 8과 동일(클립+포스터 2키), `first_media_at` coalesce 동일.
10. **`close_group_board(p_group_board_id, p_reason)`** (단일 승자 close + self-heal award 분리 — 핵심):
   - **단일 승자 게이팅은 `ended_at` 플립에만 국한**: `update group_boards set ended_at=now(), end_reason=p_reason where id=p_group_board_id and ended_at is null returning *`. 이 UPDATE는 중복 close 방지만 담당(누가 접속하든 첫 트리거만 `ended_at` 세팅).
   - **award는 이 RPC의 승자 분기에서 발화하지 않는다.** 이유: 승자가 `ended_at` 세팅 후 award 실행 전 크래시하면 이후 모든 close가 0행(전원 패자)이 되어 award가 영구 유실되기 때문(개인 보드는 `resolveAlreadyEndedClose:1478-1521`가 매 조회 시 멱등 재시도해 이 구멍이 없음).
   - 반환: 최신 `group_boards` 행(승자/패자 무관, 현재 상태). 호출측(GroupBoardsService)이 이 행의 `end_reason='completed'` && **`group_board_completions` 미기록** 여부로 self-heal award를 트리거(뱃지 0개 케이스에도 게이트가 동작하도록 completions 기준 — v4 이슈 1).
11. **`award_group_board_badges(p_group_board_id, p_badge_ids)`** (self-heal 멱등 경로 — 뱃지 + 완료 원장 팬아웃 통합, v4 이슈 1 반영): 팬아웃 대상은 **close-시점 활성 멤버**(`left_at is null OR left_at > ended_at` — Critic 오픈 퀘스천 확정: close 후 award 전 탈퇴자도 포함, AC-11 "전원" + AC-14 무회수와 일관). 각 멤버에 대해:
   - **`group_board_completions` insert `on conflict do nothing`** — 뱃지 유무와 무관하게 항상 기록(스트릭 원장).
   - `group_board_badges` insert `on conflict do nothing` + **실제 insert된 행에 대해서만** `user_badges` upsert(0008의 `inserted` CTE 게이팅 패턴 이식 — 동시 중복 호출 시 `earned_count` 이중 증가 방지). 그룹 지급 시 `first/last_board_id`는 `boards` FK이므로 **on conflict update set에서 `last_board_id`를 제외**(null로 기존 개인 뱃지 기록 오염 금지 — v4 부수 이슈; 신규 insert 시엔 null 허용).
   - **승자 여부와 무관하게, "종료(`end_reason='completed'`)됐으나 `group_board_completions` 미기록"인 보드를 조회하는 모든 활성 멤버가 이 경로를 멱등 재시도**. 다중 동시 호출도 on-conflict 시맨틱으로 안전. 전원 동일 지급(AC-11).

### 2. API 설계 (신규 모듈, 기존 컨트롤러 패턴 일관)

공통: `@UseGuards(SupabaseAuthGuard)`, `@CurrentUser() user`, `ZodValidationPipe`, Nest 표준 예외 + 앱 에러코드. **모든 그룹 엔드포인트는 서비스 레이어에서 활성 멤버십을 먼저 검증(AC-13)**.

**ConnectionsController** (`/connections`)

| 메서드 | 경로 | 요청 | 응답 | 에러 |
|---|---|---|---|---|
| POST | `/connections/groups` | `{name, relationshipLabel, theme?, emoji?}` | `{group}` | 400, 422 `GROUP_LIMIT_EXCEEDED` |
| GET | `/connections/groups` | — | `{groups:[{...,memberCount}]}` | — |
| GET | `/connections/groups/:groupId` | — | `{group, members[]}` | 403/404 비멤버 |
| DELETE | `/connections/groups/:groupId/membership` | — | `{ok, groupDeleted}` | 403/404 |
| POST | `/connections/groups/:groupId/invites` | — | `{inviteCode, inviteUrl, expiresAt}` | 403 |
| DELETE | `/connections/groups/:groupId/invites/:inviteId` | — | `{ok}` | 403/404 |
| POST | `/connections/join-requests` | `{inviteCode}` | `{request}` | 404, 410 `INVITE_EXPIRED`, 409 이미멤버, 422 `GROUP_LIMIT_EXCEEDED` |
| GET | `/connections/groups/:groupId/join-requests` | — | `{requests:[pending]}` | 403 |
| POST | `/connections/join-requests/:requestId/approve` | — | `{ok, member}` | 403, 422 `MEMBER_LIMIT_EXCEEDED` |
| POST | `/connections/join-requests/:requestId/reject` | — | `{ok}` | 403 |

**GroupBoardsController** (`/connections/groups/:groupId/board`)

| 메서드 | 경로 | 응답 | AC |
|---|---|---|---|
| GET | `.../board` | `{board:{cells:[{position, completedAt, completedBy, media:[{userId, photoId/clipId, previewUrl}]}], lifecycle, firstMediaAt}}` (없으면 자동생성, 접속 시 원자 lazy close + self-heal award 판정) | AC-7,10,12 |
| POST | `.../board/reroll` | `{rerollCount}` | AC-8 (409 `REROLL_LOCKED`) |
| GET | `.../board/cells/:position` | `{cell, media[]}` — **`completed_at` 있으나 `media[]`가 빌 수 있음(전원 삭제 후 단조 완료 유지)을 API 계약에 명시** | AC-10,14 |
| DELETE | `.../board/cells/:position/media/:mediaId` | `{ok}` (본인 것만; 셀 완료/뱃지/스트릭 불변) | AC-14 (403 타인) |
| POST | `.../board/end` | `{ok, board}` (`close_group_board` 경유) | AC-11,12 |

**Home 집계 (AC-16)** — `GET /boards/home`: `{personalBoard, groupBoards:[{groupId, groupName, board:{lifecycle, completedCount}}]}`.

**Media 확장** — `media.schemas`에 discriminated union `target = {kind:'user'} | {kind:'group', groupId}`. 그룹 타깃 presign은 `get_or_create_group_board` 경유 `group_board_id`로 `photos/clips` insert, confirm은 `confirm_group_*_upload`. 그룹 분기도 app-layer 멤버십 검증 필수. **기존 user 경로 무변경**.

### 3. 서비스 로직 변경점

- **공용 헬퍼 (Phase 0 추출 스킵 — v4 이슈 4)**: `computeLifecycle`/`kstDateOf`/`previousKstDate`/`BoardLifecycle`은 **이미 `src/common/time/kst.ts`에 존재**(boards.service.ts:27-32에서 import 중), `summarizeBoardCompletion`도 **이미 export된 순수 함수**(boards.service.ts:379) → 기존 파일 무변경으로 그룹 모듈이 직접 import. 단 `summarizeBoardCompletion`은 `cell.photo_id/clip_id` 단일 미디어 증거에 의존하므로 그룹 셀 모델(`completed_at` + `group_board_cell_media`)에는 재사용 불가 — **그룹 전용 `summarizeGroupBoardCompletion` 순수 함수를 `src/group-boards/`에 신규 작성**(완료 증거 = `completed_at` 단조 캐시 + free position).
- **`ConnectionsService` (신규)**: 그룹/초대/요청/멤버십 RPC 위임 + 모든 메서드 진입 시 활성 멤버십 검증(AC-13). invite 코드는 `shares.service`의 `generateShareCode`/`23505` 재시도 패턴 재사용.
- **`GroupBoardsService` (신규)**: `get_or_create_group_board`·`reroll_group_board` 위임 + `computeLifecycle`(kst.ts)로 grace/expired 판정.
  - **close/award 오케스트레이션 (self-heal)**: 보드 조회/종료 시 `close_group_board()` 호출로 `ended_at` 플립을 원자 처리한 뒤, **반환 행이 `end_reason='completed'`이고 `group_board_completions` 미기록이면 (승자·패자 무관) `award_group_board_badges` self-heal 재시도**. 개인 보드 `resolveAlreadyEndedClose:1478-1521` 패턴 이식. 승자가 award 전 크래시해도 다음 멤버 조회가 복구.
  - 모든 조회/쓰기에 app-layer 멤버십 가드.
- **`BadgesService` 확장**: `awardGroupBoardBadges({groupBoardId, badgeIds})` → `award_group_board_badges` RPC(뱃지 + 완료 원장 팬아웃 통합). **`awardBoardBadges` 무변경** (AC-15).
- **`StreakService` (신규)**: `computeStreakEndingAt`를 승격. 쿼리를 개인 `boards`(`end_reason='completed'`) **UNION** **`group_board_completions`(해당 `user_id`의 원장 — 현재 멤버십 무관, v4 이슈 1)**로 병합하되, **반드시 `daily_date`를 `UNION`(중복제거) 또는 명시적 `SELECT DISTINCT daily_date`로 유일화**. 이유: 기존 루프(boards.service.ts:846-870)가 `row.daily_date !== expected`로 break하므로 같은 날짜 2행(개인+그룹 동일날 완료)이 있으면 스트릭이 오염됨. 정렬 desc·`limit 370`은 유일화된 날짜 집합에 적용. **회귀 안전성**: 원장 0행 유저는 union 결과가 개인과 완전 동일 → 솔로 golden 테스트로 보증. 개인 `BoardsService`는 이 서비스에 위임.
- **`MediaService` 확장**: presign/confirm/delete 그룹 분기 + 그룹 R2 키 빌더(`group_board_id` 경로, owner-hash는 업로더 user_id 유지) + app-layer 멤버십 가드. **기존 user 경로 무변경**.
- **완료·뱃지 단조 불변**: `group_board_cells.completed_at`·`group_boards.first_media_at`는 단조 캐시. 미디어 삭제(마지막 포함)로 셀을 미완료로 되돌리지 않고, 기지급 뱃지/스트릭 무회수. 완료 셀에서 `media[]`가 빌 수 있음. (참고: 개인 보드는 삭제 시 `completed_at=null` 리셋 — media.service.ts:318-327 — 과 **의도적으로 다른** 그룹 전용 규칙)
- **모듈 등록** (`src/app.module.ts`): `ConnectionsModule`, `GroupBoardsModule` 추가. `GroupBoardsModule imports [BadgesModule, ConnectionsModule]`, `StreakService`는 `BoardsModule`에서 제공·export하여 공용.
- **env/상수** (`src/config/env.ts`): `GROUP_BINGO_ENABLED`(기본 true, `DAILY_BINGO_ENABLED` 미러) + `GROUP_MAX_PER_USER=5`, `GROUP_MAX_MEMBERS=6`, `INVITE_TTL_DAYS=7`(RPC와 동기).

### 4. 단계별 구현 순서 (Phase)

- **Phase 0 — 회귀 기준선 확립 (추출 리팩터 스킵 — v4 이슈 4)**: 기존 spec 전량 그린 확인만 수행(기준선 스냅숏). 헬퍼는 기존 `src/common/time/kst.ts`·`summarizeBoardCompletion` export를 그대로 사용하므로 **기존 파일 무변경**. **AC-15 사전 게이트**.
- **Phase 1 — DB 마이그레이션**: `0021`~`0025`. 완료: 로컬 적용 성공(XOR 가드 통과 = NULL/NULL 0 검증 내장, 별도 validate 스텝 없음), RLS(`is_active_group_member` security definer — members 정책 재귀 없음 확인)/유니크/`first_media_at`/**`group_board_completions`**/`close_group_board`·`award_group_board_badges` 분리 존재 확인. AC-1~13 토대.
- **Phase 2 — ConnectionsModule**: `src/connections/*` + spec. 완료: CRUD/초대/요청/수락/거절/탈퇴 + app-layer 가드 통합 테스트, 캡·만료 거부. AC-1~6, 13.
- **Phase 3 — GroupBoardsModule**: `src/group-boards/*` + spec. 완료: 자동생성 병렬 안전, `first_media_at` 리롤 잠금, **`close_group_board` 단일 승자 + award self-heal 오케스트레이션(completions 게이트)**. AC-7, 8, 12.
- **Phase 4 — Media 그룹 분기**: `media.service/schemas/controller`, R2 그룹 키. 완료: presign→confirm→`group_board_cell_media` 반영, 멤버별 N개, 본인 삭제, cell_id 일치 재검증, app-layer 가드. AC-9, 10, 14.
- **Phase 5 — 완료 보상 팬아웃 & Home**: `badges.service`, `streak.service`, close/award self-heal 오케스트레이션, Home. 완료: 완성 시 전원 뱃지+완료 원장+스트릭(멱등 복구 가능), 홈 집계. AC-11, 16.
- **Phase 6 — 테스트·회귀·관측 (최종 게이트)**: 아래 §5 전체 + 기존 전 spec 무변경 통과(AC-15) + 관측 배선.

### 5. 테스트 계획 (jest)

- **회귀 보증 (AC-15, 최상위)**: `boards.service.spec`, `badges.service.spec`, `media-*.spec`, `boards.schemas.spec` **무수정** 그린 (Phase 0·6 2회 게이트).
- **솔로 스트릭 golden**: 그룹 0개(완료 원장 0행) 유저의 `StreakService.computeForUser` 결과가 수정 전 `computeStreakEndingAt`와 **완전 동일**함을 golden 회귀 테스트로 Phase 6 게이트에 명시. UNION+DISTINCT가 개인 결과를 바꾸지 않음 보증.
- **Unit**: 캡(5/6) 경계, invite 만료/회수, `first_media_at` 단조 잠금(미디어 삭제 후에도 리롤 잠김 유지), 셀 완료 캐시 단조(전원 삭제 후 `completed_at` 불변), 라이프사이클 순수함수, `summarizeGroupBoardCompletion`, invite 코드 `23505` 재시도.
- **Integration**: create/request/approve/reject/leave RPC, `get_or_create_group_board` **병렬 5→1보드**(AC-7), `reroll_group_board` `first_media_at` 잠금(AC-8), group confirm RPC의 `cell_media` upsert + `completed_at`/`first_media_at` coalesce + **cell_id 불일치 거부**, **`close_group_board` 동시 다중 트리거 → `ended_at` 단일 플립 검증**, **award self-heal: 승자 크래시 시뮬레이션(=`ended_at`만 세팅되고 `group_board_completions` 미기록인 보드) → 다음 활성 멤버 조회 시 `award_group_board_badges` 발화 → 전원 지급 복구 검증**, `award_group_board_badges` 다중 호출 멱등(뱃지 + 완료 원장 이중 증가 없음, `user_badges.earned_count` 게이팅)(AC-11), **뱃지 0개 완료 보드에서도 completions 기록**, **스트릭 원장 불변: 완료 후 탈퇴해도 스트릭 날짜 유지 + 늦은 합류자에게 합류 전 날짜 미편입**, RLS + app-layer 가드, 비멤버 RPC 전수 거부, **members 테이블 SELECT 정책 재귀 없음(authenticated 직접 조회 정상 동작)**.
- **격리 (AC-13)**: (a) RLS — anon 직접 쿼리 0행; (b) app-layer 가드 — 비멤버/탈퇴자 모든 그룹 GET/POST → 403/404 전수; (c) 비멤버가 각 그룹 RPC 직접 호출 → 거부 전수.
- **E2E**: 2인 그룹 골든패스(생성→초대→수락→자동생성→A 업로드→B 추가→완성→전원 뱃지+스트릭+1→A 탈퇴 후 미디어·완료·**스트릭 잔존**→A가 자기 미디어 삭제해도 셀 완료 유지).
- **Observability**: 그룹 보드 생성/완료 카운터, 캡·RLS·app-guard 거부율, close 승자/패자·self-heal 발화 로그, RPC `23505`/`42501` 계측.

### 6. 리스크와 완화책

| 리스크 | 영향 | 완화 |
|---|---|---|
| 개인 보드 회귀(마이그레이션/streak) | AC-15 실패 | additive-only, XOR CHECK **가드 내장**, `boards/board_cells/uidx` 무변경 + Phase 0 리팩터 스킵, streak UNION+DISTINCT no-op, Phase 0·6 이중 게이트 + 솔로 golden |
| 동시 보드 생성 레이스 | AC-7 | 부분유니크 + `23505` catch 재select |
| 비멤버/탈퇴자 누수 | AC-13, 보안 | RLS `is_active_group_member`(security definer) **+ app-layer 서비스 가드** + RPC 내부 재검증 |
| **close 중복/유실**(N멤버 접속·승자 크래시) | 뱃지/스트릭 중복 또는 **영구 유실** | `ended_at` 플립은 `where ended_at is null returning *` 단일 승자(중복 방지); **award는 completions 미기록 보드를 조회하는 모든 멤버가 멱등 self-heal 재시도**(승자 크래시 복구); award `on conflict do nothing` + `inserted` CTE 게이팅 |
| **탈퇴/재합류로 스트릭 소급 변동** | AC-14 위반 | `group_board_completions` 단조 원장에서 파생 — 한 번 기록되면 멤버십 변동 무관 불변 |
| 캡 경합(5/6 동시 초과) | 정책 위반 | RPC 트랜잭션 내 카운트+쓰기 원자화 |
| 리롤 재개방 혼선(미디어 삭제 후) | AC-8/캐시 불일치 | `first_media_at` 단조 컬럼 기준 잠금 — 한 번 잠기면 유지 |
| 기존 NULL/NULL 미디어 행 | XOR CHECK 도입 실패 | **마이그레이션 가드로 배포 시점 차단(의도된 실패)** — 런타임 UPDATE 사고 원천 방지, 정합 조치 후 재배포 |
| 뱃지 재지급 중복 | earned_count 오증가 | `group_board_badges` PK + `on conflict do nothing` → insert된 행만 `user_badges` 반영(0008 CTE 게이팅), `last_board_id` 미덮음 |
| RLS 정책 무한 재귀(members 자기참조) | 그룹 조회 전면 장애 | `is_active_group_member` **security definer** + `set search_path=public` |

---

## ADR (Architecture Decision Record)

- **Decision**: 그룹 보드를 별도 `group_boards`/`group_board_cells`/`group_board_cell_media`/`group_board_badges`/**`group_board_completions`**로 신설(Option B). 미디어는 `photos/clips`에 nullable `group_board_id` additive 추가(XOR CHECK는 **가드 내장 후 즉시 유효**). 그룹 RPC는 `SECURITY DEFINER`, 격리는 `is_active_group_member`(**security definer**) RLS + app-layer 가드. 완료·뱃지·스트릭·리롤 잠금은 `completed_at`/`first_media_at` 단조 캐시. **close의 `ended_at` 플립은 단일 승자, award(뱃지+완료 원장 팬아웃)는 멱등 self-heal로 분리. 스트릭은 close-시점 활성 멤버에게 팬아웃된 완료 원장에서 파생.**
- **Drivers**: (1) AC-15 회귀 없음, (2) AC-7/AC-13 동시성·격리, (3) AC-9~11 멤버별 다중 미디어, (4) AC-14 멤버십 변동 무관 보상 불변.
- **Alternatives considered**: (A) `boards` nullable `group_id` — uidx 거짓 충돌 + RLS 부적합으로 기각. (C) 그룹 미디어 별도 테이블 — R2 파이프라인 중복으로 기각. (close 설계) 승자 분기에서 award 직접 발화 — 승자 크래시 시 award 영구 유실로 기각, self-heal 분리 채택. (스트릭) 활성 멤버 필터 UNION — 탈퇴 시 소급 소멸/늦은 합류자 소급 편입으로 기각; 멤버십 윈도우 필터 — 재합류 행 재활성으로 이력 유실이라 기각; **완료 원장 파생 채택**. (XOR) NOT VALID + 배포 후 validate — 기존 행 UPDATE 시 체크 재적용으로 런타임 실패 위험이라 기각; **가드 내장 채택**.
- **Why chosen**: 검증된 개인 보드 경로(테이블/인덱스/RLS/streak/spec)를 무변경하면서 그룹 요구를 순수 추가로 충족하는 유일 경로. close/award 분리는 개인 보드가 이미 갖춘 self-heal 특성(`resolveAlreadyEndedClose`)과 동등한 내결함성을 그룹에도 부여. 완료 원장은 뱃지·스트릭의 멤버십 시맨틱을 close-시점 스냅샷으로 통일.
- **Consequences**: (+) 회귀 위험 최소, RLS+app-layer 이중 격리, 멤버별 미디어 자연 표현, close 원자성 + award 내크래시성, 스트릭 멤버십-불변. (−) 라이프사이클/DTO 일부 중복, 그룹 전용 RPC 11개, 원장 테이블 1개 추가. **(주의) 완료·뱃지·스트릭은 단조 불변 — 미디어를 나중에 삭제(마지막 포함)해도 셀 완료·뱃지·스트릭·리롤 잠금을 되돌리지 않으며, 완료 셀의 `media[]`가 비어 있을 수 있다.**
- **Follow-ups**: (1) 관계 유형별 전용 미션, (2) 실시간 동기화(현재 폴링), (3) 여행 지도 2차 기획의 `connection_groups` 재사용, (4) 그룹 전용 뱃지 카탈로그, (5) R2 그룹 미디어 정리 배치(탈퇴 잔존 정책 연계), (6) self-heal award 반복 실패 보드 감지용 관측 알림.

---

## 핵심 파일 경로 (구현 시)

- 확정 기획서: `plans/connections-shared-bingo.md`
- 마이그레이션 신규: `supabase/migrations/0021_connection_groups.sql` ~ `0025_group_rpcs_rls.sql`
- 재사용 원본: `src/common/time/kst.ts`(`computeLifecycle`/KST 헬퍼 — 이미 분리됨), `src/boards/boards.service.ts`(`summarizeBoardCompletion:379`/리롤/`computeStreakEndingAt:846-870`/`resolveAlreadyEndedClose:1478-1521`), `src/badges/badges.service.ts`(`awardBoardBadges:291`), `src/media/media.service.ts`, `src/shares/shares.service.ts`(코드 생성/`23505` 재시도), `supabase/migrations/0020_daily_bingo.sql`(uidx 가드 패턴·`reroll_board`), `0004_r2_media_metadata_and_confirm_rpcs.sql`(confirm RPC), `0006_bingo_editable_badges.sql`(뱃지·RLS grant 패턴), `0008_fix_award_board_badges_conflict_targets.sql`(award 멱등 CTE 게이팅), `0001_remote_baseline.sql:441`(photos.board_id nullable)
