# Runtime Mission/Badge Artwork — API / DB Plan

- Status: **draft implementation plan**
- Created: 2026-06-08
- Scope: Supabase DB, NestJS API, public R2 artwork storage, capability-gated mission/badge delivery
- Related frontend plan: `/Users/oksang/Desktop/sappeun/sappeun-frontend/plans/runtime-mission-badge-artwork-frontend.md`

## Goal

API/DB는 신규 미션/배지 아트워크를 앱 번들에 의존하지 않고 운영할 수 있는 runtime `artwork` contract를 제공한다.

한 번 runtime artwork 지원 앱이 배포된 뒤에는 신규 미션/배지 추가가 DB/API/R2 업데이트만으로 가능해야 한다.

## Current API / DB State

이미 존재하는 구조:

- `/Users/oksang/Desktop/sappeun/sappeun-api/src/missions/missions.service.ts`
  - `GET /v1/missions/content` payload assembly
- `/Users/oksang/Desktop/sappeun/sappeun-api/src/missions/missions.schemas.ts`
  - mission content response schema
- `/Users/oksang/Desktop/sappeun/sappeun-api/supabase/migrations/0010_mission_content.sql`
  - `mission_content`, `mission_categories`
- `/Users/oksang/Desktop/sappeun/sappeun-api/supabase/migrations/0011_mission_badges_content_fk.sql`
  - `mission_badges` → `mission_content` FK
- `/Users/oksang/Desktop/sappeun/sappeun-api/src/badges/badges.service.ts`
  - badge catalog/list/detail logic
- `/Users/oksang/Desktop/sappeun/sappeun-api/src/storage/r2.service.ts`
  - private user media용 R2 S3 client

주의:

- `mission_badges.artwork_key`는 현재 `mission/n01` 형태다. Flutter cue key로 직접 쓰기 어렵다.
- private user media bucket을 public artwork delivery에 재사용하면 안 된다.

## API / DB Decisions

### D1. JSONB first

v1에서는 정규화 registry table보다 additive JSONB column으로 시작한다.

- `mission_content.artwork jsonb null`
- `mission_badges.artwork jsonb null`

이유:

- `lucide`, `swatch`, `text`, `remoteImage` shape가 다르다.
- API contract를 빠르게 안정화할 수 있다.
- 이후 원격 이미지가 늘어나면 `artwork_assets` registry table을 추가할 수 있다.

### D2. Mission artwork ownership

- `mission_content.artwork`가 미션 기본 시각 core의 정본이다.
- `mission_badges.artwork`는 배지 전용 override가 필요할 때만 사용한다.
- badge catalog response는 `mission_badges.artwork ?? mission_content.artwork`를 내려준다.
- `mission_badges.artwork_key`는 하위 호환 필드로 유지한다.

### D3. Capability gate

구버전 앱에는 신규 remote-only mission/badge를 내려주지 않는다.

Client headers:

```http
X-Sappeun-App-Platform: ios
X-Sappeun-App-Version: 1.0.0
X-Sappeun-App-Build: 202606080001
X-Sappeun-Client-Capabilities: runtime-artwork-v1,swatch-hex-v1
```

필터 원칙:

- 헤더가 없으면 legacy client
- legacy client에는 `required_capabilities = '{}'`이고 `min_app_build is null`인 row만 반환
- `remoteImage` 신규 미션은 `required_capabilities`에 `runtime-artwork-v1`
- `colorHex` 신규 swatch 미션은 `required_capabilities`에 `swatch-hex-v1`

### D4. Public artwork storage is separate

사용자 촬영 media는 private R2 + signed URL이다. 공개 미션/배지 artwork는 별도 public bucket/custom domain을 쓴다.

권장 env:

```env
R2_PUBLIC_ASSET_BUCKET=
R2_PUBLIC_ASSET_BASE_URL=https://assets.sappeun.app
```

## Runtime Artwork Contract

Zod discriminated union 후보:

```ts
const artworkBaseSchema = z.object({
  schemaVersion: z.literal(1),
  alt: z.string().max(80).optional(),
  paletteMode: z.enum(['mono', 'fullColor']).default('mono').optional(),
})

const lucideArtworkSchema = artworkBaseSchema.extend({
  type: z.literal('lucide'),
  key: z.string().min(1).max(80),
})

const swatchArtworkSchema = artworkBaseSchema.extend({
  type: z.literal('swatch'),
  key: z.string().min(1).max(80).optional(),
  colorHex: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
  label: z.string().max(20).optional(),
  effect: z.enum(['solid', 'rainbow']).default('solid').optional(),
})

const textArtworkSchema = artworkBaseSchema.extend({
  type: z.literal('text'),
  label: z.string().min(1).max(4),
  fontSize: z.number().min(8).max(48).optional(),
})

const remoteImageArtworkSchema = artworkBaseSchema.extend({
  type: z.literal('remoteImage'),
  assetId: z.string().min(1).max(120),
  url: z.string().url(),
  contentHash: z.string().min(12).max(96),
  mimeType: z.enum(['image/webp', 'image/png']),
  width: z.number().int().positive().max(1024),
  height: z.number().int().positive().max(1024),
  fit: z.enum(['contain']).default('contain').optional(),
  fallback: z.lazy(() => artworkSpecSchema),
})
```

Policy:

- `remoteImage.url`은 HTTPS와 allowlisted host만 허용한다.
- `remoteImage.fallback`은 필수다.
- fallback chain은 최대 2단계로 제한한다.
- v1은 SVG를 허용하지 않는다.

## DB Plan

### Migration 0012 — runtime artwork columns

```sql
alter table public.mission_content
  add column if not exists artwork jsonb;

alter table public.mission_badges
  add column if not exists artwork jsonb;
```

초기 백필:

- `icon is not null` → `lucide`
- `swatch is not null` → `swatch`
- `text_only = true` → `text`
- `free`도 `camera` lucide artwork로 백필

### Migration 0013 — capability gate columns

```sql
alter table public.mission_content
  add column if not exists min_app_build integer,
  add column if not exists required_capabilities text[] not null default '{}',
  add column if not exists active_from timestamptz,
  add column if not exists active_until timestamptz;

alter table public.mission_badges
  add column if not exists min_app_build integer,
  add column if not exists required_capabilities text[] not null default '{}',
  add column if not exists active_from timestamptz,
  add column if not exists active_until timestamptz;
```

필터:

- `active = true`
- `active_from is null or active_from <= now()`
- `active_until is null or now() < active_until`
- `min_app_build is null or client_build >= min_app_build`
- `required_capabilities <@ client_capabilities`

### Optional Future Migration — artwork_assets

원격 이미지 수가 늘어나면 추가한다.

- `id text primary key`
- `object_key text not null`
- `public_url text not null`
- `content_hash text not null`
- `mime_type text not null`
- `width int not null`
- `height int not null`
- `palette_mode text not null`
- `fallback jsonb not null`
- `active bool not null default true`
- `created_at`, `updated_at`

v1에서는 필수 아님.

## API Plan

### Missions API

Files:

- `/Users/oksang/Desktop/sappeun/sappeun-api/src/missions/missions.schemas.ts`
- `/Users/oksang/Desktop/sappeun/sappeun-api/src/missions/missions.service.ts`
- `/Users/oksang/Desktop/sappeun/sappeun-api/src/missions/missions.controller.ts`

Tasks:

- [ ] `artworkSpecSchema` 추가
- [ ] `missionCellSchema.artwork` optional 추가
- [ ] `MISSION_CONTENT_SELECT`에 `artwork`, gate columns 추가
- [ ] request headers에서 app build/capabilities parse
- [ ] legacy client filter 적용
- [ ] response runtime validation 유지

### Badges API

Files:

- `/Users/oksang/Desktop/sappeun/sappeun-api/src/badges/badges.service.ts`
- `/Users/oksang/Desktop/sappeun/sappeun-api/src/badges/badges.schemas.ts`
- `/Users/oksang/Desktop/sappeun/sappeun-api/src/badges/badges.controller.ts`

Tasks:

- [ ] content join에 `mission_content.artwork` 추가
- [ ] `mission_badges.artwork` select 추가
- [ ] catalog response에 `artwork` 추가
- [ ] `artworkKey` legacy 유지
- [ ] capability/active window filter 적용

### Client Metadata Parser

공통 helper 후보:

- `/Users/oksang/Desktop/sappeun/sappeun-api/src/common/client-capabilities.ts`

Tasks:

- [ ] `X-Sappeun-App-Build` int parse
- [ ] `X-Sappeun-Client-Capabilities` comma-separated parse
- [ ] invalid header는 legacy client로 degrade
- [ ] 테스트 fixture 추가

## Public R2 Artwork Plan

### Storage

