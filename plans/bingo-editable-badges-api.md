# Bingo Editable Missions + Badges API Plan

상태: pending approval

작성일: 2026-06-05

개정: consensus (PLANNER → ARCHITECT → CRITIC → revised). Critic verdict ITERATE의 must-fix 12건을 모두 반영했다.

대상 레포: `/Users/oksang/Desktop/sappeun/sappeun-api`

관련 프론트엔드 master plan: `/Users/oksang/Desktop/sappeun/sappeun-frontend/plans/flutter-migration-16-editable-bingo-badges.md`

관련 Pencil design plan: `/Users/oksang/Desktop/sappeun/sappeun-frontend/plans/flutter-migration-16-pencil-design.md`

선행 API plan: `/Users/oksang/Desktop/sappeun/sappeun-api/plans/bingo-completion-history-api.md`

스택: NestJS + Supabase(service-role admin client) + Zod + vitest.

## 진행 상태 메모

Pencil 디자인은 진행 중이다. 사용자가 API 기획서 작성을 명시적으로 요청했으므로 현재 Pencil handoff 기준으로 작성한다. Pencil 최종 산출물에서 화면/상태 이름이 바뀌면 endpoint payload와 response naming을 다시 동기화한다.

---

## RALPLAN-DR 요약 (consensus)

Mode: SHORT (high-risk minting 부분은 RPC 강제로 deliberate-grade 안전성 확보).

### Principles (5)

1. 서버가 official badge 지급의 single source of truth다. 클라이언트 snapshot/difficulty는 신뢰하지 않는다.
2. 동시성 안전을 TS 레이어가 아니라 DB 레이어(원자적 RPC, on-conflict)에서 보장한다.
3. 모든 신규 DB 객체는 기존 migration(0001/0004/0005) 스타일을 그대로 따른다. 무근거 신규 패턴(table-level grant 등)을 도입하지 않는다.
4. 재시도/부분실패는 self-healing idempotent 경로로 흡수한다. naive retry가 데이터를 망가뜨리면 안 된다.
5. 파생 가능한 상태(edited count 등)는 저장보다 read-time 파생을 우선한다 (이미 `summarizeBoardCompletion`이 파생을 쓴다).

### Decision Drivers (top 3)

1. Cross-board lost-update: 서로 다른 official board가 동일 `badge_id`를 동시에 earn하면 TS 멀티스텝 rollup이 `earned_count`를 잃는다. supabase-js `.upsert`는 `earned_count = earned_count + 1`을 표현 못 한다.
2. ended_at과 minting의 트랜잭션 경계: ended_at 후 minting이 실패하면 already-ended short-circuit이 재지급을 막아 영구 누락이 생긴다.
3. 데이터 무결성 vs 단순성: edited_cell_count write-back 경쟁, merged snapshot re-validation 누락 시 board가 un-restorable이 되는 위험.

### Viable Options (badge minting rollup)

- Option A — TS multi-step rollup (read earned_count → write N+1): 단순/유닛테스트 쉬움. 그러나 cross-board lost-update에 구조적으로 취약. **무효화**: supabase-js로 read-relative increment 불가, 레포에 선례 없음, board_badges PK는 same-board만 dedupe.
- Option B (채택) — security definer RPC `award_board_badges`가 board_badges→user_badges 두 테이블 write를 원자적으로 수행: lost-update-free, 0004/0005 선례 그대로. 약간의 SQL 작성 비용.
- Option C — ended_at + rollup을 하나의 RPC로 합침: 가장 강한 원자성. 그러나 endUserBoard의 기존 race-handling/select 로직을 RPC로 옮겨야 해 변경 표면이 커짐. **무효화**: M1을 self-heal(B + idempotent re-attempt)로 더 싸게 해결 가능하므로 불필요.

채택: Option B (RPC-primary minting) + self-healing already-ended re-attempt.

---

## 요약

기존 `boards` 완료 기록 API 위에 다음을 추가한다.

- 완료 후 기록 제목 입력 + 수정.
- 진행 중 셀의 제목/미션 설명 편집 + 되돌리기.
- 공식 빙고와 편집한 빙고의 서버 기준 분리(`customization_status`).
- 편집 없이 완료한 공식 빙고에 대한 mission badge 지급(원자적 RPC).
- 뱃지도감 catalog/user collection API.
- 완료 기록 목록/상세/close 응답에서 badge와 official/edited 상태 표시.

completion history 작업(`boardListQuerySchema`, `includePreview`, `summarizeBoardCompletion`, close 검증, list/detail summary, 대표 media preview)은 되돌리지 않고 확장한다.

---

## 적용한 CORRECTIONS (CORR-1 .. CORR-12)

| ID | 항목 | 해소 |
| --- | --- | --- |
| CORR-1 (C1) | cross-board lost-update | minting rollup을 security definer RPC `award_board_badges`로 승격. earned_count 증가를 DB에서 원자화. |
| CORR-2 (C2) | close-response 계약 + already-ended 경로 | `toBoardCompletionCloseResponse`에 title/customizationStatus/editedCellCount/badgeCount/earnedBadges 추가. fresh-close와 already-ended가 동일 shape 반환. |
| CORR-3 (M1) | ended_at + minting 복구 경계 | already-ended 분기가 idempotent하게 minting을 **재시도**(on-conflict-do-nothing로 안전). retry self-heal. |
| CORR-4 (M2) | cross-board 동시성 통합 테스트 | 한 user의 official board 2개가 동일 mission_id 공유 → 둘 다 award → `earned_count == 2` 단언. |
| CORR-5 (M3) | edited_cell_count 경쟁 | DERIVE-ON-READ 채택. predicate: `original_mission_snapshot IS NOT NULL`. stored column/constraint 제거. |
| CORR-6 (M4) | merged snapshot 재검증 | 편집은 기존 snapshot의 id/category/variant를 보존하고 label/hint/captureLabel만 병합 후 `missionSnapshotSchema`로 재검증, 실패 시 400. |
| CORR-7 (M5) | migration 파일명 | `supabase migration new` 제거. 손으로 `0006_bingo_editable_badges.sql` 단일 파일 작성. |
| CORR-8 (M6) | grant 근거 | table-level grant/revoke 미도입. 클라이언트 경로는 RLS로 게이트. 신규 RPC만 function-level revoke/grant(0005 선례). |
| CORR-9 | soft-delete badge semantics | badge는 board soft-delete를 통과하는 영구 achievement. |
| CORR-10 | seed coverage data source | 권위 있는 official mission-id 목록 artifact를 Phase-0 blocker로 명시. |
| CORR-11 | difficulty source | difficulty/gradeColor는 항상 `mission_badges` catalog. `snapshot.difficulty`(optional) 절대 사용 안 함. |
| CORR-12 | 계약 핀 고정 | updateBoardTitle scope, captureLabel fallback(read-time), endBoardSchema(zod default, no .strict) 등 모호점 단일 계약으로 고정. |

