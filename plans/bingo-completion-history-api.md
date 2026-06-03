# Bingo Completion History API Plan

상태: active plan

작성일: 2026-06-03

대상 레포: `/Users/oksang/Desktop/sappeun/sappeun-api`

관련 프론트엔드 계획: `/Users/oksang/Desktop/sappeun/sappeun-frontend/plans/flutter-migration-13-bingo-continue-history.md`

## 요약

Flutter 앱의 빙고 이어하기, 완료 저장, 완료 기록 조회 UI를 지원하기 위해 API 레포에서 필요한 `boards` API 확장 계획을 정리한다. 신규 `/v1/bingo/completions` 도메인을 바로 만들지 않고, 이미 존재하는 `boards`, `board_cells`, `photos`, `clips` 모델을 완료 기록의 원천으로 사용한다.

현재 API에는 board session ensure, active board 조회/삭제, board detail, board end endpoint가 이미 있다. 이번 작업은 기존 API를 기록 화면에 맞게 확장하고, 미완료 board가 기록으로 닫히지 않도록 서버 방어 검증을 추가하는 것이 핵심이다.

## 목표와 비목표

### 목표

- 완료 기록 목록에서 active/incomplete/deleted board를 확실히 제외한다.
- 완료 기록 상세에서 프론트가 재계산하지 않아도 되는 summary 계약을 제공한다.
- `POST /v1/boards/:boardId/end`가 완료 조건을 서버에서 검증하도록 바꾼다.
- 기존 `api/boards` compatibility route는 깨지지 않게 유지하되 신규 Flutter 구현은 `/v1/boards`만 기준으로 삼는다.
- 완료 판정 로직을 하나의 pure helper로 모아 list/detail/end가 같은 기준을 쓰게 한다.

### 비목표

- 별도 `bingo_completions` 테이블 또는 `/v1/bingo/completions` 도메인은 만들지 않는다.
- 첫 구현에서 pagination cursor, search, 날짜 필터, 실제 목록 썸네일 signed URL 생성은 하지 않는다.
- 게스트가 완료한 board를 로그인 직후 자동 완료 기록으로 승격하는 흐름은 후속 과제로 둔다.
- 완료된 board를 다시 active 상태로 되돌리는 API는 제공하지 않는다.

## 현재 코드/스키마 대조 결과

- `src/boards/boards.controller.ts`에는 `/boards`와 `/api/boards` controller가 둘 다 있고, 전역 prefix 때문에 `/boards`는 `/v1/boards`로 노출된다.
- `GET /v1/boards`와 `GET /api/boards`는 현재 query를 받지 않고 `BoardsService.listUserBoards(user.id)`만 호출한다.
- `BoardsService.toHistoryItem()`은 `photo_id`, `clip_id`, `marked_at`, `completed_at`만 완료로 세며 `free_position`을 자동 완료로 세지 않는다.
- `POST /v1/boards/:boardId/end`는 현재 `ended_at`만 update하고 완료 여부를 검증하지 않는다.
- `supabase/migrations/0001_remote_baseline.sql` 기준으로 `board_cells.completed_at`, `board_cells.completion_type`, `boards.ended_at`, `boards.deleted_at`는 이미 존재한다.
- `completion_type` check constraint에는 `photo`, `no_photo`, `clip`, `no_media`, `free`가 이미 포함되어 있어 첫 구현에서 DB migration은 필수가 아니다.
- 현재 repo에는 `src/boards/boards.schemas.spec.ts`는 있지만 `src/boards/boards.service.spec.ts`는 없다. summary helper를 pure function으로 빼면 신규 service spec을 가볍게 만들 수 있다.

## 배경

프론트엔드 Pencil/Flutter 계획에서 필요한 기능은 아래와 같다.

- 진행 중 빙고를 나갔다가 이어서 플레이한다.
- 로그인한 사용자가 모든 완료 대상 칸을 채우면 완료 기록을 남긴다.
- 로그인한 사용자가 완료 기록 목록과 상세를 언제든지 조회한다.
- 중도 포기한 board는 완료 기록에 섞이지 않는다.

로컬 이어하기 자체는 Flutter `BoardSessionStore`가 담당하므로 API가 필수는 아니다. API가 필요한 지점은 로그인 유저의 서버 기록 저장, 완료 기록 목록, 완료 기록 상세 조회다.

## 현재 사용 가능한 API

