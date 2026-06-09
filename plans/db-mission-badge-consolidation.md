# 미션·배지 DB 정합성 개선 기획서

- 상태: **draft 기획서 — pending approval** (RALPLAN 합의 검토 반영 v2)
- 작성일: 2026-06-10 (v2 고도화: 2026-06-10)
- 작성 기준: 운영 Supabase 프로젝트 `wtptvgxyqkqqsfkdsoox` 실측 (service-role REST 조회) + 마이그레이션/코드 정적 분석
- 범위: Supabase DB 스키마, 미션/배지 정체성 모델, NestJS API 영향, 시드 제너레이터, 테스트
- 관련 문서:
  - `plans/runtime-mission-badge-artwork-api-db.md` (runtime artwork contract)
  - `supabase/SCHEMA_SNAPSHOT.md` (Phase 0 진단)

> **v2 개정 요약 (합의 검토 반영)**: ① 배지 획득 참조를 `(catalog_version, mission_id)` composite FK → **`mission_id` 앵커(version-agnostic)** 로 변경해 DEC-4 위반 제거 (M1). ② RPC를 시그니처 변경이 아니라 **in-place `create or replace` body-only** 로 (M2). ③ `0014`가 폐지 대상 `mission_badges`/`count`를 직접 INSERT하는 충돌과 **제너레이터 선결 재작성** 명문화 (C1). ④ **사전 부검·확장 테스트 매트릭스·단계별 롤백·ADR** 신설 (M3). ⑤ difficulty "정본 충돌" 문구를 실측(0충돌)에 맞게 정정 (m1). ⑥ 0019 count 뷰는 런타임 소비처 없음 → **선택/디스코프** (m3).

---

## 0. 결정 사항 요약 (이해관계자 합의)

| # | 결정 | 내용 |
|---|---|---|
| DEC-1 | **파괴적 재설계 허용** | 현 DB의 boards 74 / user_badges 8건은 개발·테스트 데이터. 컬럼 drop, 테이블 통합, 식별자 변경 허용. **단, repo 관례(0001 baseline + forward chain)를 유지**한다(§7 Opt-C). |
| DEC-2 | **배지 테이블 흡수** | `mission_badges` 테이블을 폐지하고 미션 = 단일 정본(`mission_content`)으로 통합한다. "배지"는 미션의 보상 속성으로 표현한다. |
| DEC-3 | **등급 표시 파생** | `grade_label`·`grade_color`는 저장하지 않고 `difficulty`에서 파생한다. |
| DEC-4 | **배지 현재값 추종 유지** | 획득한 배지(`user_badges`)는 미션 메타 변경 시 현재값을 추종한다. 획득 시점 박제(snapshot)는 하지 않는다. **→ 배지 정체성은 버전 비종속(`mission_id`)이어야 한다(§4.3).** |

추가 확정: Q-A `badgeId`→`mission_id`, Q-B `mission_categories.count` 파생, Q-C 0014 별도 진행.

---

## 1. 배경 / 문제 제기

미션과 배지가 별도 테이블로 진화하면서 **미션 정체성(제목·카테고리·난이도)이 여러 곳에 중복 저장**되고, **미션과 배지의 책임 경계가 모호**해졌다. 그 결과:

- 미션 정체성(제목·카테고리)이 `mission_content`와 `mission_badges`에 **이중 저장**되고, 배지 쪽 컬럼은 API가 더 이상 읽지 않는 **좀비 컬럼**이 되었다.
- `difficulty`는 `mission_content`가 `null=easy`로 암묵 표현하고 코드가 `?? 'easy'`로 메운다. **현재 값 불일치는 없으나(실측 0건)**, 진실의 표현이 두 곳으로 쪼개진 취약 구조다.
- 신규 미션 추가(`0014`, 102개)마다 미션·배지 양쪽 시드를 동기화해야 하는 운영 부담이 누적된다. (실제로 `0014`는 `mission_content`·`mission_badges`·`mission_categories.count`를 한 번에 INSERT한다 — §2.4)

본 기획서는 실측 데이터로 문제를 정량 확인하고, 단일 정본 모델로 정리하는 목표 스키마·마이그레이션·테스트·롤백을 정의한다.

---

## 2. 현황 진단 (실측)

### 2.1 테이블 현황 (라이브 DB, `0014` 미적용)

```
mission_content   : 48 rows  (free 포함, catalog_version='api-migration-v1')
mission_badges    : 47 rows  (free 제외)
mission_categories: 7 rows   (count 하드코딩)
boards            : 74 rows
user_badges       : 8 rows   (badge_id = 'mission:<id>:v1')
board_badges      : boards 종속
미적용 migration  : 0014 (신규 미션 102개 — mission_content + mission_badges + count 동시 INSERT)
```

### 2.2 핵심 문제 (P1–P6)

#### P1. 미션 제목·카테고리·난이도의 다중 저장