---

## 현재 코드/스키마 대조 (검증됨)

### 이미 있는 것

- `src/boards/boards.controller.ts`: `GET /v1/boards`, `/current`, `DELETE /current`, `POST /session`, `GET/DELETE /:boardId`, `POST /:boardId/end`, `PATCH/POST /:boardId/cells/:position`. `api/boards` compat route 포함.
- `src/boards/boards.schemas.ts`: `boardKindSchema(mission|custom)`, `boardListQuerySchema`, `boardSnapshotSchema`(v4), `missionSnapshotSchema`, `markBoardCellSchema`, `replaceBoardCellSchema`.
  - `missionSnapshotSchema`(:137-160): `id`(1..80, required), `category`(enum, **required** :138), `label`(trim 1..40, required), `caption`(max120 opt), `captureLabel`(max40 opt), `hint`(max160 opt), `icon`(nullable), `variant`(enum QeQCU|k4Srv|rAdyJ, **required** :152), `difficulty`(enum opt :158).
- `src/boards/boards.service.ts`: `summarizeBoardCompletion()`, `listUserBoards(...includePreview)`, `getUserBoardDetail()`, `markUserBoardCell()`, `replaceUserBoardCell()`, `endUserBoard()`.
  - `toBoardCompletionCloseResponse`(:416-427): 현재 `{ id, endedAt, ...summary }`만 반환.
  - `endUserBoard` already-ended short-circuit(:983-984): `if (board.ended_at) return toBoardCompletionCloseResponse(board, cells)`.
  - ended_at standalone update(:988-995): minting과 분리됨.
  - `getLatestUserBoardSession`(:1109 부근): mission board에서 어떤 position의 snapshot이 없으면 `return null`(un-restorable).
  - `deleteUserBoard`: soft-delete(`deleted_at` 세팅, hard-delete 없음).
- migration: `0001_remote_baseline.sql`(boards.title/description/board_kind, board_cells.mission_*, RLS enabled), `0004`(security definer RPC `confirm_user_photo_upload`/`confirm_user_clip_upload`), `0005`(해당 RPC execute 제한). 마지막 migration은 **0005** → 신규는 **0006**.

### 선례 확인(RPC/grant)

- 0004:140-148 패턴: `language plpgsql / security definer / set search_path to 'public'` + `if coalesce(auth.role(),'') <> 'service_role' then raise exception ... using errcode='42501'`.
- 0004:199-210, 0005 전체, 0001:228-232: function-level `revoke all ... from public/anon/authenticated; grant execute ... to service_role`.
- **table-level grant/revoke는 어떤 migration에도 없다.** service_role은 RLS를 우회하므로 API 경로는 table grant로 게이트되지 않는다.

### 없는 것

완료 close body title schema / 완료 후 제목 수정 endpoint / 셀 mission 편집·되돌리기 endpoint / 원본 snapshot 보존 column / official-edited 서버 field / badge catalog·collection·board-issue table / badge module / list·detail·close 응답의 badge 필드.

---

## 핵심 결정

### 1. 완료 기록 제목은 `boards.title`을 사용한다

별도 `record_title` column 없이 기존 `boards.title`에 저장한다. list/detail이 이미 `title`을 쓰고, API schema에 max 24 제한이 있다.

- DB에 `char_length(title) <= 24` check 추가.
- `POST /v1/boards/:boardId/end` body에서 title 수신.
- 완료 후 수정은 `PATCH /v1/boards/:boardId/title`.

### 2. official/edited는 `customization_status`로 표현한다 — **edited_cell_count는 파생값** (CORR-5)

`board_kind`(mission|custom)는 source/compat field로 유지하고, product state는 별도로 둔다.

```ts
type BoardCustomizationStatus = 'official' | 'edited'
```

DB:

- `boards.customization_status text not null default 'official'` (저장).
- `boards.edited_cell_count`는 **저장하지 않는다.** read-time에 파생한다. predicate 단일 정의:

  ```
  edited ⟺ board_cells.original_mission_snapshot IS NOT NULL
  ```

  `editedCellCount = count(board_cells where board_id=$1 and original_mission_snapshot is not null)`.
  `summarizeBoardCompletion`이 이미 파생 패턴을 쓰므로 일관된다. 따라서 `boards_edited_cell_count_check` constraint도, stored column도 만들지 않는다(경쟁 write 제거).

`customization_status`는 편집/되돌리기 시점에 명시적으로 갱신한다(편집 발생 → `edited`, 모든 original이 null로 복구 → `official`). 단, badge eligibility 최종 판정은 status flag가 아니라 **파생 predicate**(`어떤 cell도 original snapshot을 갖지 않음`)로 재확인하여 flag drift에도 안전하게 한다.

badge eligibility(모두 만족):

- `boardKind === 'mission'`
- 어떤 cell도 `original_mission_snapshot`을 갖지 않음 (= 미편집 official)
- board fully completed
- non-free cell의 mission snapshot이 complete하고 catalog와 매칭