`API_PREFIX=v1` 기준으로 Flutter 신규 구현은 아래 versioned route를 사용한다. `api/boards` compatibility route는 유지하되 신규 모바일 구현의 기준으로 삼지 않는다.

| Method | Path | 현재 상태 | 사용 목적 |
| --- | --- | --- | --- |
| `POST` | `/v1/boards/session` | 존재 | 로컬 `BoardSession`을 서버 board로 ensure하고 `{ boardId }` 확보 |
| `GET` | `/v1/boards/current` | 존재 | 로그인 유저의 최신 active session 복원 |
| `DELETE` | `/v1/boards/current` | 존재 | 로그인 유저의 active board 포기 |
| `GET` | `/v1/boards` | 존재, 확장 필요 | 완료 기록 목록 조회 |
| `GET` | `/v1/boards/:boardId` | 존재, 확장 필요 | 완료 기록 상세 조회 |
| `POST` | `/v1/boards/:boardId/end` | 존재, 검증 필요 | 완료된 board를 기록으로 닫음 |
| `POST` | `/v1/boards/adopt-guest-session` | 존재 | 게스트 세션 로그인 승격. 첫 구현에서는 선택 사항 |

## 필요한 API 변경

### 1. 완료 기록 목록 필터

현재 `GET /v1/boards`는 삭제되지 않은 사용자 board를 최신순으로 반환한다. 완료 기록 화면에서는 active/incomplete board가 섞이면 안 되므로 status query를 추가한다.

Endpoint:

```http
GET /v1/boards?status=completed
```

Query:

| 이름 | 값 | 기본값 | 설명 |
| --- | --- | --- | --- |
| `status` | `completed`, `active`, `all` | `all` | 목록 필터. 완료 기록 화면은 `completed` 사용 |
| `limit` | `1..50` | `50` | 반환 개수 상한. 잘못된 값은 400 |

유효하지 않은 query는 `400 Bad Request`를 반환한다. controller에 ad hoc parse를 두기보다 `boards.schemas.ts`에 `boardListQuerySchema`를 추가하고, `ZodValidationPipe` 또는 작은 query parser helper로 검증한다.

응답:

```json
{
  "boards": [
    {
      "id": "7a3d...",
      "sessionId": "session-...",
      "status": "completed",
      "mode": "5x5",
      "boardKind": "mission",
      "nickname": "하루",
      "title": "산책 빙고",
      "description": null,
      "createdAt": "2026-06-03T04:00:00.000Z",
      "updatedAt": "2026-06-03T04:30:00.000Z",
      "endedAt": "2026-06-03T04:30:00.000Z",
      "completedAt": "2026-06-03T04:30:00.000Z",
      "completedCount": 25,
      "totalTargetCount": 25,
      "isFullyCompleted": true,
      "photoCount": 10,
      "clipCount": 14,
      "mediaCount": 24,
      "thumbnailUrls": []
    }
  ]
}
```

구현 메모:

- `completed`는 `deleted_at IS NULL`, `ended_at IS NOT NULL`, `client_session_id IS NOT NULL`, `isFullyCompleted === true`인 board만 반환한다.
- `active`는 `ended_at IS NULL`, `deleted_at IS NULL`, `client_session_id IS NOT NULL`인 board만 반환한다.
- `all`은 현재 동작과 최대한 호환되게 유지한다. 다만 응답 item에는 summary 필드를 추가해도 된다.
- `completed` 정렬은 `ended_at DESC, updated_at DESC`를 권장한다. `active`와 `all`은 기존 UX와 호환되도록 `updated_at DESC`를 유지한다.
- `listUserBoards(userId, { status, limit })`는 DB에서 먼저 `deleted_at`, `client_session_id`, `ended_at` 조건을 좁히고, cell summary 계산 후 `completed`의 incomplete 항목을 한 번 더 걸러낸다.
- `status=completed`에서 summary 후 필터링 때문에 반환 개수가 `limit`보다 작을 수 있다. 첫 구현에서는 cursor pagination이 없으므로 허용한다.
- `/api/boards?status=...` compatibility route도 같은 query를 지원한다. 기존 클라이언트가 query 없이 호출하면 `status=all`로 동작한다.
- `status` 필드는 신규 응답 필드다. 값은 `board.ended_at ? 'completed' : 'active'`로 계산하되, deleted board는 목록에 나오지 않는다.
- `sessionId`는 `client_session_id`를 camelCase로 노출한다. 기존 detail에는 이미 `sessionId`가 있으므로 list와 맞춘다.
- `thumbnailUrls`는 첫 구현에서 비워도 되지만, 리스트 UI에서 썸네일을 보여줄 수 있도록 후속 확장 포인트로 응답에 자리만 둘 수 있다.
- signed thumbnail URL을 바로 채우면 목록 호출 비용이 커지므로 첫 구현에서는 `[]` 고정이 채택안이다.

