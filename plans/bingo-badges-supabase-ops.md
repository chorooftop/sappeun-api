# Bingo Editable Missions + Badges — Supabase 적용 기획서

상태: applied to remote (2026-06-05 KST, Supabase MCP 적용/검증 완료)

작성일: 2026-06-05

대상 레포: `/Users/oksang/Desktop/sappeun/sappeun-api`

관련 API plan: `plans/bingo-editable-badges-api.md`

대상 migrations:

- `supabase/migrations/0006_bingo_editable_badges.sql`
- `supabase/migrations/0007_bingo_badge_fk_indexes.sql`
- `supabase/migrations/0008_fix_award_board_badges_conflict_targets.sql`

Supabase project_id/ref: `wtptvgxyqkqqsfkdsoox`

## 목적

API plan(`bingo-editable-badges-api.md`)의 코드/마이그레이션 구현을 바탕으로, 대상 Supabase 원격 프로젝트에 bingo editable mission/badge DB 변경을 적용했다. 이 문서는 실제 Supabase 프로젝트 설정, 적용된 migration, 검증 결과, 잔여 운영 리스크를 기록한다.

코드 자체는 적용 대상이 아니다. 이 문서는 순수하게 **DB/Supabase 운영 작업**만 다룬다.

## 실제 Supabase 설정 확인 결과

검증 시각: 2026-06-05 KST

검증 수단:

- 로컬 shell: `supabase --version`, `supabase/config.toml`, `.env`, `supabase/migrations`
- Supabase MCP: project metadata, project URL, publishable keys, migrations, public tables, advisors, SQL read-only probes
- 공식 문서/변경사항: Supabase RLS 문서, local migrations 문서, changelog `Tables not exposed to Data and GraphQL API automatically`

| 항목 | 실제 값 / 상태 | 운영 판단 |
| --- | --- | --- |
| Project ref | `wtptvgxyqkqqsfkdsoox` | `supabase/config.toml` 및 `.env` URL과 일치 |
| Project name | `chorooftop's Project` | 대상 원격 프로젝트 확인 완료 |
| Region | `ap-south-1` | Asia Pacific region |
| Project status | `ACTIVE_HEALTHY` | 원격 적용 가능 상태 |
| Database | Postgres `17.6`, engine `17`, release channel `ga` | Postgres 15+이므로 view는 필요 시 `security_invoker = true` 사용 가능 |
| API URL | `https://wtptvgxyqkqqsfkdsoox.supabase.co` | `.env`의 `SUPABASE_URL`과 일치 |
| Publishable keys | active legacy anon key 1개, active publishable key 1개 | 값은 문서에 기록하지 않음 |
| Local `.env` key format | `SUPABASE_ANON_KEY`는 publishable format, `SUPABASE_SERVICE_ROLE_KEY`는 secret format | `SUPABASE_ANON_KEY` 이름이지만 JWT anon key가 아니라 publishable key임 |
| Local Supabase CLI | 미설치 (`zsh: command not found: supabase`) | 적용 전 설치 필요 |
| Edge Functions | 없음 | 이 작업 범위 밖 |
| 주요 installed extensions | `pgcrypto`, `uuid-ossp`, `pg_stat_statements`, `supabase_vault` 등 | `0006` 적용에 추가 extension 필요 없음 |

## 원격 DB 적용 결과

### Migration history

Supabase MCP `list_migrations` / `supabase_migrations.schema_migrations` 기준 원격 이력:

| version | name |
| --- | --- |
| `20260603054049` | `r2_media_metadata_and_confirm_rpcs` |
| `20260603054308` | `restrict_media_confirm_rpc_execute` |
| `20260604180448` | `bingo_editable_badges` |
| `20260604180645` | `bingo_badge_fk_indexes` |
| `20260604180808` | `fix_award_board_badges_conflict_targets` |

원격 적용은 Supabase CLI가 로컬에 없어 Supabase MCP `apply_migration`으로 수행했다. 원격 migration version은 MCP 적용 시점의 timestamp로 기록되며, 로컬 파일명(`0006`/`0007`/`0008`)과 숫자 prefix가 1:1로 같지는 않다.