### 3. 셀 편집은 원본 snapshot을 보존하고 merge를 재검증한다 (CORR-6)

DB:

- `board_cells.original_cell_id text`
- `board_cells.original_mission_snapshot jsonb`
- `board_cells.edited_at timestamptz`

편집 merge 규칙(엄격):

1. 첫 편집이면 현재 `cell_id`, `mission_snapshot`을 original column에 저장.
2. **merged snapshot 구성**: 기존 snapshot에서 `id`, `category`, `variant`(및 기타 기존 필드)를 **보존**하고 `label`(=입력 title), `hint`(=입력 description), `captureLabel`(입력 시)만 덮어쓴다.
3. merged snapshot을 `missionSnapshotSchema`로 **재검증**. 실패 시 400(`Invalid mission edit.`). 이로써 category/variant 누락으로 `getLatestUserBoardSession`이 null을 반환해 board가 un-restorable이 되는 것을 막는다.
4. 재검증 통과 후에만 `mission_label`, `mission_hint`, `mission_capture_label`, `mission_snapshot`을 갱신.
5. `mission_caption`/`snapshot.caption`은 caption 편집 필드가 명시되기 전까지 원본 보존.
6. `customization_status='edited'`로 갱신(count는 파생).

되돌리기:

- original이 있는 edited cell만 복구. current mission fields를 original 값으로 복구, `original_*`/`edited_at`을 null로.
- 복구 후 남은 edited cell이 0이면 `customization_status='official'`로 복구.

### 4. 배지 source of truth는 서버 catalog다 (CORR-11)

`snapshot.difficulty`(optional :158)를 신뢰하지 않는다. badge 지급, `difficulty`, `gradeColor`, `gradeLabel`은 **항상 `mission_badges` catalog**에서 온다. snapshot의 difficulty는 표시/지급 어디에도 쓰지 않는다.

### 5. Badge는 board soft-delete를 통과하는 영구 achievement다 (CORR-9)

`deleteUserBoard`는 `deleted_at`만 세팅(hard-delete 없음)하므로 `board_badges ... on delete cascade`는 **절대 발동하지 않는다**. 즉 board를 soft-delete해도 `user_badges.earned_count`는 감소하지 않는다. 이를 의도된 설계로 확정한다: **badge는 영구 achievement**다.

불변식 재정의: 완료 기록 목록의 `earnedBadgeCount == badgeCount`는 "해당 board가 지급한 badge 수"를 의미하며, board soft-delete와 무관하게 `board_badges`에 남는다. user collection의 `earned_count`는 board 삭제로 줄지 않는다(여러 board에 걸친 누적 achievement).

### 6. 동시성/원자성은 RPC가 보장한다 (CORR-1)

BadgesService는 eligibility 판정 + catalog lookup을 TS에서 수행(유닛테스트 가능)하고, **최종 두 테이블 write만** `award_board_badges` RPC로 위임한다. RPC가 board_badges insert와 user_badges upsert(earned_count 원자 증가)를 한 트랜잭션에서 처리해 cross-board lost-update를 제거한다.

---

## API 계약

### 1. 완료 close + 기록 제목 저장

`POST /v1/boards/:boardId/end`

Body schema (`endBoardSchema`):

| 필드 | 타입 | 필수 | 제한 |
| --- | --- | --- | --- |
| `title` | string | optional | trim 후 1..24 |

- **zod default 동작 채택**: 미지정 키는 strip(forward-compat 안전). `.strict()`를 **추가하지 않는다**(CORR-12 minor).

동작:

- title 있으면 close 전 `boards.title` 저장. 없으면 기존 유지.
- board가 이미 ended이고 fully completed면 title update 허용(idempotent).
- **fresh-close 경로**: ended_at 세팅 → eligible이면 `BadgesService.awardBoardBadges()`(RPC) 호출 → close 응답에 badge 포함.
- **already-ended 경로(self-heal, CORR-3)**: ended_at은 다시 세팅하지 않되 **eligible이면 `awardBoardBadges()`를 idempotent하게 재시도**(RPC가 on-conflict-do-nothing이므로 안전, 중복 지급 없음). 그 후 `getBoardBadges(userId,[boardId])`로 실제 board_badges를 읽어 응답에 채운다. 절대 re-mint로 count를 올리지 않는다(이미 있던 board_badges는 user_badges 증가 트리거 안 됨).
- 두 경로 모두 **동일 shape** 반환(CORR-2).

응답(fresh-close와 already-ended 동일 shape):

```json
{
  "ok": true,
  "board": {
    "id": "board-id",
    "title": "비 오는 날 산책",
    "endedAt": "2026-06-05T12:00:00.000Z",
    "completedAt": "2026-06-05T12:00:00.000Z",
    "completedCount": 25,
    "totalTargetCount": 25,
    "isFullyCompleted": true,
    "customizationStatus": "official",
    "editedCellCount": 0,
    "badgeEligible": true,
    "badgeCount": 24,
    "earnedBadges": [
      {
        "badgeId": "mission:n01:v1",
        "missionId": "n01",
        "title": "꽃 찾기",
        "difficulty": "easy",
        "gradeColor": "#6ED6A0",
        "earnedAt": "2026-06-05T12:00:00.000Z",
        "isFirstEarn": true
      }
    ]
  }
}
```

오류:

| Status | 조건 | 메시지 |
| --- | --- | --- |
| `400` | title 비었거나 김 | `Invalid completion title.` |
| `400` | snapshot 불완전 | `Board snapshot is incomplete.` |
| `400` | 미완료 | `Board is not fully completed.` |
| `404` | board 없음/소유자 아님 | `Board not found.` |

### 2. 완료 기록 제목 수정

`PATCH /v1/boards/:boardId/title`

Body: `{ "title": "퇴근길 산책" }` — schema `updateBoardTitleSchema`(trim 1..24, required).

