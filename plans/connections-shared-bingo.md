# 기획서: 유저 연결 & 공유 빙고 (Deep Interview Spec)

## Metadata
- Interview ID: di-sappeun-connections-2026-07-13
- Rounds: 9 (토폴로지 Round 0 포함 시 10)
- Final Ambiguity Score: 14.5%
- Type: brownfield (sappeun-api — NestJS 11 + Supabase + Cloudflare R2)
- Generated: 2026-07-13
- Threshold: 0.2 (20%)
- Threshold Source: default
- Initial Context Summarized: no
- Status: **PASSED**

## Clarity Breakdown
| Dimension | Score | Weight | Weighted |
|-----------|-------|--------|----------|
| Goal Clarity | 0.90 | 0.35 | 0.315 |
| Constraint Clarity | 0.85 | 0.25 | 0.213 |
| Success Criteria | 0.80 | 0.25 | 0.200 |
| Context Clarity | 0.85 | 0.15 | 0.128 |
| **Total Clarity** | | | **0.855** |
| **Ambiguity** | | | **0.145 (14.5%)** |

## Topology

| Component | Status | Description | Coverage / Deferral Note |
|-----------|--------|-------------|--------------------------|
| 유저 연결 시스템 | active | 관계 라벨(연인/친구/가족)을 가진 그룹 단위 연결. 초대 코드 + 수락 흐름 | 수용 기준 AC-1 ~ AC-6, AC-13 ~ AC-16 |
| 공유 빙고 | active | 그룹 소유의 데일리 3x3 빙고를 그룹원이 공동 진행 | 수용 기준 AC-7 ~ AC-12 |
| 여행 지도 (시/군 사진 채우기) | **deferred** | 한국 시/군 지도의 빈 영역을 함께 찍은 사진으로 채우는 기능 | 유저가 Round 0에서 2차 분리 확정 (2026-07-13). 부록 A에 아이디어 스케치만 보존 |

## Goal

사뿐 유저가 다른 유저와 **그룹 단위로 연결**(연인/친구/가족 등 라벨 선택, 한 유저가 여러 그룹 동시 소속 가능)하고, 각 그룹마다 **그룹 소유의 데일리 3x3 빙고 보드**를 공동 진행할 수 있게 한다. 그룹원 중 누구든 셀에 미디어를 올리면 그 셀은 그룹 기준으로 완료되고(다른 멤버도 같은 셀에 자기 미디어 추가 가능), 보드가 완성되면 그룹원 전원이 동일하게 뱃지와 스트릭을 받는다. 혼자 쓰는 유저는 기존 개인 보드를 그대로 사용하므로 아무 영향이 없다.

## 핵심 확정 사항 (인터뷰 결정 요약)

1. **연결 = 그룹**: 모든 연결은 1:1 쌍이 아니라 그룹 단위. 가족처럼 3명 이상도 하나의 그룹. 연인도 "2명짜리 그룹".
2. **관계 유형은 라벨/테마일 뿐**: 연인/친구/가족은 그룹의 표시 메타데이터(이름·아이콘·테마)이며 기능적 차이 없음. 유형별 전용 미션·제한은 향후 확장 지점으로만 남김.
3. **연결 성립 = 초대 코드 + 수락**: 그룹 생성 → 초대 코드/링크 발급(카톡 공유) → 상대가 코드 입력 시 합류 "요청" → 기존 그룹원이 수락해야 합류 확정.
4. **보드 소유권**: 그룹 보드는 `group_id` 소유. 유저는 소속 그룹 수만큼 하루에 여러 보드 플레이 가능 (연인 보드 + 친구 보드 + 개인 보드 …).
5. **솔로 = 기존 개인 보드 그대로**: 개인 데일리 보드(`user_id` 소유)는 코드·데이터 무변경. 그룹 보드는 순수 신규 추가. 마이그레이션 없음.
6. **셀 완료 = 한 명만 올려도 완료** (협력 분담 플레이): 그룹원 중 한 명이 미디어를 올리면 셀은 그룹 기준 완료. 다른 멤버도 원하면 같은 셀에 자기 미디어를 추가 업로드 가능 (셀 하나에 멤버별 미디어 N개 공존).
7. **보상 = 전원 동일 지급**: 보드 완료 시 기여도 무관하게 그룹원 전원이 같은 뱃지 획득 + 각자 스트릭 +1.
8. **보드 생성 = 자동, 리롤 = 공유**: 그날 첫 접속한 멤버 시점에 그룹 보드 자동 생성. 리롤은 아무 멤버나 가능하되 보드 단위 공유 카운터 사용, 첫 미디어 업로드 후 리롤 잠금.
9. **운영 정책 기본값**:
   - 탈퇴: 언제든 가능. 과거 그룹 보드·미디어는 그룹에 잔존(본인 업로드 미디어는 본인이 개별 삭제 가능). 기지급 뱃지/스트릭 회수 없음.
   - 그룹 소멸: 마지막 멤버 탈퇴 시 그룹 soft-delete.
   - 수량 제한: 유저당 소속 그룹 최대 **5개**, 그룹당 멤버 최대 **6명**, 초대 코드 유효기간 **7일**.
   - 재합류: 탈퇴 후 새 초대로 재합류 가능.

