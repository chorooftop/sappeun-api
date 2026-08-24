# 계획서: API 배포 Render → Google Cloud Run 이전

## Metadata
- 작성일: 2026-08-22
- 대상: `sappeun-api` (NestJS 11 + Supabase + Cloudflare R2)
- 상태: **진행 중 — Phase 0·1 완료. Phase 2는 R2 시크릿 대기로 중단** (§10 실행 기록 참조)
- 선례: `dadeul` 저장소 `specs/release-process.md` §5 (Cloud Run `asia-northeast1`, 2026-08-22 배포 완료)
- GCP 좌표: 프로젝트 `sappeun` (번호 `640444807734`), 이미지 `asia-northeast1-docker.pkg.dev/sappeun/sappeun/api`
- 이 문서의 성격: **이전 작업 계획서**. 배포가 끝나면 확정 값으로 별도의 재현 가능한 배포 절차 문서를 만든다.

---

## 1. 왜 옮기는가 — 실측 근거

2026-08-22 측정.

| 측정 항목 | 값 | 방법 |
|---|---|---|
| Render 콜드스타트 첫 요청 TTFB | **42.6초** | `curl -w '%{time_starttransfer}'` → `https://sappeun-api.onrender.com/v1/health` |
| 워밍 상태 응답 | 0.136s / 0.380s | 위 요청 직후 연속 2회 |
| NestJS 자체 부팅 시간 | **101ms** | `node dist/main.js`의 `app_listening` 로그 `uptimeMs` |

**42.6초 중 애플리케이션 책임은 0.101초다.** 나머지 42.5초는 전부 Render Free 티어의 인스턴스
재기동(스핀업) 오버헤드다. 즉 앱을 최적화해서 줄일 수 있는 여지가 없고, 플랫폼을 바꾸는 것만이 해법이다.

현재 완화책인 `.github/workflows/keep-render-warm.yml`의 한계:

- 크론이 09:00–22:50 KST만 커버한다 → **야간·새벽 첫 사용자는 매번 42초를 맞는다**
- GitHub Actions의 스케줄 크론은 free runner에서 수십 분 지연되는 일이 흔하다 → 주간에도 15분 유휴 창이 뚫린다
- 워밍 자체가 목적인 트래픽을 하루 84회 발생시킨다

---

## 2. 기대할 수 있는 것과 없는 것

**교정이 필요한 전제: Cloud Run으로 옮겨도 콜드스타트는 0이 아니다.**

- `--min-instances 0`이면 유휴 15분 후 인스턴스가 내려간다. 다음 요청은 컨테이너 시작 + Node 런타임
  초기화 + 앱 부팅 101ms를 치른다. `--cpu-boost` 기준 **1초 안팎**으로 예상하나 **실측이 필요하다**(Phase 2).
- `--min-instances 1`이면 콜드스타트가 사라지지만 유휴 과금이 붙는다(dadeul 문서 기준 월 $10 안팎).
  **"콜드스타트 0"과 "무료"는 동시에 성립하지 않는다.**

이 계획의 선택은 **`min-instances 0` + 1초 콜드스타트를 수용**하는 쪽이다. 42초 → 1초면 사용자 체감상
문제가 해소되고, 무료 조건도 지켜진다. Phase 2 실측치가 3초를 넘으면 `min-instances 1` 전환 또는
플랫폼 재검토를 판단한다 — **이 실측치가 유일한 판단 근거다.**

---

## 3. 확정 결정

| 항목 | 값 | 근거 |
|---|---|---|
| 플랫폼 | Google Cloud Run | 고정비 없음. dadeul로 학습비용을 이미 지불했고 두 프로젝트 운영이 한 플랫폼으로 통일된다 |
| 리전 | **`asia-northeast1` (도쿄)** | Tier 1이라 무료 티어가 적용된다. 서울(`asia-northeast3`)은 **Tier 2라 무료 티어 밖**이다 |
| `--min-instances` | `0` | 무료 유지의 핵심. §2의 트레이드오프를 수용한다 |
| `--max-instances` | `3` | 무료 티어 폭주 방지 상한. 이 API에는 인메모리 레이트리밋이 없으므로 dadeul과 달리 정확도 때문에 묶는 것은 아니다 |
| `--concurrency` | 기본값 `80` | 요청당 DB 커넥션을 잡지 않는다(§4) → dadeul의 `20` 같은 커넥션 상한 계산이 불필요하다 |
| `--cpu` / `--memory` | `1` / `512Mi` | 부팅 101ms·무상태 JSON API. 실측 후 조정 |
| `--cpu-boost` | 사용 | 콜드스타트 구간 CPU 부스트. 요금은 부스트 구간에만 붙는다 |
| 도메인 | **보류 — `*.run.app` 사용** | `sappeun.app`은 **미등록 도메인이다**(RDAP 404, Cloudflare zone 없음, DNS 레코드 없음). `.env.example`의 `assets.sappeun.app`은 계획값이지 실제가 아니다. §5 Phase 3 참조 |
| 시크릿 | Secret Manager | 응답·로그·문서·커밋에 노출 금지 (`AGENTS.md` Secrets 규칙) |
| 마이그레이션 | **Cloud Run Job 불필요** | `supabase/migrations`는 Supabase CLI로 별도 적용된다. dadeul의 drizzle Job 구조를 가져오지 않는다 |