**Scope 단일 계약 (CORR-12)**: non-deleted board만 대상. active board는 항상 허용. ended board는 **fully-completed인 경우에만** 허용. deleted board는 404. (active title은 completion title 기본값으로도 쓰인다.)

응답:

```json
{ "ok": true, "board": { "id": "board-id", "title": "퇴근길 산책", "updatedAt": "2026-06-05T12:10:00.000Z" } }
```

### 3. 셀 미션 편집

`PATCH /v1/boards/:boardId/cells/:position/mission`

Body:

```json
{ "cellId": "n01", "title": "우리 동네 분홍 꽃", "description": "길가나 화단에서 분홍색 꽃이 잘 보이게 찍어요", "captureLabel": "분홍 꽃" }
```

Schema (`editBoardCellMissionSchema`):

| 필드 | 타입 | 필수 | 제한 |
| --- | --- | --- | --- |
| `cellId` | string | required | 1..80 |
| `title` | string | required | trim 후 1..40 |
| `description` | string | optional | trim 후 max 160 |
| `captureLabel` | string | optional | trim 후 max 40 |

Copy mapping:

- `title` → `mission_label` + `mission_snapshot.label`.
- `description` → `mission_hint` + `mission_snapshot.hint`.
- `captureLabel` → `mission_capture_label` + `mission_snapshot.captureLabel`.
- **captureLabel fallback: READ-TIME (CORR-12)**. captureLabel 미입력 시 저장하지 않고(null/원본 유지), 응답·detail에서만 title fallback을 적용한다. 이로써 restore가 user-set과 fallback을 구분할 수 있다. write-time fallback은 채택하지 않는다.
- `mission_caption`/`snapshot.caption`은 원본 유지.
- merge 후 `missionSnapshotSchema` 재검증(category/variant/id 보존). 실패 시 400.

동작:

- ended board면 409. free position이면 409. `photo_id`/`clip_id`/`marked_at`/`completed_at`/`completion_type` 있으면 409.
- `cellId`가 board snapshot의 해당 position과 불일치하면 400.
- 첫 편집 시 original cell id/snapshot 보존. `customization_status='edited'` 갱신(count 파생).

응답:

```json
{
  "ok": true,
  "board": { "id": "board-id", "customizationStatus": "edited", "editedCellCount": 1, "badgeEligible": false },
  "cell": {
    "position": 0, "cellId": "n01", "editedAt": "2026-06-05T12:20:00.000Z",
    "mission": { "id": "n01", "label": "우리 동네 분홍 꽃", "captureLabel": "분홍 꽃", "hint": "길가나 화단에서 분홍색 꽃이 잘 보이게 찍어요", "icon": "local-florist", "difficulty": "easy" }
  }
}
```

오류:

| Status | 조건 | 메시지 |
| --- | --- | --- |
| `400` | position/cellId 불일치 | `cellId must match the board position.` |
| `400` | body 또는 merged snapshot 검증 실패 | `Invalid mission edit.` |
| `404` | board/cell 없음 | `Board not found.` / `Board cell not found.` |
| `409` | ended board | `Ended boards cannot be edited.` |
| `409` | free cell | `Free cell cannot be edited.` |
| `409` | 완료/미디어 cell | `Completed cells cannot be edited.` |

### 4. 셀 미션 되돌리기

`POST /v1/boards/:boardId/cells/:position/mission/restore`

Body: `{ "cellId": "n01" }` — schema `restoreBoardCellMissionSchema`.

동작: original snapshot 있는 edited cell만. ended/완료/미디어 cell이면 409. 복구 후 남은 edited cell이 0이면 `customization_status='official'`.

오류:

| Status | 조건 | 메시지 |
| --- | --- | --- |
| `409` | original 없음 | `Original mission snapshot is unavailable.` |
| `409` | ended/completed cell | edit endpoint와 동일 |

### 5. 완료 기록 목록 확장

`GET /v1/boards?status=completed&includePreview=true`

추가 필드:

```json
{ "boards": [ { "id": "board-id", "title": "비 오는 날 산책", "boardKind": "mission", "customizationStatus": "official", "editedCellCount": 0, "badgeEligible": true, "badgeCount": 24, "earnedBadgeCount": 24, "mediaPreview": null } ] }
```

정책:

- `editedCellCount`는 read-time 파생(original snapshot count).
- 기존 row의 `customizationStatus` fallback: 파생 predicate로 계산하되, 어떤 original snapshot도 없는 row는 `board_kind='custom'`이면 `edited`, 아니면 `official`.
- `badgeCount` = board가 지급한 badge 수(board_badges). soft-delete와 무관하게 유지(CORR-9).
- `earnedBadgeCount`는 v1에서 `badgeCount`와 동일.

### 6. 완료 기록 상세 확장

`GET /v1/boards/:boardId`

추가 필드:

```json
{
  "board": {
    "id": "board-id", "customizationStatus": "official", "editedCellCount": 0, "badgeEligible": true, "badgeCount": 24,
    "cells": [ { "position": 0, "cellId": "n01", "isEdited": false,
      "badge": { "badgeId": "mission:n01:v1", "missionId": "n01", "title": "꽃 찾기", "difficulty": "easy", "gradeColor": "#6ED6A0", "earnedAt": "2026-06-05T12:00:00.000Z" } } ]
  }
}
```

정책: edited board는 `badgeEligible=false`, cells[].badge=null. official board는 board_badges+mission_badges를 합쳐 cell별 badge 제공. free position에는 badge 없음. `isEdited`는 cell의 `original_mission_snapshot IS NOT NULL`로 파생.

### 7. 배지 catalog 조회

`GET /v1/badges/catalog`

인증: **authenticated 전용** (`SupabaseAuthGuard`). 게스트 도감 preview는 v1 범위 밖. → "Guest flow 확인" 참조(아래).

응답:

```json
{ "badges": [ { "badgeId": "mission:n01:v1", "missionId": "n01", "catalogVersion": "api-migration-v1", "title": "꽃 찾기", "category": "nature", "difficulty": "easy", "gradeLabel": "일상 배지", "gradeColor": "#6ED6A0", "artworkKey": "mission/n01", "sortOrder": 10 } ] }
```

### 8. 내 뱃지도감 조회

`GET /v1/users/me/badges`

Query: `difficulty`(easy|medium|hard|all, default all), `status`(earned|locked|all, default all).

응답:

```json
{
  "summary": { "earnedCount": 12, "totalCount": 64, "easyEarnedCount": 8, "mediumEarnedCount": 4, "hardEarnedCount": 0 },
  "badges": [ { "badgeId": "mission:n01:v1", "missionId": "n01", "title": "꽃 찾기", "difficulty": "easy", "gradeColor": "#6ED6A0", "earned": true, "earnedCount": 2, "firstEarnedAt": "...", "lastEarnedAt": "...", "sourceBoardId": "board-id" } ]
}
```

### 9. 배지 상세 조회

`GET /v1/users/me/badges/:badgeId`

```json
{ "badge": { "badgeId": "mission:n01:v1", "missionId": "n01", "title": "꽃 찾기", "difficulty": "easy", "gradeLabel": "일상 배지", "gradeColor": "#6ED6A0", "earned": true, "earnedCount": 2, "firstEarnedAt": "...", "sourceBoardId": "board-id" } }
```

---

## DB migration 계획 — 단일 파일 (CORR-7)

파일: `supabase/migrations/0006_bingo_editable_badges.sql` (손으로 작성, 0001/0004 스타일). `supabase migration new` 사용 안 함(timestamp prefix 회피). RPC를 포함한 net-new 객체는 한 파일에 둔다(0007 split 불필요 — 새 객체는 단일 파일이 정확하다).

### 1. boards 확장 (edited_cell_count 미저장, CORR-5)

```sql
alter table public.boards
  add column if not exists customization_status text not null default 'official';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'boards_customization_status_check') then
    alter table public.boards
      add constraint boards_customization_status_check
      check (customization_status = any (array['official'::text, 'edited'::text]));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'boards_title_length_check') then
    alter table public.boards
      add constraint boards_title_length_check
      check (title is null or char_length(title) <= 24);
  end if;
end $$;

-- backfill: 기존 custom board는 edited로 표시
update public.boards
   set customization_status = 'edited'
 where board_kind = 'custom' and customization_status = 'official';
```

`edited_cell_count` column과 그 check는 **만들지 않는다**(read-time 파생).

### 2. board_cells 확장

```sql
alter table public.board_cells
  add column if not exists original_cell_id text,
  add column if not exists original_mission_snapshot jsonb,
  add column if not exists edited_at timestamptz;
```

### 3. mission_badges

```sql
create table if not exists public.mission_badges (
  id text primary key,
  mission_id text not null,
  catalog_version text not null,
  title text not null,
  category text,
  difficulty text not null,
  grade_label text not null,
  grade_color text not null,
  artwork_key text,
  sort_order integer not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  constraint mission_badges_difficulty_check
    check (difficulty = any (array['easy'::text, 'medium'::text, 'hard'::text])),
  constraint mission_badges_title_check check (char_length(title) <= 40),
  unique (catalog_version, mission_id)
);
```

### 4. board_badges

```sql
create table if not exists public.board_badges (
  board_id uuid not null references public.boards(id) on delete cascade,
  badge_id text not null references public.mission_badges(id) on delete restrict,
  user_id uuid not null references auth.users(id) on delete cascade,
  earned_at timestamptz not null default now(),
  primary key (board_id, badge_id)
);
create index if not exists board_badges_user_board_idx
  on public.board_badges (user_id, board_id);
```

참고: boards는 hard-delete가 없으므로 `on delete cascade`는 사실상 발동하지 않는다(CORR-9). cascade는 미래 hard-delete 대비 안전망으로만 둔다.

### 5. user_badges

```sql
create table if not exists public.user_badges (
  user_id uuid not null references auth.users(id) on delete cascade,
  badge_id text not null references public.mission_badges(id) on delete restrict,
  first_board_id uuid references public.boards(id) on delete set null,
  last_board_id uuid references public.boards(id) on delete set null,
  first_earned_at timestamptz not null default now(),
  last_earned_at timestamptz not null default now(),
  earned_count integer not null default 1,
  primary key (user_id, badge_id),
  constraint user_badges_earned_count_check check (earned_count >= 1)
);
```

### 6. RLS와 policies (table grant 미도입, CORR-8/M6)

```sql
alter table public.mission_badges enable row level security;
alter table public.board_badges enable row level security;
alter table public.user_badges enable row level security;

create policy mission_badges_select_active on public.mission_badges
  for select using (active = true);
create policy board_badges_select_own on public.board_badges
  for select using (auth.uid() = user_id);
create policy user_badges_select_own on public.user_badges
  for select using (auth.uid() = user_id);
```

근거: 어떤 기존 migration도 table-level grant를 방출하지 않으며, service_role은 RLS를 우회하므로 API write 경로는 table grant로 게이트되지 않는다. 따라서 선례 없는 REVOKE/GRANT-on-tables를 **도입하지 않는다.** 클라이언트 read 경로는 위 RLS policy로만 게이트한다. insert/update/delete는 service_role(또는 RPC)만 수행한다. (만약 운영상 table grant를 추가해야 한다면, 의도된 divergence로 별도 rationale을 남긴 뒤에만 추가한다.)

### 7. RPC `award_board_badges` (CORR-1, 0004/0005 선례)