## Constraints

- 기존 개인 데일리 빙고 흐름(보드 생성/리롤/셀 마킹/뱃지/스트릭/공유)은 회귀 없이 그대로 동작해야 한다.
- 기존 스키마 패턴 준수: Supabase 순수 SQL 마이그레이션(`supabase/migrations/00NN_*.sql`), RLS는 소유 기반, 서버 쓰기는 service-role, 미디어는 R2 presign → confirm RPC 3단계.
- 그룹 데이터 접근은 RLS로 "해당 그룹의 활성 멤버"에게만 허용.
- 그룹 보드 동시 생성 방지: `(group_id, daily_date)` 유니크 제약으로 그날 그룹당 1보드 강제.
- 리롤 카운터는 그룹 보드 단위 공유이며 원자적 증가(기존 `reroll_board()` RPC 패턴 확장), 첫 미디어 업로드 이후 잠금.
- 유저당 그룹 5개 / 그룹당 6명 / 초대 코드 7일 만료는 서버에서 강제.
- 개인 보드의 KST 데일리 라이프사이클(active/grace/expired, `closeExpiredBoard`)을 그룹 보드에도 동일 적용.

## Non-Goals (이번 기획에서 명시적으로 제외)

- **여행 지도(시/군 사진 채우기)**: 2차로 분리 (부록 A에 스케치만 보존).
- 관계 유형별 기능 차별화(전용 미션, 인원 제한, 다른 UI) — 라벨/테마만 제공, 차별화는 향후 확장 지점.
- 기존 개인 보드의 그룹(1인 그룹) 이관/마이그레이션.
- 닉네임 검색 기반 매칭, 추천/디스커버리(데이트앱식 탐색) — 초대 코드로만 연결.
- 그룹 채팅, 댓글 등 커뮤니케이션 기능.
- 실시간 푸시/웹소켓 동기화 — 1차는 조회 시점 갱신(폴링/새로고침)으로 충분, 실시간은 향후 검토.
- 뱃지 기여도 차등 지급, 그룹 전용 뱃지 카탈로그.

## Acceptance Criteria

**유저 연결 시스템**
- [ ] AC-1: 유저가 그룹을 생성할 수 있다 (관계 라벨 선택: 연인/친구/가족/커스텀, 그룹 이름).
- [ ] AC-2: 그룹 멤버가 초대 코드/링크를 발급할 수 있고, 코드는 발급 후 7일에 만료된다.
- [ ] AC-3: 상대가 유효한 코드를 입력하면 합류 요청이 생성되고, 기존 그룹원 중 1명이 수락해야 멤버로 확정된다 (거절도 가능).
- [ ] AC-4: 유저당 소속 그룹이 5개를 초과하는 합류/생성은 명시적 에러로 거부된다.
- [ ] AC-5: 그룹당 멤버가 6명을 초과하는 수락은 명시적 에러로 거부된다.
- [ ] AC-6: 멤버는 언제든 탈퇴할 수 있고, 마지막 멤버가 탈퇴하면 그룹은 soft-delete 된다.

