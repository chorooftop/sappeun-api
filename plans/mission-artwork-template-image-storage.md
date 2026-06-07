# Mission Artwork Template Image Storage Plan

- Status: implemented in API asset pipeline
- Created: 2026-06-08
- Scope: Pencil export, API artifact pipeline, R2 public mission artwork, DB `remoteImage` metadata, frontend tint/effect contract

## Goal

R2에 저장되는 신규 미션 일러스트는 최종 컬러 이미지가 아니라 프론트엔드가 색과 효과를 입힐 수 있는 template image여야 한다.

최종 목표는 다음과 같다.

- R2 object는 투명 배경의 단색 alpha-mask PNG만 저장한다.
- 색상, 카테고리 tone, 선택/완료 상태, rainbow/sparkle 효과는 프론트엔드 렌더링 단계에서 적용한다.
- DB `remoteImage.paletteMode = 'mono'`는 "RGB를 그대로 쓰지 말고 alpha template로 tint하라"는 계약이 된다.
- full-color artwork가 필요한 예외가 생길 때만 `paletteMode = 'fullColor'`를 사용한다.

## Review Findings

초안에서 보강해야 할 지점은 네 가지다.

- `#000000` 단색 정규화는 alpha mask로는 동작하지만, Web/CSS가 luminance mask로 해석될 때 shape가 사라질 수 있다. canonical visible RGB는 `#FFFFFF`로 둔다.
- template image가 단순히 "단색 PNG"인지, 실제로 프론트가 tint/rainbow를 적용 가능한 "alpha matte"인지 검증 기준이 더 필요하다.
- 이미 R2에 업로드한 object는 final delivery가 아니라 provisional object로 분리해서 관리해야 한다.
- `0014` DB seed 적용 gate가 "R2 업로드 완료"가 아니라 "template 검증 + public custom domain 검증 + frontend mask 렌더링 확인"까지여야 한다.

## Current State

관련 파일:

- `/Users/oksang/Desktop/sappeun/sappeun-api/artifacts/mission-artwork/v1.4-pencil-export/png`
- `/Users/oksang/Desktop/sappeun/sappeun-api/artifacts/mission-artwork/v1.4-pencil-export/manifest.json`
- `/Users/oksang/Desktop/sappeun/sappeun-api/scripts/gen-mission-expansion-seed.mjs`
- `/Users/oksang/Desktop/sappeun/sappeun-api/scripts/upload-mission-expansion-artwork.mjs`
- `/Users/oksang/Desktop/sappeun/sappeun-api/src/common/artwork.schemas.ts`
- `/Users/oksang/Desktop/sappeun/sappeun-api/supabase/migrations/0014_bingo_mission_expansion.sql`

현재 PNG는 RGBA이며 `manifest.json`과 `0014_bingo_mission_expansion.sql`의 `remoteImage`는 `paletteMode: "mono"`로 생성된다.

문제는 `paletteMode: "mono"`가 저장 asset의 pixel-level 규칙까지 보장하지 않는다는 점이다. 따라서 최종 R2 업로드 전에 PNG 자체가 template image인지 자동 검증해야 한다.

구현 상태:

- `pnpm normalize:mission-artwork`가 raw Pencil export에서 foreground component를 추출하고, `#FFFFFF` visible RGB + alpha matte PNG를 생성한다.
- `pnpm gen:mission-expansion-seed`는 정규화된 PNG만 읽으며, raw export를 배포 PNG로 복사하지 않는다.
- `pnpm upload:mission-expansion-artwork -- --dry-run`과 실제 upload path는 template validation을 선행한다.
- `src/missions/mission-expansion-seed.spec.ts`는 manifest hash, migration URL, PNG pixel-level template contract를 함께 검증한다.

## Storage Contract

`remoteImage.paletteMode = "mono"` asset은 아래 조건을 모두 만족해야 한다.

- PNG RGBA, 투명 배경.
- 정사각형 canvas. 권장 크기: 144x144. 색상 swatch 계열처럼 의도적으로 작게 쓰는 asset은 128x128까지 허용한다.
- alpha channel이 실제 shape의 정본이다.
- 모든 non-transparent pixel의 RGB는 단일 값으로 정규화한다. 기본값은 white `#FFFFFF`.
- alpha가 0인 pixel의 RGB도 `#000000`으로 정규화한다.
- antialiasing은 RGB가 아니라 alpha 값으로만 표현한다.
- 그림자, 배경, baked-in gradient, baked-in category color, baked-in rainbow는 금지한다.
- 파일명과 R2 object key는 content hash 기반으로 유지한다.

왜 `#FFFFFF`인가:

- Flutter/Skia에서는 alpha를 mask로 쓰면 RGB가 의미 없지만, raw image preview와 일부 shader path에서 white matte가 더 예측 가능하다.
- Web CSS `mask-image`가 alpha가 아니라 luminance로 해석되는 경우에도 white shape는 유지된다.
- 투명 pixel RGB는 `#000000`으로 두어 premultiplied-alpha 경계 artifact를 줄인다.

예외:

- RGB를 그대로 렌더링해야 하는 asset은 `paletteMode = "fullColor"`로 저장한다.
- `fullColor` asset은 프론트엔드 tint/rainbow/sparkle 대상이 아니다.
- v1에서는 R2 SVG를 허용하지 않는다. 현재 API schema가 PNG/WebP만 허용하므로, template source가 vector여도 delivery artifact는 PNG다.

## Pipeline

### Phase 1: Pencil Export

- Pencil에서 각 mission node를 투명 배경으로 export한다.
- export 결과는 raw input으로만 취급하고, 바로 R2에 올리지 않는다.
- raw export 위치는 `/Users/oksang/Desktop/sappeun/sappeun-api/artifacts/mission-artwork/v1.4-pencil-export/raw-node-export`를 사용한다.
- raw export는 재생성 가능한 로컬 입력물이므로 git에는 커밋하지 않는다. fresh clone/CI 검증은 committed template PNG와 manifest를 기준으로 수행한다.

### Phase 2: Template Normalization

새 스크립트를 추가한다.

- 파일: `/Users/oksang/Desktop/sappeun/sappeun-api/scripts/normalize-mission-artwork-template.mjs`
- 입력: raw PNG directory
- 출력: `/Users/oksang/Desktop/sappeun/sappeun-api/artifacts/mission-artwork/v1.4-pencil-export/png`
- 권장 dependency: `pngjs` dev dependency. Pixel-level 검증/변환에 충분하고 native build 의존성이 없다.
- package script: `normalize:mission-artwork`

정규화 규칙:

```text
1. raw RGBA PNG에서 source alpha와 luminance를 기준으로 foreground candidate pixel을 찾는다.
2. 8-connected component로 candidate를 묶는다.
3. canvas edge에 닿은 component, canvas 대부분을 채우는 component, 너무 작은 noise component는 제거한다.
4. 남은 foreground pixel:
   r = 255, g = 255, b = 255
   a = source luminance 기반 alpha matte
5. 그 외 pixel:
   r = 0, g = 0, b = 0, a = 0
```

주의:

- 원본 export에 여러 색이 섞여 있어도 RGB 색상 정보는 제거하고 shape/명암은 alpha로만 보존한다.
- 현재 Pencil raw export에는 카드/원형 배경이 포함될 수 있으므로, normalizer는 edge component 제거와 foreground component 추출을 수행한다.
- 추출 결과가 시각적으로 잘못되면 threshold를 무작정 완화하지 말고 Pencil source/export를 먼저 확인한다.
- 자동 추출은 배경 제거 툴이 아니라 "현재 디자인 시스템의 export 형태에 맞춘 deterministic foreground extractor"로 취급한다.
- normalize 결과가 기존 PNG와 byte-identical하지 않을 수 있으므로 `contentHash`, object key, DB URL은 반드시 재생성한다.

### Phase 2.5: Color-Swatch Mission Policy

`color` 카테고리 미션은 두 종류의 시각 정보가 동시에 존재할 수 있다.

- 미션의 target color: `swatch`, `swatch_label`, `colorHex`, `swatch-hex-v1`
- 미션 일러스트 shape: `remoteImage.paletteMode = "mono"`

정책:

- color mission의 R2 image도 template PNG다. 예: "주황색" 미션의 이미지 자체를 주황색으로 굽지 않는다.
- target color 표현은 DB swatch metadata와 프론트 렌더링에서 처리한다.
- rainbow/알록달록 효과는 image asset이 아니라 `swatch.effect = "rainbow"` 또는 프론트 상태/effect layer로 표현한다.
- template PNG는 색깔 힌트를 담지 않는다. 색깔 힌트가 필요한 UI는 swatch chip, border, gradient overlay로 처리한다.

### Phase 3: Validation

새 검증을 generator/test에 연결한다.

검증 항목:

- manifest image count는 102.
- 모든 manifest image file이 존재한다.
- 모든 PNG가 alpha channel을 가진다.
- 모든 PNG가 128x128 또는 144x144 정사각형이다.
- 파일 크기는 기존 기준처럼 200KB 이하.
- `paletteMode = "mono"`인 image는 모든 visible pixel RGB가 `#FFFFFF`이다.
- alpha가 0인 pixel RGB는 `#000000`이다.
- alpha bounding box가 비어 있지 않다.
- 투명 pixel 비율이 너무 낮으면 실패한다. 예: 144x144 기준 opaque/full-background로 보이는 asset은 실패.
- alpha 값 종류가 1개뿐이면 경고한다. 완전한 hard-edge icon은 가능하지만, 대부분의 일러스트는 antialiasing 때문에 여러 alpha value를 갖는다.
- opaque pixel의 bounding box가 canvas 전체와 같으면 실패한다. 배경이 같이 export됐을 가능성이 높다.
- `contentHash`는 정규화 이후 bytes의 SHA-256이어야 한다.
- `0014_bingo_mission_expansion.sql`과 `manifest.json`은 generator output과 byte-identical이어야 한다.