| 위치 | 컬럼/형태 | 역할 | 비고 |
|---|---|---|---|
| `mission_content` | `label`, `category`, `difficulty` | **API 정본** | `getMissionContent`/배지 조회가 읽음 |
| `mission_badges` | `title`, `category`, `difficulty` | **죽은 중복(좀비)** | API 미사용. `0011` 주석이 "drop 예정" 명시 |
| `board_cells.mission_snapshot` | jsonb | 게임플레이 박제 | **정당한 분리** (§2.3) |
| `src/missions/sheet.source.json` | 시드 소스 | 빌드 타임 입력 | **정당한 분리** (§2.3) |

코드 증거 — 배지 응답은 `mission_badges.title`이 아니라 조인된 `mission_content.label`을 읽는다(`src/badges/badges.service.ts`): `title: content.label`, `difficulty: effectiveDifficulty(content)`. → `mission_badges.title`/`category`/`difficulty`는 **아무도 읽지 않는 좀비 컬럼**.

#### P2. difficulty 표현 방식 이원화 (현재 값 불일치 0건, 구조적 취약성)

| | null | easy | medium | hard |
|---|---|---|---|---|
| `mission_content.difficulty` | **28** | 7 | 10 | 3 |
| `mission_badges.difficulty` | 0 | 34 | 10 | 3 |

- `mission_content`는 **easy를 `null`로 암묵 표현**(28건), `mission_badges`는 **easy를 명시**.
- **실측 교차검증 결과**: 두 테이블의 `mission_id`별 difficulty는 `null→easy` 적용 시 **불일치 0건**이다. content의 명시 medium(10)/hard(3)와 badge의 medium(10)/hard(3)가 `0009` 시드 동기화로 정확히 일치하며, content의 명시값과 충돌하는 badge 행은 **0건**이다.
- 즉 위험은 "현재 데이터가 깨져 있다"가 아니라 **"같은 사실을 두 곳이 다른 규칙으로 표현해, 한쪽만 바꾸면 미래에 깨질 수 있다"** 는 구조적 취약성이다.

> 조치: `null=easy` 암묵 규칙을 제거하고 `not null default 'easy'`로 명시화(0015). backfill은 `null→'easy'`(28건)이며 값 충돌이 없으므로 안전하다. 다만 **drop 직전 방어적 검증 게이트**(content와 badge가 어긋나면 `raise exception`)를 두어 가정이 깨진 상태로 진행되는 것을 차단한다(§5 0015, §13 PM-2).

#### P3. `grade_label`·`grade_color`는 난이도의 순수 파생값

```
easy → 일상 배지 / #6ED6A0 (34)   medium → 도전 배지 / #F5A623 (10)   hard → 탐험 배지 / #E05353 (3)
```

difficulty → 등급 매핑이 **100% 결정적**. 저장 시 `0009`처럼 난이도 변경마다 등급을 수동 동기 UPDATE해야 한다. (DEC-3: 파생 전환)

#### P4. `mission_badges.artwork` override 미사용

`mission_content.artwork` 48/48 채워짐, `mission_badges.artwork` **0/47**. override 분기는 복잡도만 추가 → 배지 흡수 시 자연 소멸.

#### P5. `catalog_version` 박제 정책이 코드 주석에만 존재

`badges.service.ts:457-465`는 획득 배지를 **`catalog_version` 무시하고 id로만 조회**한다(주석: "신규 catalog_version으로 superseded돼도 historically-earned badge가 렌더되도록 — active/version 필터 추가 금지"). 즉 **DEC-4의 "현재값 추종"은 이미 cross-version 동작을 코드로 보장**하고 있다. 이 seam을 스키마 설계가 깨뜨리지 않아야 한다(§4.3에서 핵심 제약).

#### P6. 식별자 이원화

- `mission_badges.id` = `"mission:n01:v1"` — mission_id+버전 문자열 재인코딩, `UNIQUE(catalog_version, mission_id)`와 중복.
- `artwork_key` = `"mission/n01"` — runtime artwork 도입 후 legacy.
- `board_badges.badge_id`/`user_badges.badge_id` = `text FK → mission_badges(id)` — 합성 문자열 종속.

### 2.3 문제가 아닌 것 (정당한 분리 — 손대지 않음)

- **`board_cells.mission_snapshot` (jsonb)**: 보드 생성 시점 미션 박제. 셀 편집(`original_mission_snapshot`)·커스텀 미션(`"id":"custom:…"`) 때문에 게임 기록은 카탈로그 현재값과 독립이어야 한다. **의도된 불변 스냅샷.** 단, `awardBoardBadges`가 `cell.mission_snapshot.id`를 mission_id 출처로 쓰므로(§4.5 불변식), snapshot.id는 살아있는 `mission_content.mission_id`로 해소돼야 한다.
- **`src/missions/sheet.source.json`**: DB 시드 생성용 **빌드 타임 입력**. 런타임 정본이 아니다.

### 2.4 ⚠️ `0014`의 폐지 대상 직접 INSERT (실측 확정, 차단 이슈)

`0014_bingo_mission_expansion.sql`은 **미적용** 상태이며, `mission_content`(102) 외에:
- L138 `insert into public.mission_badges (...)` — **폐지 대상 테이블에 합성키 102건**(`mission:n09:v1` …)
- L256 `insert into public.mission_categories (... count)` — **파생 전환 대상 count 덮어쓰기**