### 2. 완료 기록 상세 응답 보강

현재 `GET /v1/boards/:boardId`는 board와 cells, signed preview URL을 반환한다. 완료 기록 상세 화면에서 전체 완료 상태와 칸별 완료 타입을 안정적으로 그릴 수 있도록 summary 필드를 추가한다.

Endpoint:

```http
GET /v1/boards/:boardId
```

응답:

```json
{
  "board": {
    "id": "7a3d...",
    "sessionId": "session-...",
    "mode": "5x5",
    "boardKind": "mission",
    "nickname": "하루",
    "title": "산책 빙고",
    "description": null,
    "createdAt": "2026-06-03T04:00:00.000Z",
    "updatedAt": "2026-06-03T04:30:00.000Z",
    "endedAt": "2026-06-03T04:30:00.000Z",
    "completedAt": "2026-06-03T04:30:00.000Z",
    "completedCount": 25,
    "totalTargetCount": 25,
    "isFullyCompleted": true,
    "photoCount": 10,
    "clipCount": 14,
    "mediaCount": 24,
    "freePosition": 12,
    "cellIds": ["..."],
    "cells": [
      {
        "position": 12,
        "cellId": "free",
        "mission": null,
        "markedAt": null,
        "completedAt": "2026-06-03T04:30:00.000Z",
        "completionType": "free",
        "photo": null,
        "clip": null
      }
    ]
  }
}
```

구현 메모:

- 기존 detail 응답의 `cells[].completionType`는 이미 존재한다.
- `cells`는 항상 position 오름차순으로 반환한다.
- free cell은 DB row에 `completion_type='free'`가 없더라도 응답 계산에서 `completionType: 'free'`, `completedAt: board.ended_at ?? board.updated_at`로 보정한다.
- free cell의 `markedAt`은 기존 row 값이 있으면 유지하고, 없으면 `null`로 둔다. `completedAt`만 summary 표시용으로 보정한다.
- `mission.noPhoto === true` 또는 `mission.textOnly === true`는 "미디어 없이 완료 가능"이라는 속성일 뿐 자동 완료 조건은 아니다. 완료 증거는 `marked_at`, `completed_at`, `completion_type='no_photo'|'no_media'` 중 하나가 있어야 한다.
- `photo`와 `clip`은 기존 detail 응답처럼 업로드 완료 및 삭제되지 않은 media만 signed preview URL을 생성한다. 첫 구현에서는 기존 동작과 호환되게 cell의 `photo_id/clip_id`를 완료 증거로 유지하고, media row를 조회하지 못하면 preview 객체만 `null`로 둔다.
- signed preview URL은 기존 `createPhotoPreviewUrl`, `createClipPreviewUrls`를 계속 사용한다.
- mission board에서 `board_cells` 또는 `mission_snapshot`이 누락되면 기존 `getLatestUserBoardSession()` 정책과 맞춰 null/404 성격으로 처리한다. 완료 기록 상세에서 placeholder mission을 합성하지 않는다.
- custom board에서 `board_cells` row가 비어 있으면 기존 detail 보정처럼 `cell_ids` 기반 snapshot을 upsert한 뒤 계산한다.

### 3. 완료 close 검증

현재 `POST /v1/boards/:boardId/end`는 board 소유자만 맞으면 `ended_at`를 설정한다. 완료 기록 요구사항에서는 모든 완료 대상 칸이 완료되지 않은 board가 기록으로 닫히면 안 된다.

Endpoint:

```http
POST /v1/boards/:boardId/end
```

응답:

```json
{
  "ok": true,
  "board": {
    "id": "7a3d...",
    "endedAt": "2026-06-03T04:30:00.000Z",
    "completedCount": 25,
    "totalTargetCount": 25,
    "isFullyCompleted": true
  }
}
```

오류:

| Status | 조건 | 메시지 |
| --- | --- | --- |
| `400` | board가 완료 조건을 만족하지 않음 | `Board is not fully completed.` |
| `400` | board snapshot이 불완전해 완료 여부를 계산할 수 없음 | `Board snapshot is incomplete.` |
| `404` | board가 없거나 다른 유저 board | `Board not found.` |

구현 메모:

- `endUserBoard()`는 update부터 하지 말고 `getBoardForUser()`로 `deleted_at IS NULL` board를 먼저 읽는다.
- board가 없거나 다른 유저 소유면 `NotFoundException('Board not found.')`을 던진다. 현재처럼 `{ ok: false }`로 내려보내지 않는다.
- `client_session_id`, `cell_ids`, `free_position`이 없으면 completion board가 아니므로 `BadRequestException('Board snapshot is incomplete.')`를 던진다.
- custom board에서 `board_cells`가 비어 있으면 detail과 동일하게 `cell_ids` 기반 snapshot을 upsert한 뒤 summary를 계산한다.
- mission board에서 `mission_snapshot`이 누락된 cell이 있으면 완료 여부를 신뢰할 수 없으므로 incomplete로 간주하거나 snapshot incomplete 400으로 처리한다. 채택안은 `Board snapshot is incomplete.` 400이다.
- 이미 `ended_at`가 있는 board에 다시 호출하면 idempotent하게 성공 응답을 반환한다. 단, summary가 현재 기준으로도 fully completed일 때만 성공한다.
- `ended_at`가 없는 board만 새 완료 시각으로 update한다.
- 동시 요청 두 개가 들어와도 둘 다 성공할 수 있어야 한다. update query는 `.is('ended_at', null)` 조건을 붙이고, update 결과가 없으면 board를 다시 읽어 이미 닫혔는지 확인한다.
- 응답은 기존 `{ ok: boolean }`에 `board` summary를 추가한다. 기존 클라이언트가 `ok`만 읽어도 깨지지 않는다.
- 중도 포기는 이 endpoint가 아니라 `DELETE /v1/boards/current` 또는 `DELETE /v1/boards/:boardId`를 사용한다.
- `shares.service.ts`는 현재 `ended_at`만 보고 공유 가능 여부를 판단한다. end endpoint가 fully completed만 `ended_at`을 찍도록 바뀌면 공유 가능 조건도 자연스럽게 강화된다.

### 4. 완료 기준 계산 helper

프론트와 백엔드가 같은 완료 기준을 사용해야 하므로 `BoardsService`에 summary 계산 helper를 둔다.

후보 함수:

```ts
export interface BoardCompletionSummary {
  completedCount: number
  totalTargetCount: number
  isFullyCompleted: boolean
  completedAt: string | null
  photoCount: number
  clipCount: number
  mediaCount: number
}

export function summarizeBoardCompletion(
  board: BoardRow,
  cells: readonly BoardCellRow[],
): BoardCompletionSummary
```

완료 판정:

- `totalTargetCount`는 board mode의 전체 칸 수다. 첫 구현에서는 free cell도 완료된 칸으로 세어 `25/25`, `9/9` 표현과 맞춘다.
- `cell_ids.length`가 board mode 크기와 다르면 snapshot incomplete로 보고 `isFullyCompleted=false`를 반환한다. end endpoint에서는 이 상태를 400으로 승격한다.
- free position은 항상 완료로 계산한다.
- `photo_id`가 있으면 완료다.
- `clip_id`가 있으면 완료다.
- `marked_at` 또는 `completed_at`가 있으면 완료다.
- `completion_type`이 `photo`, `no_photo`, `clip`, `no_media`, `free` 중 하나면 완료다. 단, `completion_type='free'`는 free position에서만 신뢰한다.
- mission snapshot의 `noPhoto === true` 또는 `textOnly === true`는 사진 없이 완료 가능한 칸이다. 프론트가 marked position으로 보내면 `completion_type='no_media'`로 저장되고 완료로 계산한다. mission flag만 있고 완료 timestamp/type이 없는 cell은 완료로 세지 않는다.
- `isFullyCompleted`는 `completedCount === totalTargetCount`다.
- `completedAt`는 `board.ended_at`가 있으면 그것을 우선 사용하고, 없으면 null이다.
- `photoCount`와 `clipCount`는 cell 기준 count다. 같은 media id가 여러 cell에 연결되는 비정상 데이터가 있어도 UI 표시 기준은 cell completion count와 맞춘다.
- `mediaCount = photoCount + clipCount`다.
- 같은 position에 중복 row가 들어오는 상황은 PK 때문에 정상 DB에서는 불가능하지만, helper는 Set으로 position을 중복 제거한다.
- position이 board 크기 밖이거나 `cell_ids[position]`과 `cell.cell_id`가 맞지 않는 row는 completion count에서 제외한다. media count는 실제 cell row 기준으로 세되, 불일치 row를 count할지 여부는 테스트에서 고정한다. 채택안은 completion과 media count 모두 제외해 snapshot 기준 표시를 보호하는 것이다.