### `0006` 객체 존재 여부

원격 SQL probe 결과, 다음 객체는 모두 존재한다.

| 종류 | 객체 | 원격 상태 |
| --- | --- | --- |
| table | `public.mission_badges` | 존재 |
| table | `public.board_badges` | 존재 |
| table | `public.user_badges` | 존재 |
| column | `public.boards.customization_status` | 존재 |
| column | `public.board_cells.original_cell_id` | 존재 |
| column | `public.board_cells.original_mission_snapshot` | 존재 |
| column | `public.board_cells.edited_at` | 존재 |
| function | `public.award_board_badges(...)` | 존재 |
| policy | `mission_badges_select_active` | 존재 |
| policy | `board_badges_select_own` | 존재 |
| policy | `user_badges_select_own` | 존재 |

결론: 원격 DB에는 badge/editable mission migration이 적용되어 있다.

### 현재 데이터 분포

| 확인 항목 | 결과 | 의미 |
| --- | --- | --- |
| `public.boards` row 수 | 67 | 실제 운영/테스트 데이터 존재 |
| `board_kind='mission'` | 67 | 현재 custom board 없음 |
| `board_kind='custom'` | 0 | `custom` -> `edited` backfill은 현재 원격에서는 no-op |
| `title` 24자 초과 | 0 | `boards_title_length_check` 적용 실패 가능성 낮음 |
| `max(char_length(title))` | 5 | 현재 데이터 기준 안전 |
| `public.board_cells` row 수 | 915 | 기존 cell 데이터 존재 |
| `mission_snapshot` 보유 cell | 889 | badge seed/catalog 매칭 smoke에 사용할 수 있음 |
| `mission_catalog_version` 보유 cell | 889 | catalog version drift 확인 가능 |
| 프론트 sheet asset | `sappeun-frontend/apps/mobile/assets/data/sheet.json` v1.3.0 | `0006` seed의 ID/라벨과 일치 |
| sheet difficulty 누락 | non-self mission 38개 | v1 seed에서 `easy`로 확정 |

## 적용 대상 객체 요약 (`0006`)

| 종류 | 객체 | 비고 |
| --- | --- | --- |
| ALTER | `boards.customization_status` (text, default `official`, check `official`/`edited`) | 적용 완료 |
| ALTER | `boards` constraint `boards_title_length_check` (title <= 24) | 현재 데이터 기준 통과 가능 |
| ALTER | `board_cells.original_cell_id`, `original_mission_snapshot`(jsonb), `edited_at`(timestamptz) | 적용 완료 |
| UPDATE | backfill: `board_kind='custom'` -> `customization_status='edited'` | 현재 원격 custom board 0건 |
| CREATE TABLE | `mission_badges`, `board_badges`, `user_badges` | 적용 완료 |
| RLS | 3개 테이블 enable + select 정책 | 적용 완료, `auth.uid()`는 `(select auth.uid())` 형태 |
| FUNCTION | `award_board_badges(uuid, uuid, text[])` security definer | 적용 완료, `service_role` 전용 |
| SEED | `mission_badges` 47행 (sheet.json, free 제외) | `catalog_version='api-migration-v1'` |

## 적용 후 검증 결과

| 검증 | 결과 |
| --- | --- |
| migration history | `bingo_editable_badges`, `bingo_badge_fk_indexes`, `fix_award_board_badges_conflict_targets` 적용 확인 |
| 신규 객체 존재 | 3개 table, 4개 column, RPC, 3개 policy 모두 존재 |
| RLS | `mission_badges`, `board_badges`, `user_badges` 모두 enabled |
| table privilege | `service_role`만 신규 3개 table privilege 보유. `public`/`anon`/`authenticated` 직접 table privilege 없음 |
| function privilege | `award_board_badges` execute는 `service_role`만 보유 |
| seed | 47행, free 0행, active 47행, easy 45행, medium 2행, hard 0행 |
| policies | `mission_badges_select_active` role `{authenticated}`, `board_badges_select_own` / `user_badges_select_own` role `{authenticated}` |
| service-role REST | `mission_badges` count 47 조회 성공 |
| service-role RPC | `award_board_badges` 빈 `p_badge_ids` 호출 성공, 0행 반환 |
| anon direct table | `mission_badges` 직접 조회 실패(의도한 차단) |
| anon RPC | `award_board_badges` permission denied 42501(의도한 차단) |
| local tests | `pnpm test` 10 files / 98 tests passed |
| local lint/build | `pnpm lint`, `pnpm build` passed |