---

## 4. 이 저장소가 Cloud Run에 이미 맞는 부분 (코드 확인 완료)

컨테이너 계약 쪽은 **애플리케이션 코드 수정이 필요 없다.**

| 요구사항 | 현재 상태 |
|---|---|
| `0.0.0.0` 바인딩 | ✅ `src/main.ts:49` — `app.listen(port, '0.0.0.0')` |
| `PORT` 환경변수 주입 수용 | ✅ `src/config/env.ts:21` — `z.coerce.number()`가 `PORT=8080`을 그대로 받는다 |
| SIGTERM 그레이스풀 셧다운 | ✅ `src/main.ts:27` — `enableShutdownHooks()` + 시그널 핸들러. **단 Dockerfile의 `CMD`는 exec 형식이어야 시그널이 전달된다** |
| 부팅 경로에서 DB 미접근 | ✅ 부팅 101ms가 증거. 스케일투제로에서 콜드스타트마다 반복 비용이 되지 않는다 |
| 런타임 파일시스템 접근 | ✅ 없음 — `readFileSync`/`process.cwd()` 사용처는 전부 `*.spec.ts`다. 이미지에 `supabase/`·`artifacts/`·`scripts/`를 넣을 필요가 없다 |
| `@/*` 경로 별칭 | ✅ `nest build`가 컴파일 시 상대경로로 변환한다(`dist/main.js`의 `require("./app.module")` 확인). 런타임에 `tsconfig-paths` 불필요 |

**dadeul에서 가장 까다로웠던 두 문제가 여기엔 없다:**

- **DB 커넥션 풀 문제 없음** — Supabase JS 클라이언트(HTTP REST)를 쓰고 실 Postgres 커넥션을 잡지 않는다.
  Supavisor transaction mode, 포트 6543, `DB_POOL_MAX`, prepared statement 금지 같은 제약이 전부 무관하다.
- **마이그레이션 Job 없음** — 배포 파이프라인이 이미지 빌드 + `gcloud run deploy` 2단계로 끝난다.

**egress 주의:** Cloud Run 무료 티어의 네트워크 할당량은 북미분만이라 도쿄→인터넷 아웃바운드는 과금
대상이다. 다만 이 API는 JSON만 내보내고 **미디어는 R2 프리사인 URL로 클라이언트가 직접 받으므로**
API를 경유하지 않는다. 실질 비용은 무시할 수준으로 본다.

---

## 5. 작업 단계

### Phase 0 — GCP 사전 준비 *(사용자 실행)*

1. GCP 프로젝트 생성 + 결제 계정 연결 (무료 티어에도 카드 등록이 필요하다)
2. Artifact Registry 저장소를 **`asia-northeast1`에** 생성. 저장 0.5GB까지 무료 →
   **cleanup 정책(최근 N개 유지)을 만들 때 같이 건다**
3. Secret Manager에 등록 (활성 버전 6개까지 무료 → 회전 시 구 버전 파기):
   `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ANON_KEY`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`,
   `R2_OWNER_HASH_SECRET`, `CRON_SECRET`, (`QA_AUTH_*` — §6 확인 후)
4. Cloud Run 서비스 계정에 Secret Accessor 권한 부여

산출물: GCP 프로젝트 ID, Artifact Registry 경로. **시크릿 값은 채팅·커밋·이슈에 붙여넣지 않는다.**

### Phase 1 — 컨테이너화 *(코드 작업)*

신규 파일 2개. **dadeul의 Dockerfile은 npm workspace 기준이라 그대로 쓸 수 없다** — 여긴 pnpm 10.25 단일 패키지, `engines.node: 20.x`다.

`Dockerfile` 초안:

```dockerfile
# sappeun-api 컨테이너 이미지 (Cloud Run asia-northeast1)
#
# Cloud Run 컨테이너 계약:
#   - PORT 주입 → src/config/env.ts의 z.coerce.number()가 받는다 (코드 변경 불필요)
#   - 0.0.0.0 바인딩 필수 → src/main.ts가 이미 그렇게 listen한다
#   - SIGTERM 후 유예 뒤 SIGKILL → enableShutdownHooks()가 처리한다.
#     그래서 셸을 거치지 않는 exec 형식 CMD를 쓴다 (셸이 끼면 시그널이 전달되지 않는다)

FROM node:20-alpine AS base
WORKDIR /app
# corepack이 아니라 npm으로 pnpm을 전역 설치한다 — Node 20에 동봉된 corepack이
# pnpm 10을 받을 때 서명 키 검증에 실패하는 사례가 있어 빌드 재현성을 우선했다
RUN npm install -g pnpm@10.25.0

# 의존성 레이어를 소스와 분리해 캐시가 소스 변경에 깨지지 않게 한다
FROM base AS deps
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

FROM deps AS builder
COPY tsconfig.json tsconfig.build.json nest-cli.json ./
COPY src ./src
RUN pnpm build

# 런타임 의존성만 따로 설치 (devDependencies 제외)
FROM base AS prod-deps
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod

FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY package.json ./package.json
USER node
EXPOSE 8080
CMD ["node", "dist/main.js"]
```

`.dockerignore` — **`.env` 제외가 최우선이다.** 컨텍스트가 커지면 빌드가 느려지고 시크릿이 섞여 들어간다.
**디렉토리 제외에는 반드시 루트 앵커(`/`)를 붙인다** (이유는 아래 함정 참조). `.gcloudignore`는 이 파일의 사본이다:

```
node_modules
/dist
.git
/.github
/.omc
/.gstack
/.wrangler
/.claude
/plans
/artifacts
/scripts
/supabase
/test
**/.env
**/.env.*
!.env.example
**/.DS_Store
```

> 위 두 블록은 초안이 아니라 **저장소에 실제로 존재하는 `Dockerfile`·`.dockerignore`·`.gcloudignore`의 사본**이다.
> 값이 어긋나면 저장소 파일이 진실이다.

**빌드는 Cloud Build로 한다 — 이 개발 환경에 Docker/Podman/Colima가 설치돼 있지 않다.**
dadeul도 같은 이유로 Cloud Build를 썼다. 따라서 `docker build` / `docker run` 로컬 검증은 불가능하고,
**첫 Cloud Build가 곧 Dockerfile 검증이자 첫 실행 검증은 Cloud Run 배포**가 된다.

로컬에서 미리 가능한 검증(위험 구간 선점):

```bash
# 1) prod 전용 의존성이 lockfile로 해석되는가 (Dockerfile의 prod-deps 스테이지)
mkdir -p /tmp/proddeps && cp package.json pnpm-lock.yaml /tmp/proddeps/
cd /tmp/proddeps && pnpm install --frozen-lockfile --prod

# 2) 빌드가 통과하는가 (Dockerfile의 builder 스테이지)
pnpm build && ls dist/main.js
```

> **함정 (1차 빌드 실패로 확인):** `gcloud builds submit`은 `.dockerignore`가 아니라 **`.gcloudignore`** 를
> 읽고, 이 파일은 **gitignore 문법**이라 앵커 없는 `supabase`가 모든 depth에 매칭된다. 루트 `supabase/`를
> 지우려다 **`src/supabase/`까지 제외**되어 `TS2307` 13개로 빌드가 깨졌다. 디렉토리 제외는 반드시
> `/supabase`처럼 루트 앵커를 붙이고, 다음으로 검증한다:
> ```bash
> git -c core.excludesFile=.gcloudignore check-ignore -q --no-index src/supabase && echo "제외됨(위험)" || echo "포함됨(정상)"
> git -c core.excludesFile=.gcloudignore check-ignore -q --no-index .env && echo "제외됨(정상)"
> ```

### Phase 2 — 최초 배포 + 콜드스타트 실측

```bash
REGION=asia-northeast1
PROJECT=sappeun
IMAGE="$REGION-docker.pkg.dev/$PROJECT/sappeun/api:$(git rev-parse --short HEAD)"

# 로컬 Docker가 없으므로 Cloud Build로 원격 빌드한다 (소스 tarball 업로드 → 빌드 → AR 푸시)
gcloud builds submit --tag "$IMAGE" --project "$PROJECT" .

gcloud run deploy sappeun-api \
  --image "$IMAGE" --region "$REGION" --project "$PROJECT" \
  --memory 512Mi --cpu 1 \
  --concurrency 80 --min-instances 0 --max-instances 3 \
  --cpu-boost --allow-unauthenticated \
  --set-env-vars NODE_ENV=production,API_PREFIX=v1,SUPABASE_URL=...,R2_ACCOUNT_ID=...,R2_BUCKET=...,R2_REGION=auto,CORS_ORIGINS=... \
  --set-secrets SUPABASE_SERVICE_ROLE_KEY=SUPABASE_SERVICE_ROLE_KEY:latest,SUPABASE_ANON_KEY=SUPABASE_ANON_KEY:latest,R2_ACCESS_KEY_ID=R2_ACCESS_KEY_ID:latest,R2_SECRET_ACCESS_KEY=R2_SECRET_ACCESS_KEY:latest,R2_OWNER_HASH_SECRET=R2_OWNER_HASH_SECRET:latest,CRON_SECRET=CRON_SECRET:latest