주의:

- 현재 `toHistoryItem()`은 free cell을 자동 완료로 세지 않을 수 있다. 완료 기록 UI의 `25/25` 표현과 맞추려면 helper에서 free position을 반드시 포함해야 한다.
- `board_cells` row가 비어 있는 custom board는 기존 detail 보정처럼 cell snapshot을 upsert한 뒤 계산한다.
- helper는 pure function으로 두고 export해서 `boards.service.spec.ts`에서 Supabase mock 없이 직접 검증한다.
- `toHistoryItem()`은 `summarizeBoardCompletion()`을 호출해 summary를 spread하고, `sessionId`, `status`, `thumbnailUrls`까지 채운다.

### 5. Query schema

`boards.schemas.ts`에 목록 query schema를 추가한다.

```ts
export const boardListStatusSchema = z.enum(['completed', 'active', 'all'])

export const boardListQuerySchema = z
  .object({
    status: boardListStatusSchema.default('all'),
    limit: z.coerce.number().int().min(1).max(50).default(50),
  })
  .default({})
```

구현 메모:

- `@Query(new ZodValidationPipe(boardListQuerySchema)) query: BoardListQueryInput` 형태를 우선 검토한다.
- 현재 `ZodValidationPipe`는 오류 메시지가 `Invalid request body.`로 고정되어 있다. query에 재사용하면 메시지가 어색할 수 있다. 작은 `parseBoardListQuery()` helper를 controller 내부에 두거나 pipe 메시지 옵션을 추가하는 선택지가 있다.
- 채택안은 작은 controller helper를 먼저 사용한다. pipe 메시지 일반화는 범위 밖으로 둔다.

## 구현 단계

### Phase 0. Query 계약 확정

- `src/boards/boards.schemas.ts`에 `boardListQuerySchema`, `BoardListQueryInput`을 추가한다.
- `status` 기본값은 `all`, `limit` 기본값은 `50`으로 고정한다.
- invalid `status`, invalid `limit`은 400으로 처리한다.
- `/v1/boards`와 `/api/boards` 양쪽 controller에서 같은 parser를 사용한다.

### Phase 1. Summary 계산 도입

- `src/boards/boards.service.ts`에 exported pure helper `summarizeBoardCompletion()`을 추가한다.
- `src/boards/boards.service.ts`의 `toHistoryItem()` 계산을 `summarizeBoardCompletion()` 기반으로 바꾼다.
- free cell 자동 완료 보정을 추가한다.
- `mediaCount = photoCount + clipCount`를 추가한다.
- `totalTargetCount`, `isFullyCompleted`, `completedAt`, `status`, `sessionId`, `thumbnailUrls`를 list/detail에 포함한다.
- position out of range, `cell_ids[position]` mismatch, duplicated position에 대한 helper 동작을 테스트로 고정한다.

### Phase 2. 목록 필터 확장

- `src/boards/boards.controller.ts`의 `GET /boards`에 query parsing을 추가한다.
- compatibility controller의 `GET /api/boards`에도 같은 query를 지원한다.
- `BoardsService.listUserBoards(userId, options)`로 확장한다.
- `status=completed`일 때 `ended_at IS NOT NULL` board를 우선 조회하고, summary 기준 `isFullyCompleted`인 항목만 반환한다.
- `status=active`일 때 `ended_at IS NULL` board만 조회한다.
- `status=all`은 기존 목록 동작을 유지하되 신규 summary 필드를 포함한다.

### Phase 3. End endpoint 방어 검증