를 함께 수행한다. 또한 제너레이터 `scripts/gen-mission-expansion-seed.mjs`(L480 부근)가 여전히 `mission_badges` INSERT를 emit한다. → `0014`를 **그대로 재실행/적용하면 폐지된 구조를 부활**시킨다. 본 정리는 §5 도입부의 선결 처리를 강제한다.

---

## 3. 설계 원칙

1. **단일 정본**: 미션 정체성은 `mission_content` 한 곳에만.
2. **파생 over 저장**: 등급·카운트는 코드/뷰로 파생.
3. **명시적 표현**: `difficulty`의 `null=easy` 암묵 제거 → `not null default 'easy'`.
4. **불변 레이어 보존**: `board_cells` 스냅샷·`sheet.source.json` 시드는 유지.
5. **배지 참조는 버전 비종속 자연키(`mission_id`)로**: 합성 문자열 ID를 제거하되, **`catalog_version`을 배지 PK/FK에 넣지 않는다**(DEC-4 보존 — §4.3).
6. **스키마 변경과 API 배포의 원자성**: RPC body·select 변경은 같은 릴리스로 동시 배포(무중단 불요 — DEC-1).
7. **변환은 drop 전에, 단일 트랜잭션·검증 게이트로**: 데이터 손실 0.

---

## 4. 목표 스키마

### 4.1 `mission_content` — 미션 단일 정본

| 컬럼 | 변경 | 비고 |
|---|---|---|
| `mission_id`, `catalog_version` | 유지 (PK) | |
| `mission_id` | **`unique` 제약 추가** | 단일버전 불변식. 배지 FK 타깃(§4.3). 멀티버전 도입 시 §7에서 해소 |
| `label`, `category`, `hint`, `caption`, `capture_label` | 유지 | 미션 copy |
| `icon`, `variant`, `camera`, `text_only`, `font_size`, `swatch`, `swatch_label`, `no_photo`, `fixed_position` | 유지 | legacy renderer cue (§8) |
| `difficulty` | **`text not null default 'easy'`** | null 28건 → `'easy'` 백필 |
| `artwork` | 유지 | ArtworkSpec v1 정본 |
| `awards_badge` | **신규 `boolean not null default true`** | 배지 발급 대상 여부. `free`/`special`=`false` |
| gate 컬럼 (`min_app_build`, `required_capabilities`, `active_from`, `active_until`) | 유지 (0013) | |
| `sort_order`, `active`, `created_at` | 유지 | |

흡수 후 **사라지는 것**: `mission_badges`의 `title`/`category`/`difficulty`(중복)·`grade_label`/`grade_color`(파생)·`artwork`(미사용)·`artwork_key`(legacy)·`id`(합성키).

> **경계 명시 (M1 후속, awards_badge "camel's nose")**: `awards_badge`는 "이 미션이 배지를 발급하는가"라는 **미션의 속성**이므로 `mission_content`에 둔다. 그러나 배지 고유 정책(쿨다운/포인트/시즌 등 미션과 무관한 보상 규칙)이 추가로 필요해지면, `mission_content`에 더 얹지 말고 **별도 `badge_policy` 관심사로 분리**한다. 이번 범위에서는 `awards_badge` 단일 플래그까지만 흡수한다.

### 4.2 배지 등급 파생 (저장 안 함)

```ts
// src/badges/badge-grade.ts (신규)
export const BADGE_GRADE = {
  easy:   { label: '일상 배지', color: '#6ED6A0' },
  medium: { label: '도전 배지', color: '#F5A623' },
  hard:   { label: '탐험 배지', color: '#E05353' },
} as const
```

### 4.3 배지 획득 참조 재설계 — **`mission_id` 앵커 (version-agnostic)**

`mission_badges` 폐지로 `badge_id text → mission_badges(id)` FK를 교체한다. **핵심 제약**: DEC-4(현재값 추종) + 기존 cross-version seam(P5)을 보존하려면 **`catalog_version`을 배지 PK/FK에 넣어선 안 된다**. composite `(catalog_version, mission_id)` FK는 획득 배지를 *획득 당시 버전에 고정*해, 멀티버전 도입 시 박제가 되어 DEC-4를 위반하고 `badges.service.ts:457-465` seam을 회귀시킨다.

```sql
-- mission_content: 배지 FK 타깃을 위한 단일버전 불변식
alter table public.mission_content add constraint mission_content_mission_id_key unique (mission_id);

-- user_badges (재설계): mission_id 앵커
create table public.user_badges (
  user_id          uuid not null references auth.users(id) on delete cascade,
  mission_id       text not null references public.mission_content (mission_id)
                     on update cascade on delete restrict,
  earned_catalog_version text,   -- 획득 당시 활성 버전(감사용 메타, 비권위·비FK)
  first_board_id   uuid references public.boards(id) on delete set null,
  last_board_id    uuid references public.boards(id) on delete set null,
  first_earned_at  timestamptz not null default now(),
  last_earned_at   timestamptz not null default now(),
  earned_count     integer not null default 1 check (earned_count >= 1),
  primary key (user_id, mission_id)
);
-- board_badges도 동일 원칙: pk (board_id, mission_id), fk mission_id → mission_content(mission_id)
--   기존 earned_at 컬럼은 유지(드롭 대상은 badge_id 뿐). getBoardBadges/RPC가 earned_at을 쓴다.
```