## 적용 중 반영한 보완 사항

### 1. Table privilege / Data API 노출 정책 결정

현재 원격 프로젝트의 `public` schema default ACL은 `anon`, `authenticated`, `service_role`에 대해 새 table에 광범위한 권한(`arwdDxtm`)을 줄 수 있는 상태다. 기존 `boards`, `board_cells`, `photos`, `clips`, `profiles`, `shares`, `user_consents`도 `anon/authenticated/service_role`에 넓은 table privilege가 부여되어 있다.

Supabase 공식 RLS 문서는 exposed schema(`public` 기본값)에 raw SQL로 table을 만들 때 RLS를 enable하고 Postgres role별 필요한 권한만 grant하라고 안내한다. 또한 2026-04-28 changelog 기준 신규 table은 Data/GraphQL API에 자동 노출되지 않는 변경이 있어, Dashboard Data API 설정과 table privilege를 migration에서 명시적으로 다루는 편이 안전하다.

현재 코드 기준 badge API는 Nest API 서버가 `SUPABASE_SERVICE_ROLE_KEY`로 Supabase를 조회/쓰기한다. 브라우저/모바일 클라이언트가 새 badge table을 Supabase Data API로 직접 조회하는 경로는 이 repo 기준 확인되지 않았다.

적용 결정:

- v1은 backend API 전용으로 적용했다.
- `0006`에서 신규 3개 table에 대해 `public`/`anon`/`authenticated` 권한을 명시적으로 revoke했다.
- `service_role`에만 read/write 권한을 명시 grant했다.

적용된 방향:

```sql
revoke all on table public.mission_badges, public.board_badges, public.user_badges
  from public, anon, authenticated;
grant select, insert, update, delete on table public.mission_badges, public.board_badges, public.user_badges
  to service_role;
```

### 2. 신규 RLS 정책 표현식 보완

원격 performance advisor는 기존 정책 다수에서 `auth.uid()`가 row마다 재평가될 수 있다고 경고한다. `0006`의 신규 정책은 기존 경고를 늘리지 않도록 아래처럼 `(select auth.uid())` 형태로 작성했다.

```sql
create policy board_badges_select_own on public.board_badges
  for select using ((select auth.uid()) = user_id);

create policy user_badges_select_own on public.user_badges
  for select using ((select auth.uid()) = user_id);
```

`mission_badges_select_active`는 `auth.uid()`를 쓰지 않으므로 해당 경고와 무관하다.

### 3. `security definer` RPC 노출 방식 확정

`award_board_badges`는 현재 migration에서 `public` schema의 `security definer` 함수로 작성되어 있고, `public`/`anon`/`authenticated` execute revoke 후 `service_role`만 grant한다. 기존 `confirm_user_photo_upload`/`confirm_user_clip_upload`도 같은 패턴이지만, Supabase 보안 가이드는 `security definer` 함수를 exposed schema에 두지 말 것을 권장한다.

이 작업에서는 코드가 `supabase-js` `.rpc('award_board_badges')`를 호출하므로, source 변경 없이 public RPC + strict revoke/grant 패턴을 유지했다. 적용 후 function execute privilege는 `service_role` 전용으로 확인했다. 장기적으로는 private schema RPC 또는 DB 전용 호출 경로로 옮기는 별도 작업을 고려한다.

### 4. Catalog seed 결정 (확정)