```

**자격증명이 아닌 값은 Secret Manager에 넣지 않는다.** `SUPABASE_URL`, `R2_ACCOUNT_ID`, `R2_BUCKET`,
`R2_REGION`, `CORS_ORIGINS`는 `--set-env-vars`로 간다. `AGENTS.md`가 서버 전용으로 규정한 것은
Supabase service role key와 R2 API token/secret이다.

스모크 + 실측:

```bash
URL=$(gcloud run services describe sappeun-api --region "$REGION" --format='value(status.url)')
curl -sf "$URL/v1/health"
# 주요 경로: 인증 → 보드 세션 → 미디어 프리사인까지 실제 앱 흐름으로 확인
```

- **콜드스타트 실측(필수)**: 15분 이상 방치해 인스턴스를 내린 뒤 첫 요청 TTFB를 **5회 측정해 기록한다.**
  이 수치가 `min-instances` 재조정 여부를 가르는 유일한 근거다.
- `CORS_ORIGINS` 값이 새 호스트 기준으로 맞는지 확인한다.

### Phase 3 — 커스텀 도메인 *(보류)*

> **2026-08-23 확인: `sappeun.app`은 등록조차 되지 않은 도메인이다.** RDAP 404, Cloudflare zone 목록
> 비어 있음, `sappeun.app`·`assets.sappeun.app`·`api.sappeun.app` 모두 DNS 레코드 없음.
> 따라서 이 Phase는 **도메인 구매가 선행되어야** 시작할 수 있다.
>
> dadeul도 같은 상황이며 `release-process.md`에 원칙을 세워뒀다 — *"`api.dadeul.app`은 미확보이며,
> 예약 도메인을 계약에 미리 써 두지 않는다"*. sappeun도 같은 판단을 따르는 것이 일관적이다.
>
> **이 보류가 만드는 파장 (중요):** 원래 계획은 "Phase 3(도메인)을 Phase 5(프론트 전환)보다 먼저 해서
> DNS 되돌리기만으로 전체 롤백이 되게 한다"였다. 도메인이 없으면 **그 안전장치가 사라지고**,
> `*.run.app`이 앱 바이너리에 구워진다 → 나중에 도메인을 사면 앱을 또 재빌드해야 한다.
> 판단 기준은 §6-1(배포된 앱 빌드 존재 여부)이다:
> - 배포된 빌드가 **없다** → `*.run.app`으로 가고 도메인은 런칭 전에 도입한다 (재빌드 비용이 0)
> - 배포된 빌드가 **있다** → 도메인을 먼저 사는 편이 낫다. 앱 재빌드를 두 번 하게 된다

도메인을 확보한 뒤의 옵션 비교:

| 방식 | 비용 | 비고 |
|---|---|---|
| **Cloud Run 도메인 매핑** | 무료 | `asia-northeast1` **지원 확인됨**. 단 Preview 상태("not production-ready"), 인증서 발급 15분~24시간, 루트 경로만 매핑, 와일드카드 미지원. Cloudflare DNS는 **프록시 끈 상태(회색 구름)** 로 A/AAAA 등록 |
| Global External ALB | 유료(월 $18 안팎) | 무료 전제가 깨진다 |
| Firebase Hosting rewrite | 저비용 | 전역 CDN, Google Cloud ToS가 아닌 Firebase 약관 적용 |

**1안: Cloud Run 도메인 매핑.** Preview 제약이 실제로 문제가 되면 Firebase Hosting으로 폴백한다.
도메인은 이미 Cloudflare를 R2로 쓰고 있으므로 거기서 DNS를 관리한다.

### Phase 4 — 스케줄 작업 이관

- `.github/workflows/keep-render-warm.yml` **삭제** (Cloud Run에서는 목적 자체가 사라진다)
- **Cloud Scheduler**(무료 job 3개)로 교체. 워밍용이 아니라 실수요가 있다:
  1. **Supabase 무활동 방지** — Supabase Free는 7일 무활동 시 프로젝트를 일시정지한다.
     Cloud Run이 스케일투제로라 "서비스가 떠 있음 ≠ DB가 깨어 있음"이다. 하루 1회 `GET /v1/health`.
  2. **`src/jobs/jobs.controller.ts`의 정리 작업 3종** — `cleanup-temp-photos`, `cleanup-temp-clips`,
     `cleanup-stale-user-media`. **현재 이 저장소 어디에도 이걸 호출하는 스케줄러가 없다.**
     `CRON_SECRET`을 `Authorization: Bearer`로 실어 호출한다(쿼리스트링 방식은 URL 로그에 남으므로 쓰지 않는다).

> Cloud Scheduler job이 3개를 넘으면 무료 한도를 벗어난다. 위 4개 중 health 핑을 정리 작업 중 하나와
> 합치거나, 정리 작업 3종을 묶는 단일 엔드포인트를 두는 방안을 Phase 4에서 결정한다.

### Phase 5 — 프론트 전환

- `sappeun-frontend`의 `API_BASE_URL`을 커스텀 도메인으로 교체
  (`sappeun-frontend/docs/ENV.md:28`, `docs/ENV.md:40`, `docs/ENV.md:58`, `README.md:42`)
- **`API_BASE_URL`은 빌드타임 값이라 앱 바이너리에 구워진다** → §6의 "배포된 빌드 존재 여부" 확인 결과에 따라 전환 순서가 갈린다

### Phase 6 — Render 종료 + 문서화

- 신구 병행 기간(최소 1주) 동안 Render 서비스를 살려둔다 → 구 클라이언트 유입이 0인지 로그로 확인 후 종료
- `README.md`, `AGENTS.md`의 배포 관련 서술 갱신
- **재현 가능한 배포 절차 문서 작성** — dadeul `specs/release-process.md` §5 형식. "이 문서만 보고
  다음 배포를 재현할 수 있어야 한다"가 기준. 확정된 리전·플래그·롤백 절차·실측 콜드스타트를 담는다

---

## 6. 미확정 — 착수 전 확인이 필요한 항목

1. **배포된 앱 빌드가 이미 존재하는가** (TestFlight/스토어). 존재하면 Render를 즉시 끌 수 없고
   Phase 5→6 사이 병행 기간이 필수다. → **Phase 5 순서를 가르는 항목**
2. **커스텀 도메인 보유 여부** — 쓸 도메인이 정해져 있는지, Cloudflare에 있는지
3. **Supabase 프로젝트 리전** — 도쿄(`ap-northeast-1`)면 Cloud Run과 같은 리전이라 왕복 지연이 최소다.
   다른 리전이면 요청당 Supabase 왕복 횟수만큼 지연이 얹힌다. 이전 자체를 막지는 않지만 기록해 둔다
4. **무료 티어 수치 재확인** — 이 문서의 "월 200만 요청 / 180,000 vCPU-초 / 360,000 GiB-초"는
   dadeul 문서 기준이다. GCP 공식 pricing 페이지에서 배포 직전에 재확인한다
   (리전 Tier 분류도 함께 — `asia-northeast1`=Tier 1, `asia-northeast3`=Tier 2)
5. **`QA_AUTH_*` 프로덕션 취급** — `QA_AUTH_ENABLED` 기본값이 `false`다.
   프로덕션 Cloud Run 서비스에 QA 시크릿을 올릴지 결정한다. `rule-qa-auth-gating` 규칙을 건드리지 않는다
6. **`CORS_ORIGINS`** — 현재 값과 새 도메인의 정합성

---

## 7. 롤백

- **Cloud Run 내부**: `gcloud run services update-traffic sappeun-api --region asia-northeast1 --to-revisions=<이전_리비전>=100`
  — 리비전이 남으므로 재빌드 없이 즉시 되돌린다
- **플랫폼 단위**: Phase 6 전까지 Render 서비스를 살려둔다. 커스텀 도메인을 쓰면 DNS를 Render로
  되돌리는 것만으로 전체 롤백이 된다 — **Phase 3(커스텀 도메인)을 Phase 5(프론트 전환)보다 먼저 하는 이유다**
- Supabase 스키마는 이 이전 작업의 범위 밖이므로 롤백 대상이 아니다

---

## 8. 리스크

| 리스크 | 영향 | 완화 |
|---|---|---|
| 콜드스타트가 기대(1초)보다 크다 | 이전의 명분이 약해진다 | Phase 2에서 5회 실측. 3초 초과 시 `min-instances 1`(유료) 또는 Render Starter($7/월) 재검토 |
| 구 앱 빌드가 `onrender.com`을 물고 있다 | 전환 즉시 구 클라이언트 사망 | Phase 6 병행 기간 + 커스텀 도메인 도입 |
| Cloud Run 도메인 매핑이 Preview | 인증서 발급 지연·기능 제약 | 발급 대기(최대 24h)를 일정에 반영. 폴백은 Firebase Hosting |
| 무료 티어 초과 | 예상치 못한 과금 | `--max-instances 3` 상한 + GCP 예산 알림 설정 |
| Secret Manager 무료 활성 버전 6개 한도 | 회전 시 한도 초과 | 회전할 때마다 구 버전을 파기한다 |
| 시크릿이 이미지/로그에 유출 | 심각 | `.dockerignore`에 `.env` 명시, 값은 Secret Manager 경유로만 주입 |

---

## 9. 명세 저장소 처리

`sappeun-specs`는 TOM 4타입(`term`/`entity`/`rule`/`action`) + spec만 담는 **제품 명세** 저장소다.
배포 플랫폼·인프라 절차는 제품 정책이 아니므로 atom으로 만들지 않는다.

다만 **API 호스트가 바뀌는 것은 계약 변경**이다. Phase 5 시점에 다음을 점검한다:

- 호스트/베이스 URL을 언급하는 atom이 있는지 (`tom walk` 로 확인)
- 있으면 코드 변경과 **같은 작업 단위로** 갱신하고, `refs`만 편집한 뒤 `tom validate --fix`로 `used_by`를 동기화한다

---

## 10. 실행 기록 (2026-08-23)

### 완료

| 항목 | 결과 |
|---|---|
| GCP 프로젝트 | `sappeun` 생성 (번호 `640444807734`). 기존 `mythic-mission-496505-n4`(이름만 sappeun)는 쓰지 않는다 — 프로젝트 ID는 변경 불가라 이미지 경로에 영구히 남는다 |
| 결제 계정 | `011E4A-5D5D0E-C17A8C` 연결 (dadeul과 동일) |
| API 활성화 | `run` / `artifactregistry` / `secretmanager` / `cloudbuild` / `cloudscheduler` |
| Artifact Registry | `sappeun` @ `asia-northeast1`, cleanup 정책 = 최근 5개 유지 + 30일 초과 삭제 |
| 신규 파일 | `Dockerfile`, `.dockerignore`, `.gcloudignore` |
| 로컬 사전 검증 | prod 의존성 설치 성공(60MB), `nest build` 성공(dist 1.6MB) |
| 이미지 빌드 | Cloud Build 성공 (1분 29초) → `api:bootstrap`, digest `sha256:959b9093…` |
| Secret Manager | `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ANON_KEY` 등록 + `640444807734-compute@…`에 `secretAccessor` 부여 |

Supabase 자격증명 교차 확인: `.env`의 `SUPABASE_URL`이 프론트(`sappeun-frontend/docs/ENV.md:26`)와
동일한 프로덕션 프로젝트를 가리키고, service role 키로 `/rest/v1/` 호출 시 200을 확인했다.

### 중단 사유 — R2 시크릿 부재

로컬 `.env`의 다음 값이 **전부 0자**다. `src/config/env.ts`가 `min(1)`로 요구하므로 이 상태로
배포하면 컨테이너가 `ZodError`로 부팅에 실패한다(로컬에서 재현 확인).

`R2_ACCOUNT_ID` · `R2_ACCESS_KEY_ID` · `R2_SECRET_ACCESS_KEY` · `R2_BUCKET` ·
`R2_OWNER_HASH_SECRET`(min 16자) · `CRON_SECRET`

프로덕션 값의 소재는 Render 대시보드(`sappeun-api` → Environment)다. 값은 채팅·커밋에 남기지 않고
`.env`를 채운 뒤 stdin으로 Secret Manager에 주입한다:

```bash
printf '%s' "$val" | gcloud secrets create "$name" \
  --project sappeun --replication-policy=automatic --data-file=-