- **DEC-4 정합**: 획득 기록은 `mission_id`만 참조. 제목/난이도/등급/아트워크는 조회 시 현재 활성 `mission_content`를 조인해 읽는다. 버전이 바뀌어도 같은 `mission_id` 행으로 자연 추종한다.
- `earned_catalog_version`은 **감사용 정보**일 뿐 권위 없음(박제 아님). 불필요하다고 판단되면 생략 가능.
- 합성 문자열 `badge_id`("mission:n01:v1") 폐지. 기존 8건은 0017에서 `split_part(badge_id,':',2)` → `mission_id` 변환 후 검증 게이트 통과.
- **멀티버전 한계 명시**: `unique(mission_id)`는 동일 `mission_id`를 두 번째 `catalog_version`으로 넣는 것을 DB에서 금지하는 **명시적 단일버전 불변식**이다. 멀티버전이 실제로 필요해지면 §7 Opt에 따라 안정 `missions` 정체성 테이블을 도입하는 후속 마이그레이션으로 해소한다. (현재 `catalog_version`은 단일 상수 `api-migration-v1` — `missions.constants.ts`)

> **결정(Q-A 확정)**: API 응답 `badgeId`를 **`mission_id`로 단순화**(`"mission:n01:v1"` → `"n01"`). 클라이언트 deep-link 키도 `mission_id` 기준으로 동반 수정(§8). 합성 문자열은 응답·DB 어디에도 남기지 않는다.

### 4.4 `award_board_badges` RPC — **시그니처 유지, body만 변경 (M2)**

PostgreSQL은 함수 오버로드를 인자 **타입**으로 구분한다. `p_badge_ids text[]`와 `p_mission_ids text[]`는 **동일 시그니처 `(uuid,uuid,text[])`** 이므로 "신구 병존"은 불가능하고 파라미터명 변경은 의미가 없다.

- **방침**: `create or replace function award_board_badges(uuid, uuid, text[])`로 **시그니처를 그대로 두고 body만** 변경한다. `text[]` 페이로드의 의미를 `mission_id[]`로 재해석하고, insert/`on conflict`를 새 PK(`(board_id, mission_id)`, `(user_id, mission_id)`) 기준으로 작성한다.
- 호출부 `badges.service.ts`는 `badgeIds`(합성키) 대신 `missionIds`를 같은 `text[]` 슬롯으로 전달한다. **RPC와 호출부는 같은 릴리스로 원자 배포**한다(무중단 불요, DEC-1·원칙 6).
- `security definer` + `revoke all from public,anon,authenticated; grant execute to service_role`을 **replace 후 재적용**한다(replace가 grant를 보존하지 않는 경로 대비).
- idempotency 유지: 동일 보드 재호출 시 `board_badges` 충돌 → `user_badges` rollup 미발생 → `earned_count` 불변.
- **`on conflict` 형식 유지**: `0008`이 ambiguity 회피를 위해 명명 제약 타깃(`on conflict on constraint board_badges_pkey` / `user_badges_pkey`)을 쓴다. body 재작성 시 컬럼 리스트 형으로 바꾸지 말고 **명명 제약 형을 유지**한다(0017에서 PK를 같은 이름으로 재생성하므로 유효).

### 4.5 불변식 (Invariants)

- **INV-1**: `awardBoardBadges`가 읽는 `cell.mission_snapshot.id`는 살아있는 `mission_content.mission_id`(또는 `custom:`/free)로 해소돼야 한다. 해소 실패 시 해당 셀은 배지 발급에서 **조용히 제외**된다(현행 동작 유지) — 이를 §13 PM-1 위험으로 추적한다.
- **INV-2**: 배지를 발급하는 미션은 `awards_badge=true`이며, 발급 배지 수 = `count(mission_content where awards_badge=true and active=true)`.

---

## 5. 마이그레이션 계획 (forward chain, §7 Opt-C)

> **선결 처리 (CRITICAL, §2.4 / C1)**
> `0014`는 폐지 대상 `mission_badges`/`count`를 직접 INSERT한다(미적용). 본 정리 적용 전에:
> 1. `scripts/gen-mission-expansion-seed.mjs`를 **`mission_content`-only**(no `mission_badges`, no `mission_categories.count`, `awards_badge` 추가)로 재작성한다.
> 2. 기존 `0014_bingo_mission_expansion.sql`은 **현 형태로 적용 금지**(retired). 신스키마로 재생성한 버전을 §8에 따라 **별도 배치로** 적용한다(Q-C).
> 3. `scripts/gen-mission-seed.mjs`(0010 생성기)도 `mission_categories.count` emit 제거 + `mission_content.awards_badge` emit 추가.
> 이 선결 작업이 끝나기 전 0018/0019를 적용하지 않는다.