```sql
create or replace function public.award_board_badges(
  p_user_id uuid,
  p_board_id uuid,
  p_badge_ids text[]
) returns table (badge_id text, is_first_earn boolean)
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_now timestamptz := now();
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Only service role can award badges.'
      using errcode = '42501';
  end if;

  return query
  with inserted as (
    insert into public.board_badges (board_id, badge_id, user_id, earned_at)
    select p_board_id, b, p_user_id, v_now
      from unnest(p_badge_ids) as b
    on conflict (board_id, badge_id) do nothing
    returning board_badges.badge_id
  ),
  rolled as (
    insert into public.user_badges (
      user_id, badge_id, first_board_id, last_board_id,
      first_earned_at, last_earned_at, earned_count
    )
    select p_user_id, i.badge_id, p_board_id, p_board_id, v_now, v_now, 1
      from inserted i
    on conflict (user_id, badge_id) do update
      set earned_count   = user_badges.earned_count + 1,
          last_earned_at = excluded.last_earned_at,
          last_board_id  = excluded.last_board_id
    returning user_badges.badge_id, (user_badges.earned_count = 1) as is_first_earn
  )
  select r.badge_id, r.is_first_earn from rolled r;
end;
$$;

revoke all on function public.award_board_badges(uuid, uuid, text[]) from public;
revoke all on function public.award_board_badges(uuid, uuid, text[]) from anon;
revoke all on function public.award_board_badges(uuid, uuid, text[]) from authenticated;
grant execute on function public.award_board_badges(uuid, uuid, text[]) to service_role;
```

원자성: board_badges insert(same-board dedupe)에서 **새로 들어간 row만** user_badges rollup으로 흐른다(체인 data-modifying CTE: 두 INSERT 모두 실행되고, 두 번째 CTE는 첫 CTE의 RETURNING set만 본다). user_badges upsert는 `earned_count = user_badges.earned_count + 1`을 DB가 원자 실행하므로 서로 다른 board가 동일 badge를 동시에 award해도 lost-update가 없다(CORR-1 해소). `is_first_earn`은 DO UPDATE 후 POST-update 값으로 판정: 첫 지급은 insert되어 `earned_count=1`→true, 재지급은 `earned_count>=2`→false(off-by-one 없음). 이미 존재하던 board_badges는 inserted에 안 나타나 재증가되지 않는다(idempotent, M1 self-heal 안전: already-minted board 재close 시 inserted set이 비어 rollup 미발생 → earned_count 불변). 모든 `badge_id` 참조는 CTE/테이블 별칭으로 한정한다.

### 8. badge catalog seed

같은 0006 migration에서 `insert into public.mission_badges (...) values (...) on conflict (catalog_version, mission_id) do update set ...`로 seed한다. seed 데이터의 권위 출처는 Phase-0 blocker로 확보(아래).

---

## Resolved Questions

| 질문 | 결정 |
| --- | --- |
| minting rollup 원자성 | RPC `award_board_badges`가 PRIMARY (Option B). TS는 eligibility+catalog만. |
| ended_at 후 minting 실패 복구 | already-ended 분기가 idempotent minting 재시도(self-heal). |
| edited_cell_count 저장 vs 파생 | DERIVE-ON-READ. stored column/constraint 없음. predicate = original_mission_snapshot IS NOT NULL. |
| merged snapshot 검증 | 기존 id/category/variant 보존 + missionSnapshotSchema 재검증, 실패 400. |
| migration 파일/분할 | 단일 `0006_bingo_editable_badges.sql`, 손작성. |
| table grant | 미도입. RLS로만 게이트. function-level revoke/grant만(선례). |
| badge + soft-delete | badge 영구. soft-delete로 earned_count 감소 없음. board_badges 유지. |
| difficulty 출처 | 항상 mission_badges catalog. snapshot.difficulty 미사용. |
| updateBoardTitle scope | non-deleted; active 항상; ended는 fully-completed에 한해. |
| captureLabel fallback | READ-TIME(응답 전용). write 안 함. |
| catalog 인증 | authenticated 전용(guest 미소비 확인 후 확정). |
| endBoardSchema strictness | zod default(strip), no .strict(). |

## What's-Missing 결정

- **Soft-delete badge semantics**: badge = 영구 achievement. board soft-delete 시 board_badges/user_badges 불변. `earnedBadgeCount==badgeCount`는 "board가 지급한 수"로 정의되어 soft-delete와 양립.
- **Seed coverage data source (Phase-0 blocker)**: 권위 있는 official mission-id 목록의 구체 artifact 경로가 현재 이 레포에 확정돼 있지 않다. 후보: Flutter asset(`sappeun-frontend`의 mission catalog asset) 또는 이 레포 내 JSON. **Phase-0에서 반드시 확정**해야 한다 — seed + coverage test 작성 전 차단 의존성. 미확정 시 Phase 2 진입 금지.
- **Guest flow 확인**: catalog/difficulty를 소비하는 guest surface가 없는지 한 줄 확인 후 catalog를 authenticated-only로 잠근다(Phase-0 체크).
- **difficulty source**: 위 표대로 항상 catalog.

---

## 서비스 설계

### BoardsService 확장

```ts
updateBoardTitle(userId, boardId, input)        // scope: non-deleted; active 항상; ended는 fully-completed
editBoardCellMission(userId, boardId, position, input)   // merge + missionSnapshotSchema 재검증
restoreBoardCellMission(userId, boardId, position, input)
computeBoardCustomization(board, cells)          // edited count/status 파생(original_mission_snapshot IS NOT NULL)
```

`toBoardCompletionCloseResponse` 변경(CORR-2): 반환에 `title`, `customizationStatus`, `editedCellCount`(파생), `badgeEligible`, `badgeCount`, `earnedBadges` 추가. fresh/already-ended 동일 shape.

`endUserBoard` 변경(CORR-2/CORR-3):

- body input 수신, close 전 title update.
- summary 계산 후 eligibility 파생.
- **fresh-close**: ended_at 세팅 성공 후 eligible이면 `awardBoardBadges()` 호출, 결과로 earnedBadges 채움.
- **already-ended 분기(:983-984)**: eligible이면 `awardBoardBadges()` idempotent 재시도(RPC on-conflict 안전), 그 후 `getBoardBadges(userId,[boardId])`로 읽어 응답 채움. re-mint로 count 증가 없음.