검증 명령 후보:

```bash
pnpm verify:mission-expansion-artwork
pnpm gen:mission-expansion-seed
pnpm test src/missions/mission-expansion-seed.spec.ts
pnpm upload:mission-expansion-artwork -- --dry-run
```

`pnpm normalize:mission-artwork`는 Pencil raw export를 다시 받은 작업자가 template PNG를 재생성할 때만 실행한다.

테스트 보강:

- `/Users/oksang/Desktop/sappeun/sappeun-api/src/missions/mission-expansion-seed.spec.ts`에 pixel-level template validation을 추가한다.
- 검증 helper는 generator와 upload script가 공유할 수 있도록 `/Users/oksang/Desktop/sappeun/sappeun-api/scripts/mission-artwork-template-utils.mjs`로 분리한다.
- `upload:mission-expansion-artwork`는 real upload 전에 template validation을 필수로 실행한다.

## DB / API Contract

`remoteImage` 예시:

```json
{
  "schemaVersion": 1,
  "type": "remoteImage",
  "assetId": "mission_n09_v14",
  "url": "https://assets.sappeun.app/mission-artwork/mission_n09_v14.<hash>.png",
  "contentHash": "sha256:<hash>",
  "mimeType": "image/png",
  "width": 144,
  "height": 144,
  "paletteMode": "mono",
  "fit": "contain",
  "fallback": {
    "schemaVersion": 1,
    "type": "lucide",
    "key": "tree-pine",
    "paletteMode": "mono",
    "alt": "소나무"
  }
}
```

정책:

- `paletteMode = "mono"`면 프론트엔드는 image RGB를 의미 있게 사용하지 않는다.
- `remoteImage.url`은 immutable content-addressed key를 사용한다. template 변환 후 hash가 바뀌면 새 object key와 새 DB URL을 만든다.
- 이미 R2에 올라간 컬러/미검증 object는 최종 DB 적용 대상이 아니다.
- `0014_bingo_mission_expansion.sql`은 template PNG 재생성 및 public URL 검증 이후 적용한다.

권장 schema 확장 후보:

```json
{
  "paletteMode": "mono",
  "templateMode": "alphaMatte",
  "matteColor": "#FFFFFF"
}
```

v1 API schema에 즉시 추가하지 않아도 된다. 다만 프론트/백엔드 문서에는 `paletteMode = "mono"`가 `templateMode = "alphaMatte"`를 의미한다고 명시한다.

## Frontend Rendering Contract

프론트엔드 렌더링 원칙:

- `paletteMode = "mono"` remote image는 alpha mask로 처리한다.
- 일반 미션은 category tone 또는 cell state color를 mask 내부에 입힌다.
- selected/completed/disabled 상태 색상도 동일한 mask에 적용한다.
- rainbow 미션은 mask 내부에 gradient를 입히고 sparkle layer를 같은 mask로 clip한다.
- image fetch 실패 시 `fallback` ArtworkSpec을 렌더링한다.
- 원본 image RGB를 직접 보여주는 raw `<img>`/`Image` path는 fallback debug view에만 허용한다.

Flutter 구현 후보:

- 일반 tint: `ColorFiltered` 또는 `ShaderMask` + `BlendMode.srcIn`.
- rainbow: `ShaderMask` gradient + 동일 mask bounds 안에서 sparkle overlay.
- cached image bytes는 원본 RGB가 아니라 alpha mask로 취급한다.
- golden/screenshot QA는 일반 tint, disabled tint, completed tint, rainbow gradient 4가지를 같은 remote image로 확인한다.

Web 구현 후보:

- CSS `mask-image` / `-webkit-mask-image`.
- `mask-mode: alpha`를 명시한다. white matte이므로 luminance fallback에서도 shape가 유지된다.
- rainbow는 masked gradient background + sparkle pseudo-layer.

## R2 Upload Policy

- bucket: `sappeun-public-assets-prod`
- public base URL: `https://assets.sappeun.app`
- object prefix: `mission-artwork/`
- cache: `public, max-age=31536000, immutable`
- content type: `image/png`

업로드 순서:

1. raw export를 template PNG로 normalize.
2. generator로 manifest와 migration 재생성.
3. dry-run으로 PNG count/size/hash 검증.
4. R2에 새 hash object key로 업로드. 기존 provisional hash object를 덮어쓰지 않는다.
5. `assets.sappeun.app` custom domain이 200 OK, `image/png`, long-cache를 반환하는지 샘플 확인.
6. 그 뒤에만 `0014_bingo_mission_expansion.sql`을 Supabase에 적용한다.