```

### 미해결

- **예산 알림 미설정** — `gcloud billing budgets create`가 최소 인자로도 `INVALID_ARGUMENT`를 반환한다
  (`list`는 정상이므로 API·권한이 아니라 결제 계정 측 제약으로 보인다). **콘솔에서 수동 설정이 필요하다.**
  `--max-instances 3` 상한이 유일한 과금 방어선인 상태다

### 다음 작업 순서

1. R2·CRON 시크릿 6종 등록 + `secretAccessor` 부여
2. `gcloud run deploy` (§5 Phase 2 명령) → 스모크 + **콜드스타트 5회 실측**
3. 예산 알림 수동 설정
4. Phase 3(커스텀 도메인) → Phase 4(Cloud Scheduler) → Phase 5(프론트) → Phase 6(Render 종료)

### 추가 실행 기록 (2026-08-23~24) — 시크릿 확보 경로

Cloudflare MCP(OAuth)로 확보한 값:

| 값 | 결과 | 근거 |
|---|---|---|
| `R2_ACCOUNT_ID` | `8da2a9fb…` | MCP 세션의 account id |
| `R2_BUCKET` | `sappeun-photos` | 계정 내 버킷 2개뿐이고, 서버 런타임 미디어 경로가 `R2_BUCKET`을 쓴다 |
| `R2_PUBLIC_ASSET_BUCKET` | `sappeun-public-assets-prod` | `scripts/upload-mission-expansion-artwork.mjs:118`이 이 변수를 쓴다. `.env`에는 항목 자체가 없다(optional) |
| `CRON_SECRET` | 신규 생성 후 등록 | 현재 이 값을 호출하는 스케줄러가 없어 새 값이어도 안전하다 |

**막힌 경로 2개 (기록해 둘 가치가 있다):**

1. **R2 자격증명 자동 발급 불가.** Cloudflare 문서상 `POST /accounts/{id}/tokens`로 토큰을 만들고
   *Access Key ID = 토큰 `id`, Secret Access Key = 토큰 `value`의 SHA-256* 으로 도출할 수 있다.
   그러나 MCP OAuth 토큰에는 API 토큰 관리 권한이 없어 `9109 Unauthorized`다
   (`/accounts/{id}/tokens/permission_groups`·`/user/tokens/permission_groups` 양쪽 모두).
   → 대시보드 발급 또는 기존 값 복사만 가능하다.
2. **Render 환경변수 자동 조회 불가.** `~/.claude.json`에 Render MCP가 등록돼 있지 않다
   (등록된 것은 cloudflare/supabase/pencil/figma). 등록된 supabase MCP의 `project_ref`도
   `dzwedxxqzijkpvumnmis`로 **이 저장소의 Supabase(`wtpt…`)가 아니다** — 다른 프로젝트를 가리킨다.

**대체 불가 값:** `R2_OWNER_HASH_SECRET`은 `src/storage/r2.service.ts:103-109`에서 R2 **객체 키 경로**를
만든다(`users/${ownerHash}/`, `temp/${ownerHash}/`). 값이 바뀌면 기존 업로드 미디어의 경로를 계산할 수
없어 사실상 데이터 유실이다. **반드시 Render의 기존 값을 그대로 옮긴다.**

---

## 11. 배포 실행 기록 (2026-08-23)

### 배포 완료

```
서비스 URL   https://sappeun-api-640444807734.asia-northeast1.run.app
리비전       sappeun-api-00001-kpk
이미지       asia-northeast1-docker.pkg.dev/sappeun/sappeun/api:bootstrap
플래그       --min-instances 0 --max-instances 3 --concurrency 80
             --cpu 1 --memory 512Mi --cpu-boost --allow-unauthenticated