**공유 빙고**
- [ ] AC-7: 그날 첫 접속한 멤버가 그룹 보드를 조회하면 오늘의 그룹 보드가 자동 생성된다. 동시 접속에도 `(group_id, daily_date)` 유니크로 보드는 1개만 생성된다.
- [ ] AC-8: 아무 멤버나 리롤할 수 있고 카운터는 보드 단위로 공유되며, 어떤 멤버든 첫 미디어를 올린 뒤에는 리롤이 잠긴다.
- [ ] AC-9: 멤버 A가 셀에 사진/영상을 올리면 그 셀은 그룹 기준 완료로 표시된다.
- [ ] AC-10: 멤버 B는 이미 완료된 같은 셀에 자기 미디어를 추가로 올릴 수 있다 (셀 상세에서 멤버별 미디어 모두 조회 가능).
- [ ] AC-11: 그룹 보드가 완료되면 그룹원 전원에게 동일 뱃지가 지급되고(`user_badges` 전원 upsert), 각자의 스트릭에 +1 반영된다.
- [ ] AC-12: 그룹 보드에는 개인 보드와 동일한 KST 데일리 라이프사이클(grace/만료 자동 종료)이 적용된다.

**데이터/보안/회귀**
- [ ] AC-13: 그룹·그룹보드·셀 미디어는 RLS로 활성 멤버만 접근 가능하다 (비멤버 401/403 또는 not-found).
- [ ] AC-14: 탈퇴자가 올렸던 미디어와 완료 기록은 그룹 보드에 남고, 탈퇴자는 자기 미디어를 개별 삭제할 수 있으며, 기지급 뱃지/스트릭은 회수되지 않는다.
- [ ] AC-15: 기존 개인 보드 관련 전체 테스트가 무변경 통과한다 (회귀 없음).
- [ ] AC-16: 유저 A의 홈에서 오늘 플레이 가능한 보드 목록(개인 보드 + 소속 그룹 보드들)을 한 번에 조회할 수 있다.

## Assumptions Exposed & Resolved

| 가정 | 어떻게 검증했나 | 결정 |
|------|----------------|------|
| 연결은 1:1 쌍일 것이다 | Round 1에서 구조 직접 질문 | **그룹 단위** (3명 이상 가능) |
| 유저는 하루 1보드를 유지할 것이다 | Round 2에서 다중 그룹 시나리오 제시 | **그룹마다 별도 보드**, 유저는 하루 여러 보드 |
| 관계 유형이 기능을 바꿀 것이다 | Round 5 컨트래리언 모드 ("유형이 없다면?") | **라벨/테마일 뿐**, 기능 동일 |
| 솔로 모드를 새로 만들어야 한다 | Round 7 심플리파이어 모드 ("이미 있지 않나?") | **기존 개인 보드가 곧 솔로 모드**, 신규 개념 불필요 |
| 셀 완료는 전원 참여가 필요할 것이다 | Round 4에서 두 모델 비교 제시 | **한 명만 올려도 완료** (협력 분담) |
| 보상은 기여도 비례일 것이다 | Round 6에서 기여 불균형 예시 제시 | **전원 동일 지급** |
| 보드 생성/리롤에 권한자가 필요할 것이다 | Round 8에서 그룹장 모델 vs 자동 모델 비교 | **자동 생성 + 리롤 공유 카운터** |

## Technical Context (brownfield 탐색 결과 + 설계 방향)

### 현재 시스템 (탐색 확정 사실)
- 스택: NestJS 11 + Supabase(PostgreSQL 17, `@supabase/supabase-js` 직접 쿼리, ORM 없음) + Cloudflare R2. 인증은 Supabase JWT (`src/auth/supabase-auth.guard.ts`).
- 빙고: `public.boards`(user_id 소유, `daily_date`, `reroll_count`, `boards_user_daily_uidx (user_id, daily_date)`), `public.board_cells`(PK `(board_id, position)`, `photo_id`/`clip_id` 단일 미디어 제약, 미션 스냅샷 컬럼). 핵심 로직 `src/boards/boards.service.ts` (2,238줄).
- 미디어: presign → 클라이언트 직접 업로드 → confirm RPC(`confirm_user_photo_upload`/`confirm_user_clip_upload`)가 `board_cells`에 원자 반영.
- 뱃지: `mission_badges`/`board_badges(user_id 있음)`/`user_badges`, 지급은 `BadgesService.awardBoardBadges()` (`src/badges/badges.service.ts:291`).
- **유저 간 연결 관련 코드는 전무** (couple/friend/invite/follow 등 검색 결과 0건). 유일한 타인 공유는 `shares`(완성 보드 읽기 전용 공개 링크).
- 마이그레이션: `supabase/migrations/0001`~`0020` 순수 SQL. 다음 번호 0021부터 사용.