Provisional object 처리:

- 이미 `sappeun-public-assets-prod`에 올라간 미검증 102개 object는 DB에 연결하지 않는다.
- template 변환 후 hash가 바뀌면 새 object key만 manifest에 남는다.
- 최종 DB 적용 후 manifest에 없는 provisional object는 삭제 후보 목록으로 출력한다.
- 삭제는 R2 custom domain과 DB 적용 검증이 끝난 뒤 별도 cleanup으로 수행한다.

## Release Gate

`0014_bingo_mission_expansion.sql` 운영 적용 전 조건:

- `assets.sappeun.app` custom domain이 R2 bucket에 연결되어 있다.
- manifest의 first/middle/last sample URL이 `200 OK`, `image/png`, long-cache를 반환한다.
- R2에서 샘플 object를 다운로드해 `contentHash`와 일치한다.
- `pnpm verify:mission-expansion-artwork`, `pnpm test`, `pnpm build`가 통과한다.
- frontend에서 `runtime-artwork-v1` 클라이언트가 template tint path를 사용한다.
- legacy capability 없는 API 요청에는 102개 신규 row가 내려가지 않는다.
- capability 있는 API 요청에는 신규 row가 내려가고, image fetch 실패 시 fallback이 렌더링된다.
- API `MISSION_CONTENT_VERSION`은 0014 적용 전에는 운영 catalog인 `1.3.0`을 유지한다. 0014 적용 및 public URL 검증이 끝난 배포에서 `1.4.0`으로 올린다.

## Execution Notes

2026-06-08 API repo implementation:

- `pnpm normalize:mission-artwork`: 102개 template PNG 생성 완료, total 159,635 bytes, warnings 없음.
- `pnpm gen:mission-expansion-seed`: `manifest.json`과 `0014_bingo_mission_expansion.sql`을 template image hash 기준으로 재생성 완료.
- `pnpm upload:mission-expansion-artwork -- --dry-run`: 102개 object key 검증 완료.
- Wrangler OAuth upload: `sappeun-public-assets-prod`에 102개 새 content-hash object 업로드 완료.
- R2 sample download verification: first/middle/last sample object를 remote R2에서 내려받아 manifest SHA-256 및 template PNG contract 일치 확인.
- `assets.sappeun.app` DNS/custom domain은 아직 미연결 상태다. `curl -I https://assets.sappeun.app/...`는 host resolve 실패한다.
- 따라서 `0014_bingo_mission_expansion.sql` Supabase 운영 적용은 아직 수행하지 않았다.
- API `MISSION_CONTENT_VERSION`도 운영 DB 적용 전까지 `1.3.0`으로 유지한다.

## Acceptance Criteria

- 모든 v1.4 mission artwork PNG는 transparent alpha template이다.
- `paletteMode = "mono"` asset의 visible RGB는 전부 `#FFFFFF`이고, shape는 alpha channel만으로 표현된다.
- 프론트엔드가 같은 R2 image로 category tint, selected tint, completed tint, rainbow gradient, sparkle effect를 적용할 수 있다.
- R2에는 content-addressed final template object만 public delivery 대상으로 남긴다.
- DB `remoteImage.contentHash`와 실제 R2 object hash가 일치한다.
- `assets.sappeun.app` custom domain이 연결되기 전에는 `0014` seed를 운영 DB에 적용하지 않는다.

## Open Questions

- Pencil에서 raw export를 항상 투명 배경으로 보장할 수 있는가?
- 기존 102개 PNG가 이미 template-safe라면 normalize script로 hash만 재생성할지, Pencil source에서 다시 export할지 결정해야 한다.
- frontend가 `paletteMode = "mono"`를 이미 tint 가능한 image로 처리하는지, 아니면 별도 렌더링 path가 필요한지 확인해야 한다.

## Implementation Checklist

- [ ] `pngjs` dev dependency 추가.
- [ ] `scripts/mission-artwork-template-utils.mjs` 추가.
- [ ] `scripts/normalize-mission-artwork-template.mjs` 추가.
- [ ] `package.json`에 `normalize:mission-artwork` 추가.
- [ ] `mission-expansion-seed.spec.ts`에 template PNG 검증 추가.
- [ ] `upload-mission-expansion-artwork.mjs`가 upload 전에 template 검증을 실행하게 변경.
- [ ] normalize 후 `manifest.json`과 `0014_bingo_mission_expansion.sql` 재생성.
- [ ] R2에 새 hash object 업로드.
- [ ] `assets.sappeun.app` 연결 후 public URL 검증.
- [ ] 운영 DB에 `0014` 적용.
- [ ] manifest 밖 provisional R2 object cleanup 후보 출력.