### BadgesModule 신규

DI 방향(순환 의존 회피): `BadgesService`는 `SupabaseService`에만 의존한다(다른 service와 동일 패턴). `BoardsModule`이 `BadgesModule`을 import한다. `endUserBoard`는 이미 로드한 `board`+`cells`를 `awardBoardBadges({userId, board, cells})`에 넘긴다. `forwardRef` 불필요(단방향).

파일:

- `/Users/oksang/Desktop/sappeun/sappeun-api/src/badges/badges.module.ts`
- `.../src/badges/badges.controller.ts`
- `.../src/badges/badges.service.ts`
- `.../src/badges/badges.schemas.ts`
- `.../src/badges/badges.service.spec.ts`
- `.../src/badges/badges.schemas.spec.ts`

Service 함수:

```ts
listCatalog()
listUserBadges(userId, query)
getUserBadgeDetail(userId, badgeId)
awardBoardBadges({ userId, board, cells })   // eligibility+catalog는 TS, write는 award_board_badges RPC
getBoardBadges(userId, boardIds)
```

`awardBoardBadges()` 절차:

1. board eligibility 재검증(파생 predicate: mission kind, 미편집, fully completed).
2. free position 제외 official mission cell의 mission_id 수집.
3. `mission_badges`에서 `(catalog_version, mission_id)`로 badge id 매핑(difficulty/gradeColor는 여기서만).
4. badge id 배열로 **`award_board_badges(userId, boardId, badgeIds)` RPC 호출** — board_badges insert + user_badges rollup 원자 처리.
5. RPC 반환(badge_id, is_first_earn)으로 earnedBadges 구성. 다시 read 불필요(fresh-close). already-ended는 위 getBoardBadges로 보강.

---

## 구현 단계

### Phase 0. Handoff sync + blocker 해소

- Pencil `09. Editable Bingo + Badge Catalog` handoff에서 state/field 이름 확인, 불일치 시 plan 먼저 갱신.
- **Seed source artifact 확정(차단)**: 권위 있는 official mission-id 목록 경로(Flutter asset 또는 repo JSON) 확보. 미확보 시 Phase 2 진입 금지.
- Guest가 catalog/difficulty를 소비하지 않음을 한 줄 확인.

### Phase 1. Schema/API validation

- `endBoardSchema`(title optional 1..24, no .strict), `updateBoardTitleSchema`, `editBoardCellMissionSchema`, `restoreBoardCellMissionSchema`, badge list query schema 추가.

### Phase 2. DB migration (단일 0006)

- `0006_bingo_editable_badges.sql` 손작성: boards(customization_status + title check, edited count 미저장), board_cells(original_*), mission_badges/board_badges/user_badges, RLS+policies(table grant 없음), `award_board_badges` RPC + function revoke/grant, catalog seed.
- migration list/advisor 또는 SQL review 기록.

### Phase 3. Boards API

- `POST /boards/:boardId/end` body title + minting wiring(fresh + self-heal).
- `PATCH /boards/:boardId/title`(scope 계약).
- `PATCH /boards/:boardId/cells/:position/mission`(merge 재검증).
- `POST /boards/:boardId/cells/:position/mission/restore`.
- list/detail에 customization(파생)/badge summary 추가. compat `/api/boards`에는 신규 endpoint 미추가.

### Phase 4. Badges API

- BadgesModule 추가, AppModule 등록.
- `GET /v1/badges/catalog`(authenticated), `GET /v1/users/me/badges`, `GET /v1/users/me/badges/:badgeId`.
- close에서 `awardBoardBadges()`(RPC) 연결.

### Phase 5. 테스트

- schema validation 테스트.
- mission edit service 테스트(merge 재검증: category/variant 보존, 누락 시 400).
- restore 테스트.
- completion title close 테스트.
- official board badge minting 테스트.
- edited board no-badge 테스트.
- close idempotency 테스트(same-board 재close → earned_count 불변).
- **cross-board 동시성 통합 테스트(CORR-4/M2)**: 동일 mission_id 공유 official board 2개 award → `user_badges.earned_count == 2`.
- user badge collection filter 테스트.
- RLS/grant/RPC migration smoke 또는 SQL review.

---

## 예상 변경 파일

Boards: `src/boards/boards.controller.ts`, `boards.service.ts`, `boards.schemas.ts`, `boards.service.spec.ts`, `boards.schemas.spec.ts` (모두 절대경로 `/Users/oksang/Desktop/sappeun/sappeun-api/...`).

Badges: `src/badges/badges.module.ts`, `badges.controller.ts`, `badges.service.ts`, `badges.schemas.ts`, `badges.service.spec.ts`, `badges.schemas.spec.ts`.

DB: `/Users/oksang/Desktop/sappeun/sappeun-api/supabase/migrations/0006_bingo_editable_badges.sql`, `/Users/oksang/Desktop/sappeun/sappeun-api/supabase/SCHEMA_SNAPSHOT.md`.

앱 wiring: `/Users/oksang/Desktop/sappeun/sappeun-api/src/app.module.ts`.

---

## 검증 명령

```bash
cd /Users/oksang/Desktop/sappeun/sappeun-api
pnpm test -- boards badges
pnpm lint
pnpm build
```

Supabase migration 검증(Supabase 인스턴스 접근 없음 전제 — 적용은 별도 환경):

```bash
cd /Users/oksang/Desktop/sappeun/sappeun-api
supabase --version
supabase --help
supabase migration --help
supabase migration list --local
```

---

## 수동 확인 시나리오

### 완료 제목

- close body title 전송 → list/detail의 `title` 변경.
- title 과길이 → 400.
- 이미 ended(fully completed) board에 title 재전송 → 안전 update. ended이지만 미완료 board title patch → 거부.

### 셀 편집