각 마이그레이션 끝에는 스키마 변경 시 `notify pgrst, 'reload schema';`를 호출한다(0011/0012/0013/0014 관례).

### 0015 — difficulty 명시화 + 방어적 검증 게이트
```sql
-- 1) drop 직전 가정 검증: content와 badge가 어긋나면 즉시 중단 (PM-2)
do $$ begin
  if exists (
    select 1 from public.mission_content c
    join public.mission_badges b using (catalog_version, mission_id)
    where coalesce(c.difficulty,'easy') <> b.difficulty
  ) then raise exception 'difficulty drift between mission_content and mission_badges'; end if;
end $$;
-- 2) null=easy 암묵 제거 (28건, 값 충돌 0건)
update public.mission_content set difficulty = 'easy' where difficulty is null;
alter table public.mission_content
  alter column difficulty set default 'easy',
  alter column difficulty set not null;
notify pgrst, 'reload schema';
```

### 0016 — `awards_badge` 추가 + 백필
```sql
alter table public.mission_content add column awards_badge boolean not null default true;
update public.mission_content set awards_badge = false where category = 'special' or mission_id = 'free';
notify pgrst, 'reload schema';
```

### 0017 — 배지 획득 참조 자연키 전환 (단일 트랜잭션, drop 전 backfill+검증)
```sql
begin;
-- a) mission_content 단일버전 불변식
alter table public.mission_content add constraint mission_content_mission_id_key unique (mission_id);

-- b) 신규 컬럼 추가
alter table public.user_badges  add column mission_id text, add column earned_catalog_version text;
alter table public.board_badges add column mission_id text;

-- c) drop 전에 badge_id → mission_id backfill
update public.user_badges  set mission_id = split_part(badge_id, ':', 2),
                                earned_catalog_version = split_part(badge_id, ':', 3);
update public.board_badges set mission_id = split_part(badge_id, ':', 2);

-- d) 검증 게이트: 미해소(=mission_content에 없는) mission_id 있으면 rollback (PM-1)
do $$ begin
  if exists (select 1 from public.user_badges  u where u.mission_id is null
              or not exists (select 1 from public.mission_content m where m.mission_id = u.mission_id))
     or exists (select 1 from public.board_badges b where b.mission_id is null
              or not exists (select 1 from public.mission_content m where m.mission_id = b.mission_id))
  then raise exception 'badge_id→mission_id backfill incomplete or orphaned'; end if;
end $$;

-- e) 구 FK/PK/컬럼 제거 → 새 PK/FK 적용
alter table public.user_badges  drop constraint user_badges_pkey,  drop column badge_id;
alter table public.board_badges drop constraint board_badges_pkey, drop column badge_id;
alter table public.user_badges  alter column mission_id set not null,
  add constraint user_badges_pkey primary key (user_id, mission_id),
  add constraint user_badges_mission_fk foreign key (mission_id)
    references public.mission_content (mission_id) on update cascade on delete restrict;
alter table public.board_badges alter column mission_id set not null,
  add constraint board_badges_pkey primary key (board_id, mission_id),
  add constraint board_badges_mission_fk foreign key (mission_id)
    references public.mission_content (mission_id) on update cascade on delete restrict;

-- f) RLS/grant/인덱스 재적용 (테이블 구조 변경분; 0006/0007 패턴 복원)
--    user_badges_select_own / board_badges_select_own 정책, service_role grant,
--    user_badges_*_idx, board_badges_badge_idx → board_badges_mission_idx 등
-- g) award_board_badges body-only 재정의 (§4.4) + grant 재적용

commit;
notify pgrst, 'reload schema';
```
- **참고**: split_part 인덱스는 `'mission:<id>:v1'` 가정. 8건 모두 이 형태임을 적용 전 실측 확인(§11). 어긋나면 (d) 게이트가 트랜잭션을 롤백한다.

### 0018 — `mission_badges` 테이블 폐지
- 모든 참조 제거 확인 후 `drop table public.mission_badges;` → `notify pgrst, 'reload schema';`
- 선행: 0017이 배지 식별을 `mission_id`로 옮겼고, API/RPC/시드가 더 이상 `mission_badges`를 읽지 않음을 확인.

### 0019 (선택·디스코프 가능) — `mission_categories.count` 파생화
> **런타임 소비처 없음 주의**: `missions.service.ts`는 이미 `countVisibleCellsByCategory`로 가시 셀을 런타임 집계해 `mission_categories.count`를 **무조건 덮어쓴다**. 즉 content endpoint 응답에 stored `count`는 영향이 없다. 본 단계의 효과는 **시드 정적 count 드리프트 제거(위생)** 뿐이다. 0017/0018 critical path와 **분리**하며, 일정상 후순위로 미뤄도 무방하다.
```sql
alter table public.mission_categories drop column count;
create view public.mission_category_counts as
  select catalog_version, category as key, count(*)::int as count
    from public.mission_content where active = true and awards_badge = true
   group by catalog_version, category;
-- 뷰 권한: revoke all from public,anon,authenticated; grant select to service_role;
notify pgrst, 'reload schema';
```

