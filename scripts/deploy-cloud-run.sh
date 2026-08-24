#!/usr/bin/env bash
#
# sappeun-api 배포 (Google Cloud Run, asia-northeast1)
#
#   ./scripts/deploy-cloud-run.sh            # 빌드 + 배포 + 스모크
#   ./scripts/deploy-cloud-run.sh --no-build # 이미 있는 sha 이미지로 재배포만
#
# 이 스크립트는 이미지만 교체한다. 환경변수·시크릿은 직전 리비전에서 상속되므로
# 값이 스크립트나 저장소에 남지 않는다.
#
# env/secret 자체를 바꿔야 할 때는 이 스크립트가 아니라 --env-vars-file 과
# --set-secrets 를 갖춘 전체 배포 명령을 쓴다 → plans/cloud-run-migration.md §5 Phase 2.
# (CORS_ORIGINS 에 쉼표가 있어 --set-env-vars 대신 --env-vars-file 이 필요하다.)

set -Eeuo pipefail

PROJECT=sappeun
REGION=asia-northeast1
SERVICE=sappeun-api
REPO=sappeun

BUILD=1
[[ "${1:-}" == "--no-build" ]] && BUILD=0

command -v gcloud >/dev/null || { echo "gcloud 를 찾을 수 없다"; exit 1; }
gcloud auth print-access-token >/dev/null 2>&1 || { echo "gcloud 인증이 필요하다: gcloud auth login"; exit 1; }

SHA="$(git rev-parse --short HEAD)"
IMAGE="$REGION-docker.pkg.dev/$PROJECT/$REPO/api:$SHA"

# 워킹트리가 더러우면 이미지 내용과 커밋이 어긋난다. 태그가 거짓말을 하게 두지 않는다.
if ! git diff --quiet HEAD -- src package.json pnpm-lock.yaml tsconfig.json tsconfig.build.json nest-cli.json Dockerfile; then
  echo "빌드에 들어가는 파일에 커밋되지 않은 변경이 있다. 커밋 후 다시 실행한다."
  git status --short -- src package.json pnpm-lock.yaml tsconfig*.json nest-cli.json Dockerfile
  exit 1
fi

if [[ "$BUILD" == 1 ]]; then
  echo "▶ 빌드  $IMAGE"
  gcloud builds submit --tag "$IMAGE" --project "$PROJECT" .
fi

echo "▶ 배포  $SERVICE ← $SHA"
gcloud run deploy "$SERVICE" \
  --image "$IMAGE" --region "$REGION" --project "$PROJECT" \
  --quiet

# Cloud Run은 두 형식의 URL을 준다 — 프로젝트 번호형과 레거시 해시형이고 둘 다 유효하다.
# status.url 은 해시형을 돌려주지만, 스모크는 **프론트가 실제로 쓰는** 프로젝트 번호형을
# 때려야 의미가 있다 (sappeun-frontend/docs/ENV.md). 해시형은 참고로만 출력한다.
PROJECT_NUMBER="$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')"
URL="https://$SERVICE-$PROJECT_NUMBER.$REGION.run.app"
LEGACY_URL="$(gcloud run services describe "$SERVICE" --region "$REGION" --project "$PROJECT" --format='value(status.url)')"

echo "▶ 스모크  $URL"
echo "  (레거시 URL: $LEGACY_URL — 둘 다 같은 서비스다)"
fail=0
check() { # 이름 경로 기대코드
  code="$(curl -s -o /dev/null -m 30 -X "${4:-GET}" -w '%{http_code}' "$URL$2")"
  if [[ "$code" == "$3" ]]; then printf '  OK   %-22s %s\n' "$1" "$code"
  else printf '  FAIL %-22s %s (기대 %s)\n' "$1" "$code" "$3"; fail=1; fi
}
check "health"          /v1/health              200
check "missions(DB)"    /v1/missions/content    200
check "prefix 격리"      /health                 404
check "cron 게이트"      /v1/jobs/cleanup-temp-photos 401 POST

if [[ "$fail" != 0 ]]; then
  echo
  echo "스모크 실패. 직전 리비전으로 되돌린다:"
  echo "  gcloud run revisions list --service $SERVICE --region $REGION --project $PROJECT"
  echo "  gcloud run services update-traffic $SERVICE --region $REGION --project $PROJECT --to-revisions=<이전_리비전>=100"
  exit 1
fi

echo "완료: $URL ($SHA)"