### 신규 테이블 설계 방향 (구현 계획에서 상세화)
- `connection_groups`: id, name, relationship_label(lover/friend/family/custom), theme/emoji, created_by, created_at, deleted_at(soft-delete)
- `connection_group_members`: PK (group_id, user_id), joined_at, left_at (탈퇴 이력 보존)
- `connection_group_invites`: id, group_id, invite_code(unique), created_by, expires_at(+7일), revoked_at
- `connection_group_join_requests`: id, group_id, user_id, invite_id, status(pending/approved/rejected), decided_by, decided_at
- 그룹 보드: `boards`에 nullable `group_id` 추가 + `(group_id, daily_date)` partial unique, 또는 별도 `group_boards` 테이블 — **구현 계획 단계에서 트레이드오프 결정** (기존 `boards_user_daily_uidx`·RLS와의 간섭 최소화가 판단 기준)
- 셀 멤버별 미디어: `group_board_cell_media` (board_id, position, user_id) → photo_id/clip_id — 기존 `board_cells` 단일 미디어 제약과 분리
- 뱃지/스트릭: `awardBoardBadges()`를 "보드 1개 → 멤버 N명 팬아웃"으로 확장, 스트릭 판정에 그룹 보드 완료 포함

### 재사용 가능한 기존 인프라
- 초대 코드 생성: `shares.share_code` 패턴 재사용
- 리롤 원자성: `reroll_board()` SECURITY DEFINER RPC 패턴 확장
- 미디어 confirm: `confirm_user_*_upload` RPC에 그룹 보드 분기 추가 (또는 그룹 전용 RPC 신설)
- 데일리 라이프사이클: `computeLifecycle`/`closeExpiredBoard`/KST 날짜 로직 재사용

## Ontology (Key Entities)

| Entity | Type | Fields | Relationships |
|--------|------|--------|---------------|
| User (profiles) | core domain (기존) | user_id, nickname, display_name | User는 여러 ConnectionGroup에 소속 |
| ConnectionGroup | core domain (신규) | id, name, relationship_label, theme, deleted_at | Group은 GroupMember 2~6명 보유, GroupBoard 1일 1개 |
| GroupMember | supporting (신규) | group_id, user_id, joined_at, left_at | User↔Group 다대다 연결 |
| GroupInvite | supporting (신규) | invite_code, expires_at, created_by | Group이 발급, JoinRequest로 소비 |
| JoinRequest | supporting (신규) | group_id, user_id, status, decided_by | Invite 사용 → 기존 멤버 수락으로 확정 |
| GroupBoard | core domain (신규) | group_id, daily_date, reroll_count, end_reason | Group 소유, BoardCell 9개 |
| BoardCell | core domain (기존 확장) | board_id, position, completed_at, mission_snapshot | 첫 업로드 멤버가 완료 트리거 |
| CellMedia | core domain (신규) | board_id, position, user_id, photo_id/clip_id | 셀당 멤버별 N개 미디어 |
| Badge/Streak | supporting (기존) | user_badges, board_badges, streak | 보드 완료 시 전 멤버 팬아웃 지급 |
| TravelMap | deferred | 시/군 영역, 지역 사진 | 2차 기획 (부록 A) |

## Ontology Convergence

| Round | Entity Count | New | Changed | Stable | Stability Ratio |
|-------|-------------|-----|---------|--------|----------------|
| 1 | 7 | 7 | - | - | N/A |
| 2 | 8 | 1 (GroupBoard) | 3 (Connection→Group 계열, Media→CellMedia) | 4 | 88% |
| 3 | 9 | 1 (GroupInvite/JoinRequest) | 0 | 8 | 89% |
| 4~9 | 9~10 | 0 | 0 | 전체 | **100% (6라운드 연속)** |