```

**`CORS_ORIGINS` 값에 쉼표가 있어 `--set-env-vars`를 쓸 수 없었다.** 쉼표가 구분자라 값이 쪼개진다.
`--env-vars-file`(YAML)로 넣었다. 같은 이유로 앞으로도 이 방식을 유지한다.

### 스모크 결과

| 검사 | 결과 |
|---|---|
| `/v1/health` | 200, `nodeEnv=production` |
| 워밍 응답 TTFB | 0.10~0.11초 (Render 워밍 0.13~0.38초보다 빠름 — 도쿄 리전 근접) |
| `/v1/missions/content` | 200 + 실제 미션 데이터(48셀) → Supabase 연결 정상 |
| `/health` (프리픽스 없음) | 404 → `setGlobalPrefix` 정상 |
| `/v1/jobs/*` 무인증 POST | 401 → `CRON_SECRET` 주입·게이트 정상 |
| R2 자격증명 | `sappeun-photos` 버킷 직접 조회 성공 |

> `/v1/missions`가 404인 것은 정상이다 — 실제 라우트는 `@Get('content')`뿐이다.

### 시크릿 확보 결과 (로컬 `.env` ↔ Render 프로덕션 대조)

- **`R2_ACCOUNT_ID`·`R2_BUCKET`이 Cloudflare에서 추론한 값과 정확히 일치**했다 → 추론 검증됨
- `SUPABASE_*` 3개는 로컬=프로덕션 동일
- `NODE_ENV`·`CORS_ORIGINS`만 다름 → `.env`는 로컬 개발값을 유지하고, 프로덕션 값은 Cloud Run env var로 분리
- `CRON_SECRET`은 내가 생성했던 값을 파기하고 **Render 기존 값을 채택**했다.
  외부에서 이 시크릿으로 jobs를 호출 중일 가능성을 보존하기 위함이다

### Phase 4 — Cloud Scheduler (완료)

무료 한도가 job 3개인데 필요 작업이 4개로 보였으나, **cleanup 3종이 각각 DB를 치므로
Supabase 무활동 방지를 겸한다** → 별도 health 핑 job이 불필요하고 3개 안에 들어간다.

| Job | 스케줄 (KST) |
|---|---|
| `sappeun-cleanup-temp-photos` | 매일 03:10 |
| `sappeun-cleanup-temp-clips` | 매일 03:20 |
| `sappeun-cleanup-stale-user-media` | 매일 03:30 |

**인증 실동작을 검증했다** — `jobs run`으로 강제 실행 후 Cloud Run 로그에서
`Google-Cloud-Scheduler` UA 요청이 **201**임을 확인했다. 이 검증을 생략하면 헤더가 틀려도
매일 401만 조용히 쌓인다.

cleanup 안전성은 코드로 확인했다: 만료된 게스트 임시 업로드(`expires_at <= now`)와
업로드 미완료 고아 레코드(`uploaded_at is null`)만 대상이고 `limit=100` 배치 제한이 있다.
정상 사용자 미디어는 건드리지 않는다.

> `keep-render-warm.yml`은 **아직 삭제하지 않았다.** 프론트가 여전히 `onrender.com`을 가리키므로
> Render가 현재 프로덕션이다. Phase 6(Render 종료) 시점에 삭제한다.

### 예산 알림 (완료)

`gcloud billing budgets create`와 REST 양쪽 모두 `INVALID_ARGUMENT`였던 원인은
**결제 계정 통화가 KRW인데 요청을 USD로 보낸 것**이었다. KRW로 바꾸니 즉시 생성됐다.

```
sappeun 무료티어 감시 | 10,000 KRW | 임계 50% / 90% / 100% | 대상 projects/640444807734
```

### 남은 것

1. **콜드스타트 실측** — 16분 방치 후 첫 요청 TTFB 측정 진행 중. 이 수치가 `min-instances` 재조정의 근거다
2. **이미지 태그** — 현재 `bootstrap`이다. 커밋 sha 태그로 재빌드·재배포해야 리비전 추적이 맞는다.
   단 **재배포는 콜드스타트 측정이 끝난 뒤에** 한다 (재배포하면 인스턴스가 새로 떠 측정이 무효가 된다)
3. Phase 5(프론트 `API_BASE_URL` 교체) · Phase 6(Render 종료·문서화)
4. Phase 3(커스텀 도메인)은 `sappeun.app` 미등록이라 도메인 구매가 선행되어야 한다

---

## 12. 콜드스타트 실측 결과와 판단 (2026-08-24)

### 측정값 — 2회 재현

| 회차 | 방치 시간 | 콜드스타트 TTFB | 워밍 |
|---|---|---|---|
| 1회 | 2시간 2분 | **4.38초** | 0.10~0.11초 |
| 2회 | 18시간 10분 | **4.14초** | 0.11초 |

> 첫 시도(0.19초)는 **폐기했다.** 측정 대기 중 Scheduler를 강제 실행해 인스턴스를 깨웠고,
> 측정 시점에 마지막 활동으로부터 9분밖에 지나지 않아 워밍을 잰 값이었다.
> 방치 시간은 매번 Cloud Run 요청 로그의 마지막 타임스탬프로 입증한 뒤 측정했다.

### 구간 분해 — 병목은 앱이 아니다

| 구간 | 시간 | 근거 |
|---|---|---|
| 컨테이너 시작 (이미지 pull + 시크릿 마운트 + 샌드박스) | **3,543ms** | Cloud Monitoring `run.googleapis.com/container/startup_latencies` |
| 앱 부팅 (`app_bootstrap_started` → `app_listening`) | 676~680ms | 구조화 로그 `uptimeMs` |
| 합계 | 약 4.2초 | 실측 TTFB와 일치 |

**앱을 최적화해도 줄지 않는다.** 3.5초는 Cloud Run 플랫폼 구간이다.
`--cpu-boost`는 이미 켜져 있고, 남은 무료 수단은 이미지 경량화뿐인데
prod 의존성 60MB의 대부분이 실제로 필요한 `@aws-sdk`라 여지가 크지 않다.

### 판단 — `min-instances 0` 유지

계획서 §2는 "3초 초과 시 `min-instances 1` 전환 또는 플랫폼 재검토"를 기준으로 뒀고
4.2초는 이를 넘는다. 그럼에도 **현 설정을 유지한다.** 근거는 실사용 데이터다:

| 지표 | 값 |
|---|---|
| `profiles` | 8명 |
| `photos` | 16장 |
| `user_badges` | 31개 |
| 최근 30일(2026-07-25~) 사진 업로드 | **0건** (마지막 2026-05-16) |

**실서비스 트래픽이 없는 개발 단계다.** 활성 사용자가 없는 상태에서 콜드스타트를 없애려고
월 $10 안팎의 유휴 과금을 지불하는 것은 과잉이다. 42.6초 → 4.2초로 **10배 개선**됐고,
런칭이 가까워져 실사용자가 붙는 시점에 `--min-instances 1`을 재검토하면 된다.

**이 수치는 예상(1초 안팎)이 낙관적이었음을 보여준다.** §2의 예상치는 이 실측으로 교정한다.

### Phase 5 — 프론트 전환 (문서 반영 완료, 커밋 보류)

`API_BASE_URL`은 `String.fromEnvironment('API_BASE_URL')`로 읽고 **defaultValue가 없다**
(`apps/mobile/lib/app/env.dart:44`). 즉 URL이 소스에 하드코딩돼 있지 않고 빌드 시
`--dart-define`으로만 주입되므로, 문서·예시 파일 갱신이 곧 실질적 전환 조치다.

교체한 5곳: `README.md:42`, `docs/ENV.md:28,40,58`, `apps/mobile/.env.example:3`

> **커밋하지 않았다.** 프론트 저장소가 `develop` 브랜치에서 origin보다 2 커밋 앞서 있고
> `main.dart`·`pubspec.yaml` 등이 수정 중이다. 진행 중 작업에 커밋을 얹지 않는다.

### 남은 것

- **Phase 6 — Render 종료**: 되돌리기 어려우므로 사용자 확인 후 진행한다.
  종료 시 `.github/workflows/keep-render-warm.yml`도 함께 삭제한다
- **Phase 3 — 커스텀 도메인**: `sappeun.app` 미등록. 실사용자가 없어 재빌드 비용이 사실상 0이므로
  런칭 전에 도입하면 된다

---

## 13. 마무리 작업 (2026-08-24)

### 명세 저장소 점검 — 변경 없음

§9에서 "API 호스트 변경은 계약 변경이므로 호스트를 언급하는 atom을 점검한다"고 남겼다.
확인 결과 **sappeun-specs에 호스트·베이스 URL을 언급하는 atom이 없다.** 제품 정책과 도메인
어휘만 담고 배포 호스트를 계약에 넣지 않은 구조라 갱신 대상이 없다. specs 저장소는 clean 유지.

dadeul이 세운 원칙(*"예약 도메인을 계약에 미리 써 두지 않는다"*)과도 일관된다.

### 배포 스크립트 — `scripts/deploy-cloud-run.sh`

Metadata에서 약속한 "재현 가능한 배포 절차"를 문서 대신 스크립트로 만들었다.

```bash
./scripts/deploy-cloud-run.sh              # 빌드 + 배포 + 스모크
./scripts/deploy-cloud-run.sh --no-build   # 이미 빌드된 sha 재배포
```

설계 판단:

- **이미지만 교체한다.** `--image`만 바꾸면 env/secret이 직전 리비전에서 상속된다(리비전 00002에서
  확인). 덕분에 시크릿 값이 스크립트에도 저장소에도 남지 않는다.
  env/secret 자체를 바꿀 때만 §5 Phase 2의 전체 명령을 쓴다
- **빌드 입력이 dirty면 중단한다.** 커밋 sha를 이미지 태그로 쓰는데 워킹트리가 더러우면
  태그가 실제 이미지 내용과 어긋나 리비전 추적이 무너진다
- **스모크 실패 시 롤백 명령을 출력한다** — health / DB 연결 / prefix 격리 / cron 게이트 4종

두 경로 모두 실제 실행으로 검증했다 (리비전 `00003-db4`, `00004-728`, 스모크 전부 통과).

### Cloud Run URL이 두 개인 점 (주의)

같은 서비스에 두 형식의 URL이 있고 **둘 다 200으로 동작한다**:

| 형식 | 값 | 비고 |
|---|---|---|
| 프로젝트 번호형 | `https://sappeun-api-640444807734.asia-northeast1.run.app` | **프론트가 쓰는 정본** |
| 레거시 해시형 | `https://sappeun-api-rqnj4zt5cq-an.a.run.app` | `gcloud ... --format='value(status.url)'`가 돌려주는 값 |

`status.url`을 그대로 쓰면 **프론트가 실제로 쓰는 경로와 다른 URL을 스모크하게 된다.**
그래서 스크립트는 프로젝트 번호를 조회해 정본 URL을 구성해 때리고, 레거시 URL은 참고로만 출력한다.
