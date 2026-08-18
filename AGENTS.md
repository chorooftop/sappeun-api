# Sappeun API

사뿐(산책 빙고)의 NestJS API 서버. Supabase(Auth·Postgres·RLS) + Cloudflare R2(프리사인 미디어).

- Flutter app: `/Users/oksang/Desktop/sappeun/sappeun-frontend/apps/mobile`
- 모든 라우트는 `API_PREFIX`(기본 `v1`) 프리픽스를 갖는다 (`src/main.ts`, 일부 `api/*` 호환 컨트롤러 제외).

## Spec Repository (TOM)

제품 정책·API 계약·도메인 어휘의 단일 명세 소스는 `/Users/oksang/Desktop/sappeun/sappeun-specs` (github.com/chorooftop/sappeun-specs, private)다. 작성 규약은 `sappeun-specs/specs/atoms/MANIFEST.md`를 따른다.

- 정책·계약 확인: `cd /Users/oksang/Desktop/sappeun/sappeun-specs/specs && ../tools/tom/bin/tom show <id>`, 영향 범위는 `tom walk <id> --used-by`, 현황은 `npm run tom stats`.
- **spec-first change control**: 제품 정책·API 동작·에러 계약을 바꾸는 작업은 코드 변경과 같은 작업 단위로 sappeun-specs의 해당 atom/spec을 갱신한다. atom의 `refs`만 편집하고 `used_by`는 `tom validate --fix`에 맡긴다.
- 계약 관련 사고 방지 지식(DO NOT)은 rule atom이 진실이다: `rule-board-wire-version-cap`(boardSessionSchema는 v2/3/4만 — 구버전 제거 금지), `rule-exif-location-scrub`(서버는 미디어 바이트를 열지 않음 — EXIF 스크럽 미구현), `rule-qa-auth-gating`(assertEnabled 게이트 순서·404 위장은 의도된 설계), `rule-self-mission-privacy`(mission_content에 타인 등장 미션 추가 금지).
- 스키마·에러 토큰·상수를 바꿀 때는 대응 atom(`entity-*`, `term-*`)의 실측 값도 갱신한다.

## Secrets

Supabase service role key와 R2 API token/secret은 서버 전용이다. 응답·로그·문서에 노출하지 않는다.