- active board 미완료 셀 편집 → `customizationStatus=edited`, `editedCellCount=1`(파생).
- category/variant를 깨뜨리는 merge → 400, board는 여전히 restorable.
- captureLabel 미입력 → 응답에서 title fallback 표시, 저장값은 fallback 아님(restore 구분 가능).
- completed/media/free cell 편집 불가.
- 되돌리기 → edited count 감소. 전부 되돌리면 `official` 복귀.

### 배지 지급

- official/unedited board close → non-free mission badge 지급, close 응답에 earnedBadges.
- 같은 board close 재호출 → `earned_count` 중복 증가 없음(idempotent self-heal).
- **cross-board 동시성**: 동일 mission 공유하는 official board 2개를 같은 user가 award → `user_badges.earned_count == 2`.
- edited board close → badge 미지급, 기록은 저장.
- catalog에 없는 mission → coverage test에서 검출.
- board soft-delete 후에도 `GET /v1/users/me/badges`의 earned_count 불변.
- `GET /v1/users/me/badges`가 earned/locked 함께 반환.

---

## 작업 체크리스트

### Phase 0
- [ ] Pencil handoff field/state 확인 및 plan 동기화.
- [ ] seed source artifact 경로 확정(차단 의존성).
- [ ] guest가 catalog/difficulty 미소비 확인.

### Phase 1
- [ ] `endBoardSchema`(no .strict) 추가.
- [ ] `updateBoardTitleSchema` 추가.
- [ ] `editBoardCellMissionSchema` 추가.
- [ ] `restoreBoardCellMissionSchema` 추가.
- [ ] badge query schema 추가.

### Phase 2
- [ ] `0006_bingo_editable_badges.sql` 손작성(timestamp prefix 없음).
- [ ] boards customization_status + title check(edited count 미저장).
- [ ] board_cells original_*/edited_at.
- [ ] mission_badges/board_badges/user_badges.
- [ ] RLS+policies(table grant 없음).
- [ ] `award_board_badges` RPC + function revoke/grant.
- [ ] catalog seed.
- [ ] migration list/advisor 또는 SQL review 기록.

### Phase 3
- [ ] close body title + minting(fresh + already-ended self-heal).
- [ ] board title patch(scope 계약).
- [ ] cell mission edit(merge 재검증).
- [ ] cell mission restore.
- [ ] list/detail customization(파생)/badge summary. close 응답 shape 통일.

### Phase 4
- [ ] BadgesModule + AppModule 등록.
- [ ] catalog endpoint(authenticated).
- [ ] user collection endpoint.
- [ ] badge detail endpoint.
- [ ] close badge minting(RPC) 연결.

### Phase 5
- [ ] schema spec.
- [ ] boards service spec(merge 재검증 포함).
- [ ] badges service spec.
- [ ] close idempotency(same-board earned_count 불변).
- [ ] **cross-board 동시성 통합 테스트(earned_count==2)**.
- [ ] edited board no-badge.
- [ ] `pnpm test -- boards badges`, `pnpm lint`, `pnpm build` 통과.

---

## ADR (Architecture Decision Record)

**Decision**: Editable bingo + badges API를 (1) RPC-primary badge minting, (2) read-time 파생 edited count, (3) self-healing idempotent close, (4) soft-delete를 통과하는 영구 badge, (5) RLS-only(table-grant 무도입) 모델로 구현한다.

**Drivers**: cross-board lost-update 위험; ended_at/minting 트랜잭션 경계; 파생 가능 상태의 경쟁 write 제거; 데이터 무결성(restorability); 기존 migration 선례 준수.

**Alternatives considered**:
- TS multi-step rollup (Option A) — supabase-js로 원자 increment 불가, lost-update 취약 → REJECTED.
- ended_at+rollup 단일 RPC (Option C) — endUserBoard race-handling 이전 부담 → REJECTED(self-heal로 더 싸게 해결).
- stored edited_cell_count + constraint — 동시 편집 시 write-back 경쟁 → REJECTED(파생 채택).
- table-level grant/revoke — 레포 선례 없음, service_role이 RLS 우회 → REJECTED(RLS-only).

**Why chosen**: RPC가 earned_count 증가를 DB에서 원자화해 lost-update를 근본 제거하고, eligibility/catalog는 TS에 남아 유닛테스트가 유지된다. 파생 edited count는 경쟁 write를 없앤다. self-heal은 부분실패 retry를 안전하게 흡수한다. RLS-only는 기존 0001/0004/0005 패턴과 정확히 일치한다.

**Consequences**: badge 지급 경로가 service_role/RPC에 묶인다(클라이언트 직접 write 불가). board soft-delete는 badge에 영향 없음(영구 achievement; `earnedBadgeCount==badgeCount`는 "board가 지급한 수"로 재정의). edited count는 매 read 시 cell 스캔(저비용, 25칸).

**Follow-ups**: Pencil 최종 naming 동기화; share 화면 badge treatment(`shared_board_view` 확장)는 별도 plan; mission catalog 변동이 잦아지면 seed를 repo source file + 생성 스크립트로 전환; seed coverage test가 Flutter mission asset과 drift 시 official board badge 누락 가능 — coverage test 필수.

## 완료 기준

- close API가 title을 받아 완료 기록 제목으로 저장한다.
- 완료 후 title 수정 API 동작(scope 계약 준수).
- active board cell 제목/미션 설명 편집·되돌리기 동작, merge 재검증으로 항상 restorable.
- edited board는 서버 기준으로 badge 제외.
- official unedited completed board는 RPC로 mission badge를 idempotent하게(그리고 cross-board lost-update 없이) 지급.
- close 응답이 fresh/already-ended 동일 shape로 badge를 포함하고, retry가 self-heal한다.
- list/detail/end 응답에 customization(파생)/badge summary 포함.
- 뱃지도감 catalog/user collection API 동작.
- 신규 테이블 RLS 정책 보유(table grant 미도입), 신규 RPC는 service_role 전용.
- cross-board 동시성 테스트 포함 모든 tests/lint/build 통과.