> 순서: 선결(제너레이터) → 0015 → 0016 → **0017(핵심·검증 집중)** → 0018 → 0019(선택). 각 단계 후 테스트 그린 확인. **0014′(재생성)는 본 배치 분리**(Q-C, §8).

---

## 6. API · 코드 · 테스트 영향

| 파일 | 변경 |
|---|---|
| `src/badges/badges.service.ts` | catalog 조회를 `mission_content where awards_badge=true and active=true order by sort_order`로(=`mission_badges` 의존 제거). `grade_label/color` → `BADGE_GRADE[difficulty]` 파생. `artworkFor` override 분기 제거(`content.artwork`만). 획득 조회·award 결과 매핑을 `mission_id` 기준으로. `effectiveDifficulty`의 `?? 'easy'` 제거(difficulty not null). RPC 호출 `p_badge_ids`에 `missionIds` 전달 |
| `src/badges/badge-grade.ts` | **신규** 등급 파생 매핑 |
| `src/badges/badges.schemas.ts` | `gradeLabel`/`gradeColor` 응답 유지(파생). **`artworkKey` 응답 제거** (legacy, §8 프론트 동반). `badgeId`=mission_id |
| `src/missions/missions.service.ts` | `?? 'easy'` fallback 제거. (count 런타임 집계는 유지) |
| `src/badges/badges.controller.ts` | `:badgeId` 파라미터를 `mission_id`로 해석 |
| `scripts/gen-mission-seed.mjs` | `mission_categories.count` emit 제거, `mission_content.awards_badge` emit 추가 |
| `scripts/gen-mission-expansion-seed.mjs` | `mission_badges` INSERT 블록 제거, count 제거, `awards_badge` 추가 (0014′ 선결) |
| `supabase/SCHEMA_SNAPSHOT.md` | mission_badges 폐지·badge 테이블 재설계·count 뷰 반영 |
| **테스트** (§14) | `badges.service.spec.ts`(합성키·`from('mission_badges')` 전면), `badges.schemas.spec.ts`(`artworkKey` assert), `missions.service.spec.ts`(difficulty:null 픽스처), `mission-seed-parity.spec.ts`(badge seed·count assert), `mission-expansion-seed.spec.ts`(badge·count assert), `boards.service.spec.ts`(award 관련) |

**응답 호환**: `GET /v1/missions/content`·`GET /v1/badges/catalog`의 **필드명** 구조는 유지(`title`/`difficulty`/`gradeLabel`/`gradeColor`/`artwork`). 변경: `badgeId` 값 형식(`mission:n01:v1`→`n01`), `artworkKey` 필드 제거.

---

## 7. 대안 비교 (고도화 접근법 · 식별자 설계)

### 마이그레이션 형태
| Opt | 내용 | Pros | Cons | 채택 |
|---|---|---|---|---|
| A | 현 plan: forward 0015~0019 + RPC 시그니처 변경 + 0014 별도 | 관례적 append-only | RPC 시그니처 변경은 in-place라 "병존" 불가(M2), version-in-PK가 DEC-4 위반(M1) | ✗ |
| B | baseline rewrite (0001 + 0006~0014 squash) + 일회성 변환 | 중간 상태·게이트 소멸, 원자성 무료 | repo의 forward 관례·seed-parity 테스트 인프라 폐기, 단일 diff 과대 | ✗ |
| **C** | **forward chain 유지 + RPC body-only + version-agnostic FK + DB·API 동시 배포** | 관례·감사성·테스트 인프라 보존, M1·M2 동시 해결 | 중간단계 ceremony 일부 잔존(8건이라 저렴) | **✓** |

### 배지 식별자 (version-agnostic 실현 방법)
| 방법 | 내용 | 채택 |
|---|---|---|
| (a) 별도 `missions` 정체성 테이블 | mission_id PK 안정 테이블 + 버전별 content | 멀티버전 시 정석. **현재 소비처 없음 → YAGNI**, 후속으로 보류 |
| (b) 앱레벨 FK 느슨화 | 참조무결성 포기 | ✗ (무결성 손실) |
| **(c) `mission_id` 앵커 + `unique(mission_id)` 단일버전 불변식** | 현재 단일버전 현실에 맞춤, DEC-4 보존, 무결성 유지 | **✓ (§4.3)** |

### 향후
- **등급 매핑 테이블(`difficulty_grades`)**: 미션별 커스텀 등급색 필요 시 파생→참조 승격. 현재 YAGNI.
- **멀티버전 운영**: 실제 필요 시 (a) `missions` 테이블 도입 + `unique(mission_id)` 완화. DEC-4를 유지하려면 "현재 활성 버전 content 조인" 규칙을 그때 명문화.

---

## 8. 범위 외 / 동반 작업