참조 파일: `/Users/oksang/Desktop/sappeun/sappeun-frontend/apps/mobile/assets/data/sheet.json` (`version = 1.3.0`, 48 cells).

- seed ID/라벨은 sheet.json v1.3.0과 일치한다.
- `self` 9개 중 `sf01`~`sf05`, `sf08`, `sf09`는 `easy`, `sf06`, `sf07`은 `medium`으로 sheet.json에 명시되어 있다.
- `nature/manmade/animal/time/color` 카테고리의 non-self mission 38개는 sheet.json에 `difficulty`가 없으므로 v1 seed에서는 `easy`로 확정한다.
- `grade_label` / `grade_color`는 v1 seed 값으로 확정한다: `easy` = `일상 배지` / `#6ED6A0`, `medium` = `도전 배지` / `#F5A623`, `hard` = `탐험 배지` / `#E05353`.
- 향후 제품/디자인에서 per-mission difficulty 또는 grade 색상을 바꾸면 적용 완료된 `0006`을 수정하지 말고 `0007_*` catalog 보정 migration으로 처리한다.

## 원격 Advisors 현재 기준선

적용 전 advisor 결과에는 기존 객체 관련 경고가 이미 있다. `0006` 적용 후 신규 객체 관련 경고와 기존 경고를 구분해서 판단한다.

Security advisor 현재 기준선:

- INFO: `guest_clip_uploads`, `guest_photo_uploads` RLS enabled but no policies
- ERROR: `public.shared_board_view` security definer view
- WARN: `public.set_updated_at`, `public.require_current_consents_for_signup` mutable search_path
- WARN: Auth leaked password protection disabled

Performance advisor 현재 기준선:

- INFO: 일부 foreign key 미인덱스
- WARN: 기존 RLS 정책의 `auth.uid()` initplan 경고 다수
- INFO: 일부 unused index

`0006` 완료 기준은 "advisor가 완전히 0건"이 아니라, **신규 badge/editable mission 객체 때문에 새로운 ERROR/WARN이 추가되지 않았는지**와 **추가된 경우 보정 migration을 만들지**다.

## 작업 절차

### 0. 선행 조건

- [x] `.env`가 대상 프로젝트와 일치하는지 재확인: `SUPABASE_URL`은 `https://wtptvgxyqkqqsfkdsoox.supabase.co`.
- [x] `SUPABASE_ANON_KEY`는 publishable key format임을 확인.
- [x] `SUPABASE_SERVICE_ROLE_KEY`는 값 출력 없이 smoke에만 사용.
- [ ] Supabase CLI 설치: 로컬에는 아직 없음. 이번 원격 적용은 Supabase MCP로 수행.
- [ ] CLI 버전 확인/link: 이번 적용 경로에서는 미수행.

### 1. 적용 전 migration 수정/리뷰

- [x] §적용 중 반영한 보완 사항 1~3을 `0006_bingo_editable_badges.sql`에 반영했다.
- [x] table privilege 전략을 migration SQL에 명시했다.
- [x] 신규 RLS 정책의 `auth.uid()` 표현식을 `(select auth.uid())` 형태로 보완했다.
- [x] `award_board_badges` public RPC 유지 여부와 그 사유를 migration 주석/스냅샷에 남겼다.
- [x] Catalog seed v1 값을 확정한다.
- [x] `0006` SQL 구문, `do $$` constraint guard, RLS, revoke/grant, seed `on conflict`를 최종 리뷰했다.
- [x] backfill UPDATE가 현재 원격에서는 no-op임을 반영했고, 적용 직전 `custom` board 수와 title 길이를 다시 확인했다.

### 2. 로컬 검증 적용 (권장 선행)

- [ ] Docker/Supabase CLI 로컬 검증은 미수행(로컬 CLI 미설치).
- [x] 대신 원격 SQL/REST/RPC smoke와 repo test/lint/build로 검증했다.

### 3. 원격 적용

- [x] Supabase MCP `list_migrations`로 원격 상태를 확인했다.
- [x] Supabase CLI 대신 Supabase MCP `apply_migration`으로 적용했다.
- [x] 적용 직전 read-only SQL로 `0006` 객체 미존재를 재확인했다.
- [x] 적용 후 migration history를 확인했다.