- Public bucket: `R2_PUBLIC_ASSET_BUCKET`
- Public base URL: `R2_PUBLIC_ASSET_BASE_URL`
- Object key: `mission-artwork/{assetId}.{hash}.{ext}`
- Cache-Control: `public, max-age=31536000, immutable`
- Replace policy: overwrite 금지, 새 hash URL 발행

### Upload Script

File candidate:

- `/Users/oksang/Desktop/sappeun/sappeun-api/scripts/upload-artwork-asset.mjs`

Inputs:

- local file path
- `assetId`
- `paletteMode`
- fallback artwork JSON

Validation:

- MIME: `image/webp`, `image/png`
- max dimension: 1024
- recommended dimension: 256 or 512 square
- max size: 200KB hard limit
- SHA-256 hash
- fallback spec parse

Output:

- uploaded public URL
- `remoteImage` artwork JSON
- optional SQL update snippet or direct DB upsert

## Implementation Phases

### Phase A0 — Baseline Verification

- [ ] 현재 `GET /v1/missions/content` 48 cells 확인
- [ ] 현재 `GET /v1/badges/catalog` `artworkKey` shape 확인
- [ ] `mission_badges` 모든 active row가 `mission_content`와 FK join 되는지 확인

### Phase A1 — Additive DB

- [ ] `0012_runtime_artwork.sql` 작성
- [ ] `0013_client_capability_gate.sql` 작성
- [ ] 기존 48개 row artwork 백필
- [ ] RLS/ACL 영향 없음 확인
- [ ] `SCHEMA_SNAPSHOT.md` 업데이트

### Phase A2 — API Contract

- [ ] Zod schema 추가
- [ ] missions response에 `artwork` 추가
- [ ] badges catalog response에 `artwork` 추가
- [ ] header parser 추가
- [ ] capability filter 추가

### Phase A3 — Public R2 Assets

- [ ] public bucket/domain 결정
- [ ] env schema와 `.env.example` 업데이트
- [ ] upload script 작성
- [ ] staging asset 1개 업로드

### Phase A4 — Staging Rehearsal

- [ ] `remoteImage` 신규 mission 1개 staging 추가
- [ ] `colorHex` 신규 swatch mission 1개 staging 추가
- [ ] legacy header 없음 → 신규 mission 미노출 확인
- [ ] runtime capability header 있음 → 신규 mission 노출 확인

## Acceptance Criteria

1. API 응답에 `artwork`가 additive로 포함되고 기존 legacy fields는 유지된다.
2. 기존 앱 요청에는 신규 `required_capabilities` mission/badge가 내려가지 않는다.
3. runtime capability header가 있는 요청에는 신규 mission/badge가 내려간다.
4. `remoteImage` artwork는 public immutable URL과 `contentHash`를 포함한다.
5. public artwork bucket/domain은 private user media bucket을 노출하지 않는다.
6. `GET /v1/badges/catalog`는 `mission_badges.artwork ?? mission_content.artwork` 우선순위로 `artwork`를 반환한다.
7. 기존 48개 mission/badge API 응답은 기존 클라이언트와 호환된다.

## Verification

SQL:

```sql
select count(*) as missing_artwork
from public.mission_content
where active = true
  and artwork is null;
```

Expected after backfill: `0`.

```sql
select count(*) as gated_rows
from public.mission_content
where required_capabilities <> '{}';
```

Expected during rehearsal: `>= 1`.

API tests:

- `GET /v1/missions/content` without capability header excludes gated row
- `GET /v1/missions/content` with `runtime-artwork-v1` includes gated row
- `GET /v1/badges/catalog` emits artwork fallback from mission content
- invalid artwork JSON fails seed/validation before production response

Manual:

- Upload staging remote image asset
- Confirm public URL loads without signed query
- Confirm private media object is not reachable through public artwork domain

## Risks

| 리스크 | 완화 |
|---|---|
| 구버전 앱에 신규 mission 노출 | capability gate를 API 필터로 강제 |
| private media bucket accidentally public | public artwork bucket/domain 분리 |
| bad artwork JSON이 production response에 섞임 | Zod runtime validation + upload script validation |
| URL overwrite/cache poisoning | content-hash immutable object key |
| SVG sanitizer 부담 | v1은 PNG/WebP만 허용 |

## Out Of Scope

- Flutter parser/renderer/cache 구현
- Flutter golden/widget tests
- 운영 CMS UI
- 사용자 촬영 media storage 변경