범위 외:
- runtime artwork contract 자체(`plans/runtime-mission-badge-artwork-api-db.md`)
- legacy renderer cue 컬럼(`icon`/`swatch`) 제거 — runtime-artwork 100% 전환 후
- Flutter `assets/sheet.json` ↔ DB 이중 정본 종결
- **0014′ 재생성·적용 (Q-C)** — 제너레이터 재작성 후 `mission_content`-only로 재생성, `assets.sappeun.app` 도메인 검증 거쳐 별도 배치 적용
- 0014 아트워크 R2 업로드/도메인 검증

동반 작업 (프론트엔드, 필수 — 같은 릴리스로 묶음):
- `badgeId` `mission:n01:v1`→`n01` 단순화에 따른 배지 deep-link/상세 진입 키 수정
- **`artworkKey` 응답 필드 제거**에 따른 클라이언트 영향 점검(이미 `artwork` 사용 중이면 무해)

---

## 9. 확정된 결정

| ID | 결정 | 반영 |
|---|---|---|
| Q-A | `badgeId`→`mission_id` 단순화 (합성키 폐지, 프론트 동반) | §4.3, §6, §8 |
| Q-B | `mission_categories.count` 파생 뷰 (선택·디스코프 가능) | §5 0019 |
| Q-C | 0014(102개)는 별도 진행 (제너레이터 선결 재작성) | §5 선결, §8 |
| (M1) | 배지 식별 = `mission_id` 앵커(version-agnostic), `catalog_version` 비FK | §3-5, §4.3, §7 |
| (M2) | RPC 시그니처 유지·body-only·동시 배포 | §4.4 |

---

## 10. 수용 기준 (Acceptance Criteria)

1. 미션 제목·카테고리·난이도는 `mission_content`에만 저장된다. `mission_badges` 테이블이 존재하지 않는다.
2. `mission_content.difficulty`는 `not null`, `null` 행 0건. API에 `?? 'easy'` fallback 없음.
3. `grade_label`/`grade_color`는 DB 미저장, `difficulty`에서 파생.
4. `board_badges`/`user_badges`는 `mission_id`로 `mission_content`를 참조하며 PK/FK에 `catalog_version`이 없다(version-agnostic). 합성 `badge_id` 없음.
5. 기존 8건 `user_badges`가 손실 없이 변환·조회된다.
6. API 응답 `badgeId`는 `mission_id` 값(예: `"n01"`). 합성 문자열이 응답·DB 어디에도 없다.
7. 재설계된 `user_badges`/`board_badges`에 RLS 정책·service_role grant·FK 인덱스가 0006/0007과 동등하게 복원된다.
8. `award_board_badges`는 시그니처 `(uuid,uuid,text[])`를 유지하고 `mission_id` 기반으로 idempotent(재호출 시 `earned_count` 불변).
9. `GET /v1/badges/catalog`·`GET /v1/missions/content` 필드명 구조 호환(`badgeId` 값 형식·`artworkKey` 제거만 변경).
10. `0014`(미적용)와 시드 제너레이터가 `mission_badges`/`count`를 더 이상 생성하지 않는다.
11. (선택) `mission_categories.count`가 정적 저장이 아니라 집계 파생.

---

## 11. 검증

```sql
-- 적용 전: 8건 badge_id가 모두 'mission:<id>:v1' 형태인지
select count(*) filter (where badge_id !~ '^mission:[a-z0-9]+:v1$') as bad_format from public.user_badges;  -- expect 0
-- 적용 전: content vs badge difficulty 드리프트 (0015 게이트 사전확인)
select count(*) from public.mission_content c join public.mission_badges b using (catalog_version, mission_id)
 where coalesce(c.difficulty,'easy') <> b.difficulty;                          -- expect 0

-- (2) difficulty 명시화
select count(*) from public.mission_content where difficulty is null;          -- expect 0
-- (1) 배지 테이블 폐지
select to_regclass('public.mission_badges');                                   -- expect null
-- (4) version-agnostic 참조 (badge_id·catalog_version PK 잔존 없음)
select column_name from information_schema.columns
 where table_name='user_badges' and column_name in ('badge_id','catalog_version'); -- badge_id 없음, catalog_version은 PK 아님
-- (5) 획득 배지 보존
select count(*) from public.user_badges;                                       -- expect = 8
-- (7) RLS/grant 복원
select policyname from pg_policies where tablename in ('user_badges','board_badges');
```

API/E2E·단위·통합·관측 검증은 §14. 롤백은 §15.

---

## 12. ADR (Architecture Decision Record)

- **Decision**: `mission_badges`를 폐지하고 `mission_content`를 미션·배지 단일 정본으로 통합. 배지 획득은 **version-agnostic `mission_id` 자연키**로 참조. 등급/카운트는 파생. RPC는 시그니처 유지·body-only.
- **Drivers**: (1) 미션 정체성 이중 저장/좀비 컬럼 제거, (2) 신규 미션 이중 시드(0014가 실증) 부담 제거, (3) DEC-4(현재값 추종) 보존.
- **Alternatives**: (A) forward + 시그니처 변경 + version-in-PK — M1/M2 위반, (B) baseline rewrite — 관례·테스트 인프라 폐기, (C, 채택) forward + body-only + version-agnostic; 식별자는 (a)missions 테이블/(b)앱레벨/(c, 채택)mission_id 앵커.
- **Why chosen**: 운영 미가동(DEC-1)이라 변환 비용이 8건으로 최소. (C)+(c)가 단일 정본·DEC-4·repo 관례·무결성을 동시에 만족.
- **Consequences**: `badgeId`·`artworkKey` 응답 변경(프론트 동시 릴리스), RPC·호출부 원자 배포, 0014/제너레이터 선결 재작성, 단일버전 불변식(`unique(mission_id)`) 도입.
- **Follow-ups**: legacy cue 컬럼 정리, sheet.json 이중 정본 종결, 멀티버전 시 `missions` 테이블 도입, `difficulty_grades` 승격(필요 시).