### 4. 적용 후 검증

- [x] `list_migrations`에서 대응 migration 3개 적용 확인.
- [x] 신규 객체 존재 확인:
  - `public.mission_badges`
  - `public.board_badges`
  - `public.user_badges`
  - `public.boards.customization_status`
  - `public.board_cells.original_cell_id`
  - `public.board_cells.original_mission_snapshot`
  - `public.board_cells.edited_at`
  - `public.award_board_badges(...)`
- [x] 신규 table RLS enabled 확인.
- [x] 신규 policies 확인:
  - `mission_badges_select_active`
  - `board_badges_select_own`
  - `user_badges_select_own`
- [x] table privilege 확인:
  - backend API 전용이면 `anon`/`authenticated`에 write privilege가 없어야 한다.
  - 클라이언트 direct read 허용이면 `authenticated select`만 의도대로 있어야 한다.
- [x] RPC 권한 확인: `award_board_badges` execute 권한이 `service_role`에만 있고 `public`/`anon`/`authenticated`에는 없음.
- [x] seed 수량 확인: `select count(*) from public.mission_badges where catalog_version='api-migration-v1';` -> 47.
- [x] free/center cell 미포함 확인.
- [x] Advisors 실행: 신규 badge FK 미인덱스 INFO는 `0007`로 보정. 이후 신규 badge 인덱스는 unused INFO만 남음(신규 테이블이라 expected).
- [x] API smoke:
  - service-role catalog count 47 확인.
  - service-role 빈 RPC 호출 성공.
  - anon direct catalog/RPC 차단 확인.
  - 실제 official board close는 API 서버/인증 토큰 필요로 미수행.
- [x] `supabase/SCHEMA_SNAPSHOT.md`를 적용 결과와 맞게 갱신했다.

### 5. 멱등성 / 동시성 실DB 확인 (권장)

코드 테스트는 mock 기반이라 RPC의 실제 원자성은 실DB에서 별도 확인한다.

- [ ] 동일 user의 서로 다른 official board 2개가 같은 mission badge를 지급할 때 `user_badges.earned_count == 2`인지 확인한다.
- [ ] 같은 board에 대한 동시/중복 close에서 `board_badges` 중복 없음, `earned_count` 재증가 없음이 유지되는지 확인한다.

## 적용 전 read-only SQL probes

기존 데이터 안전성:

```sql
select
  count(*) as boards_total,
  count(*) filter (where board_kind = 'custom') as custom_boards,
  count(*) filter (where board_kind = 'mission') as mission_boards,
  count(*) filter (where board_kind is null) as null_board_kind,
  count(*) filter (where title is not null and char_length(title) > 24) as titles_over_24,
  max(char_length(title)) filter (where title is not null) as max_title_length
from public.boards;
```

`0006` 객체 존재 여부:

```sql
with expected_tables(name) as (
  values ('mission_badges'), ('board_badges'), ('user_badges')
), expected_columns(table_name, column_name) as (
  values
    ('boards', 'customization_status'),
    ('board_cells', 'original_cell_id'),
    ('board_cells', 'original_mission_snapshot'),
    ('board_cells', 'edited_at')
)
select 'table' as kind, name as object_name,
       (to_regclass('public.' || name) is not null)::text as status
from expected_tables
union all
select 'column' as kind, table_name || '.' || column_name as object_name,
       exists (
         select 1 from information_schema.columns
         where table_schema = 'public'
           and table_name = expected_columns.table_name
           and column_name = expected_columns.column_name
       )::text as status
from expected_columns
order by kind, object_name;
```

Table privilege 확인:

```sql
select grantee, table_name, string_agg(privilege_type, ',' order by privilege_type) as privileges
from information_schema.role_table_grants
where table_schema = 'public'
  and grantee in ('anon', 'authenticated', 'service_role')
  and table_name in ('mission_badges', 'board_badges', 'user_badges')
group by grantee, table_name
order by table_name, grantee;
```