- `BoardsService.endUserBoard()`에서 board와 cells를 읽고 summary를 계산한다.
- board가 없거나 deleted면 `NotFoundException`을 던진다.
- snapshot이 불완전하면 `BadRequestException('Board snapshot is incomplete.')`를 던진다.
- `isFullyCompleted`가 아니면 `BadRequestException`을 던진다.
- 이미 ended board가 fully completed이면 idempotent success를 반환한다.
- 응답에 최소 summary를 포함한다.
- controller 응답은 `{ ok: true, board: { ...summary } }`로 바꾼다.

### Phase 4. Detail 응답 보강

- `getUserBoardDetail()`이 반환하는 item에 summary 필드를 포함한다.
- detail cell에서 free position을 completion type `free`로 보정한다.
- 필요한 경우 `thumbnailUrls`는 목록 응답에서 비워두고 후속으로 poster/photo preview를 추출한다.
- mission board snapshot 누락 정책을 end/detail/list에서 일관되게 처리한다.

### Phase 5. 테스트

- 신규 `src/boards/boards.service.spec.ts`에 completion summary 테스트를 추가한다.
- `src/boards/boards.schemas.spec.ts`에 `boardListQuerySchema` 테스트를 추가한다.
- service 중심 테스트 또는 controller 단위 테스트로 `status=completed` 필터를 검증한다.
- `endUserBoard()`가 미완료 board를 거부하고 완료 board를 닫는지 검증한다.
- free cell이 `completedCount`에 포함되는지 검증한다.
- photo/clip/no_media completion type이 완료로 계산되는지 검증한다.
- 이미 닫힌 board의 end 재호출이 summary와 함께 성공하는지 검증한다.
- custom board의 빈 `board_cells` upsert 보정은 public method 테스트가 무거우면 수동 시나리오로 먼저 검증하고, 추후 integration test로 보강한다.

## 예상 변경 파일

- `/Users/oksang/Desktop/sappeun/sappeun-api/src/boards/boards.controller.ts`
- `/Users/oksang/Desktop/sappeun/sappeun-api/src/boards/boards.service.ts`
- `/Users/oksang/Desktop/sappeun/sappeun-api/src/boards/boards.schemas.ts`
- `/Users/oksang/Desktop/sappeun/sappeun-api/src/boards/boards.service.spec.ts`
- `/Users/oksang/Desktop/sappeun/sappeun-api/src/boards/boards.schemas.spec.ts`

첫 구현에서 DB migration은 필요하지 않다. 현재 `boards.ended_at`, `board_cells.completed_at`, `board_cells.completion_type`가 이미 존재하고, `completion_type` check constraint에 `photo`, `no_photo`, `clip`, `no_media`, `free`가 포함되어 있다.

성능 후속 과제:

- 완료 기록이 많아져 `status=completed` 조회가 느려지면 partial index를 추가한다.
- 후보 index: `(user_id, ended_at DESC) WHERE ended_at IS NOT NULL AND deleted_at IS NULL AND client_session_id IS NOT NULL`.
- 첫 구현은 기존 `boards_history_user_updated_idx`로 충분하다고 보고 migration을 만들지 않는다.

## 작업 체크리스트

- [ ] `boardListQuerySchema`와 query parser를 추가한다.
- [ ] completion summary helper를 추가한다.
- [ ] free position 자동 완료 계산을 추가한다.
- [ ] `GET /v1/boards`에 `status` query를 추가한다.
- [ ] `GET /api/boards` compatibility route에도 같은 query를 지원한다.
- [ ] `status=completed` 목록에서 active/incomplete board를 제외한다.
- [ ] 목록 응답에 `totalTargetCount`, `isFullyCompleted`, `completedAt`, `mediaCount`를 추가한다.
- [ ] 상세 응답에 같은 summary 필드를 추가한다.
- [ ] detail free cell 응답을 `completionType: 'free'`로 보정한다.
- [ ] `POST /v1/boards/:boardId/end`에서 완료 조건을 검증한다.
- [ ] 이미 닫힌 완료 board에 대한 end 호출을 idempotent하게 처리한다.
- [ ] service/controller/schema 테스트를 추가한다.
- [ ] `shares.service.ts`의 공유 가능 조건이 end 검증 강화와 충돌하지 않는지 smoke check한다.

## 검증 명령

```bash
cd /Users/oksang/Desktop/sappeun/sappeun-api
pnpm test -- boards.schemas boards.service
pnpm test -- boards
pnpm lint
pnpm build
```

`boards.service.spec.ts`가 새로 생기기 전에는 첫 번째 명령에서 service spec pattern이 매칭되지 않을 수 있다. 구현 후에는 두 명령 모두 통과해야 한다.