도메인 모델은 Round 4 이후 완전히 수렴했다.

## 부록 A: 여행 지도 (2차 기획 스케치 — 이번 범위 아님)

- 한국 시/군 단위 행정구역 지도의 빈 영역을 그룹(또는 개인)이 찍은 사진으로 채우는 컬렉션 기능.
- 그룹 단위 공동 진행 전제 → 이번에 만드는 `connection_groups` 인프라를 그대로 소유 주체로 재사용 가능.
- 미해결 질문(2차 인터뷰 대상): 사진의 지역 판정 방식(EXIF GPS vs 수동 선택), 시/군 경계 데이터 소스(GeoJSON), 영역당 사진 수, 개인 지도와 그룹 지도의 관계, 달성률 보상.

## Interview Transcript

<details>
<summary>전체 Q&A (Round 0 + 9 rounds)</summary>

### Round 0 — 토폴로지 확인
**Q:** 3개 컴포넌트(유저 연결 / 공유 빙고 / 여행 지도)로 읽었는데 맞나?
**A:** 여행 지도는 2차로 분리.

### Round 1 — 연결 구조 (유저 연결 / Goal)
**Q:** 연결은 1:1 쌍인가, 그룹인가? 유형별 개수 제한은?
**A:** 그룹 연결 필요 (가족 등 3명 이상 한 그룹).
**모호도:** 76%

### Round 2 — 빙고 공유 모델 (공유 빙고 / Goal)
**Q:** 여러 그룹 소속 시 오늘의 빙고는?
**A:** 그룹마다 별도 보드. 보드 소유권은 그룹, 하루 보드 수는 소속 그룹 수만큼.
**모호도:** 67%

### Round 3 — 연결 성립 (유저 연결 / Goal)
**Q:** 그룹 생성과 합류 방식은?
**A:** 초대 코드 + 수락 단계 (코드 입력 → 기존 그룹원 수락 → 합류 확정).
**모호도:** 65%

### Round 4 — 셀 완료 판정 (공유 빙고 / Success Criteria)
**Q:** 그룹 보드에서 셀 완료 기준은?
**A:** 한 명만 올려도 완료 (다른 멤버는 원하면 추가 업로드).
**모호도:** 55%

### Round 5 — 유형의 의미 (유저 연결 / Constraints, 컨트래리언 모드)
**Q:** 관계 유형이 없다면 뭐가 달라지나? 기능인가 라벨인가?
**A:** 라벨/테마일 뿐 (기능 동일).
**모호도:** 49%

### Round 6 — 보상 귀속 (공유 빙고 / Constraints)
**Q:** 보드 완료 시 뱃지/스트릭 처리는? (기여 불균형 예시)
**A:** 전원 동일 지급 (기여도 무관).
**모호도:** 37%

### Round 7 — 솔로 모델링 (유저 연결 / Goal, 심플리파이어 모드)
**Q:** 솔로 모드를 새로 만들 필요가 있나? 기존 개인 보드로 충분하지 않나?
**A:** 솔로 = 기존 개인 보드 그대로 (그룹 보드만 신규, 마이그레이션 없음).
**모호도:** 29%

### Round 8 — 보드 생성/리롤 (공유 빙고 / Constraints)
**Q:** 그룹 보드는 누가 만들고 리롤은 누가?
**A:** 첫 접속 멤버 시점 자동 생성 + 리롤은 아무 멤버나(보드 단위 공유 카운터), 첫 미디어 업로드 후 잠금.
**모호도:** 25%

### Round 9 — 운영 정책 (유저 연결 / Constraints)
**Q:** 탈퇴/소멸/수량 제한/재합류 기본값 패키지 수락?
**A:** 기본값 수락 (탈퇴 시 데이터 잔존·뱃지 회수 없음, 마지막 멤버 탈퇴 시 soft-delete, 그룹 5개/멤버 6명/코드 7일, 재합류 가능).
**모호도:** 14.5% ✅ PASSED

</details>