## 롤백 계획

- `0006`은 신규 객체 생성 + 컬럼 추가 + 1회성 backfill이라 기존 데이터 삭제는 없다.
- 운영에 적용된 migration 파일은 사후 수정하지 않는다. 문제 발생 시 새 forward-fix migration으로 보정한다.
- backfill(`custom` -> `edited`)을 되돌리려면 후속 migration에서 명시적 UPDATE로 복구한다.
- 신규 table 제거가 필요하면 후속 migration에서 `drop table ... cascade`를 사용한다. 단, `board_badges`/`user_badges`에 운영 데이터가 쌓인 뒤에는 백업/보존 정책을 먼저 결정한다.
- 권한 문제가 원인이면 table/function grant만 보정하는 후속 migration을 우선 고려한다.

## 리스크

- Catalog seed drift: v1 seed는 sheet.json v1.3.0 기준이며, non-self 38개 difficulty는 `easy`로 기본 확정했다. 향후 제품/디자인에서 난이도/색을 재정의하면 `0007_*` catalog 보정 migration이 필요하다.
- default ACL 과다 grant: 신규 badge table은 `0006`에서 명시적으로 revoke/grant를 적용했지만, 향후 public table 추가 시 같은 명시 권한 전략을 유지해야 한다.
- Data API 노출 정책 drift: Supabase의 신규 table 자동 노출 정책이 바뀌었으므로 Dashboard Data API 설정과 SQL grant를 둘 다 확인해야 한다.
- 신규 RLS 성능 경고: 기존 정책과 같은 `auth.uid()` 직접 호출을 반복하면 advisor 경고가 늘 수 있다.
- Public security definer RPC: 기존 repo 패턴과는 맞지만 Supabase 보안 권고와 긴장이 있다. strict revoke/grant 및 advisor 검증이 필수다.
- Catalog drift: sheet.json mission이 늘면 seed가 누락될 수 있다. seed coverage 테스트(`badges.service.spec.ts`)가 로컬에서 이를 잡지만 CI에서는 sibling repo 부재 시 skip될 수 있다.
- CLI/Docker 환경: 로컬 적용은 Docker와 Supabase CLI가 필요하다. 미가용 시 원격 직접 적용 또는 Dashboard SQL editor 수동 실행이 가능하지만, migration 이력과 어긋날 수 있어 권장하지 않는다.

## 체크리스트 (요약)

- [ ] Supabase CLI 설치 + `link --project-ref wtptvgxyqkqqsfkdsoox`
- [ ] table privilege 전략 확정 후 `0006` grant/revoke 보완
- [ ] 신규 RLS 정책 `(select auth.uid())` 형태로 보완
- [ ] public `security definer` RPC 유지 사유와 검증 기준 확정
- [x] Catalog seed v1 결정 반영
- [ ] 로컬 `migration up` 또는 `db reset` 검증
- [ ] 원격 `db push` 또는 `migration up --linked` 적용
- [ ] migration list / 신규 객체 / RLS / table grant / RPC grant / seed count 검증
- [ ] Advisors 기준선 대비 신규 경고 확인
- [ ] official board close smoke + 멱등성 실DB 확인
- [ ] `SCHEMA_SNAPSHOT.md` 일치 확인

## 완료 기준

- `0006`이 대상 Supabase 인스턴스(원격, 필요시 로컬)에 적용됨.
- 신규 3개 table/컬럼/RPC가 존재하고 RLS, table grant, function grant가 명시적으로 의도한 상태임.
- `mission_badges` seed가 sheet.json v1.3.0 기준 v1 결정값으로 들어감.
- official board close가 badge를 멱등하게 지급함.
- 동일 badge의 cross-board 지급에서 `earned_count`가 원자적으로 증가함.
- 적용 후 Advisors에서 신규 badge/editable mission 객체 관련 차단급 security/performance 경고가 없음.
- migration 이력과 `supabase/SCHEMA_SNAPSHOT.md`가 일치함.