## 수동 확인 시나리오

- 로그인 유저가 `POST /v1/boards/session`으로 board를 ensure하면 `{ boardId }`가 반환된다.
- `GET /v1/boards?status=unknown`은 400을 반환한다.
- `GET /v1/boards?limit=0`과 `limit=51`은 400을 반환한다.
- 미완료 board에 `POST /v1/boards/:boardId/end`를 호출하면 400이 반환된다.
- 완료 board에 `POST /v1/boards/:boardId/end`를 호출하면 `endedAt`가 설정되고 summary가 반환된다.
- 같은 완료 board에 end를 다시 호출해도 중복 기록 없이 성공한다.
- `GET /v1/boards?status=completed`는 완료된 board만 반환한다.
- `GET /api/boards?status=completed`도 같은 필터를 지원한다.
- `GET /v1/boards?status=active`는 `endedAt: null` board만 반환한다.
- `GET /v1/boards` 또는 `status=all`은 기존 목록 호환성을 유지한다.
- `GET /v1/boards/:boardId`는 signed media preview와 summary 필드를 함께 반환한다.
- 완료 상세의 free cell은 `completionType: "free"`로 반환되고 `completedCount`에 포함된다.
- `DELETE /v1/boards/current`로 포기한 board는 완료 기록 목록에 나타나지 않는다.

## 결정 사항

- 채택: `GET /v1/boards?status=completed`를 사용한다. `/v1/boards/completed` 별도 route는 만들지 않는다.
- 채택: `thumbnailUrls`는 첫 구현에서 빈 배열로 둔다. 실제 썸네일 signed URL은 후속 확장이다.
- 채택: 게스트 완료 board 자동 승격은 첫 구현에서 제외한다. 게스트에게 로그인 유도를 제공하고, 로그인 후 `adopt-guest-session` 개선은 후속으로 둔다.
- 채택: `ended_at`를 완료 기록 시각으로 계속 사용한다. 별도 `completed_at` column은 추가하지 않는다.
- 채택: compatibility route `/api/boards`도 같은 query를 받는다. 신규 Flutter는 `/v1/boards`만 사용한다.
- 채택: `endUserBoard()`는 미완료 board에 대해 400을 던진다. 현재 `{ ok: false }` 반환 방식은 완료 close endpoint에서 사용하지 않는다.

## 남은 리스크와 후속 과제

- `status=completed`는 summary 후 필터링이라 DB 조회 `limit`과 최종 반환 개수가 다를 수 있다. 완전한 pagination이 필요해지면 cursor와 over-fetch 전략을 별도 설계한다.
- 목록 썸네일을 실제 URL로 제공하려면 photo/clip poster 후보 선정, signed URL 만료 시간, N+1 비용을 함께 설계해야 한다.
- custom board에서 빈 `board_cells`를 upsert하는 보정은 현재 detail 흐름과 맞지만, end endpoint에서도 같은 보정을 할 때 예상치 못한 row 생성이 발생할 수 있다. 이 동작은 테스트 또는 수동 확인으로 고정한다.
- `markedPositions`는 현재 `completion_type='no_media'`로 저장된다. 향후 `no_photo`와 `no_media`의 의미를 UI에서 구분하려면 프론트 입력과 DB 저장 타입을 더 세분화해야 한다.
- share 생성은 `ended_at`만 본다. end endpoint를 우회해 DB에서 `ended_at`가 찍힌 데이터가 생기면 share guard는 fully completed를 재검증하지 않는다. 운영 전에는 DB 직접 수정/관리자 도구 정책을 점검한다.

## 완료 기준

- Flutter가 신규 completion API 없이 기존 `boards` API로 완료 기록을 저장하고 조회할 수 있다.
- 미완료 board는 서버에서 완료 기록으로 닫히지 않는다.
- 완료 목록/detail/end 응답의 summary 값이 같은 helper 기준으로 일관된다.
- `/v1/boards` 신규 route와 `/api/boards` compatibility route가 query 없는 기존 호출을 계속 지원한다.
- 완료 기록 목록에 active/incomplete/deleted board가 섞이지 않는다.
- free cell이 완료 카운트에 포함되어 `25/25`, `9/9` 표현이 맞는다.
- 관련 테스트와 `pnpm lint`, `pnpm build`가 통과한다.