---

## 13. 사전 부검 (Pre-mortem — 실패 시나리오 3 + 완화)

- **PM-1 — 0017 backfill 고아 mission_id**: `split_part(badge_id,':',2)`가 `mission_content`에 없는 `mission_id`를 만들거나(데이터 이상), `board_cells.mission_snapshot.id`가 카탈로그에 없어 award가 조용히 누락(INV-1). → **완화**: 0017 (d) 검증 게이트가 고아를 발견하면 트랜잭션 rollback. 적용 전 §11 형식 쿼리로 8건 확인. award 누락은 관측 지표로 모니터(§14 observability).
- **PM-2 — difficulty 가정 붕괴**: 누군가 `mission_content`에 badge와 어긋나는 difficulty를 넣은 뒤 0015가 `null→easy`만 수행해 잘못된 강등/승격. → **완화**: 0015 선행 `raise exception` 게이트가 드리프트 발견 시 중단. §11 사전 쿼리로 0 확인.
- **PM-3 — RPC/호출부 비원자 배포 또는 PostgREST 미reload**: RPC body는 새 PK인데 구 API 인스턴스가 합성키를 넘기거나, drop 후 `notify pgrst` 누락으로 API가 죽은 relation 조회 → award 전량 실패. → **완화**: RPC와 `badges.service.ts`를 같은 릴리스로 배포(원칙 6), 각 마이그레이션에 `notify pgrst` 강제, 배포 직후 catalog 행수·award 성공률 스모크 확인.

---

## 14. 확장 테스트 계획 (deliberate)

| 레이어 | 검증 | 깨지는 기존 spec → 갱신 |
|---|---|---|
| **Unit** | `BADGE_GRADE[difficulty]` 파생, `badgeId=mission_id`, `awards_badge` 필터, difficulty not null(`effectiveDifficulty`/`?? 'easy'` 제거), `artworkKey` 제거 | `badges.service.spec.ts`(합성키·`from('mission_badges')` 전면), `badges.schemas.spec.ts`(`artworkKey`), `missions.service.spec.ts`(difficulty:null 픽스처) |
| **Integration** | 0017 변환 후 8건 보존·조회, RPC `mission_id` idempotent(재호출 `earned_count` 불변), version-agnostic FK, RLS/grant/인덱스 복원, `unique(mission_id)` 불변식 | `boards.service.spec.ts`(award), 신규 RPC 계약 테스트 |
| **E2E** | `/v1/badges/catalog`(47 awards 대상), `/v1/missions/content`(difficulty 분포 easy34/med10/hard3), `/v1/users/me/badges`(변환 후), 보드 완성→award 플로우, `badgeId=mission_id` 응답 | 신규 |
| **Seed parity** | 제너레이터·0010/0014′가 `mission_badges`/`count`를 **생성하지 않음**, `awards_badge` emit | `mission-seed-parity.spec.ts`(badge seed·count assert), `mission-expansion-seed.spec.ts`(badge·count assert) |
| **Observability** | §11 검증 쿼리 결과 로깅, 배포 후 PostgREST reload·catalog 행수·award 성공률·고아 mission_id(INV-1) 카운트 모니터 | 신규 운영 체크리스트 |

---

## 15. 롤백 전략

- **0015/0016/0019**: additive·트랜잭션 단위. 실패 시 자동 롤백. 적용 후 회귀 시 역마이그레이션 단순(`drop column awards_badge` 등).
- **0017 (위험 단계)**: 단일 트랜잭션이므로 실패 시 자동 롤백. **적용 후** 회귀 발견 시 `0017_down.sql` 준비:
  - `user_badges.badge_id` 재구성: `'mission:'||mission_id||':v1'`, PK/FK 원복, `award_board_badges` 구 body 복원.
  - 단 `0018`로 `mission_badges`를 drop한 뒤에는 구 FK 타깃이 없으므로, **0018 적용 전까지 0017_down 유효**. 0018 이후 롤백은 `mission_badges` 재시드(0006/0009 재적용)까지 포함해야 함 → 0018은 0017 안정화 확인 후 별도 적용.
- **0018**: drop 전 `mission_badges` 스키마+데이터를 `pg_dump`로 백업. 재시드는 0006/0009/0014 시드 재적용.
- **배포 결합(PM-3)**: DB 마이그레이션과 API 릴리스를 함께 롤백(이전 이미지로). 단일버전·8건 규모라 maintenance window 허용.
