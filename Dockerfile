# sappeun-api 컨테이너 이미지 (Cloud Run asia-northeast1)
#
# 빌드는 로컬 Docker가 아니라 Cloud Build로 한다:
#   gcloud builds submit --tag "$IMAGE" .
#
# Cloud Run 컨테이너 계약:
#   - PORT를 주입한다 → src/config/env.ts의 z.coerce.number()가 받으므로 코드 변경이 필요 없다
#   - 0.0.0.0 바인딩 필수 → src/main.ts가 이미 그렇게 listen한다
#   - SIGTERM 후 유예 뒤 SIGKILL → src/main.ts의 enableShutdownHooks()가 처리한다.
#     그래서 셸을 거치지 않는 exec 형식 CMD로 실행한다 (셸이 끼면 시그널이 전달되지 않는다)
#
# pnpm은 corepack이 아니라 npm으로 전역 설치한다 — Node 20에 동봉된 corepack이
# pnpm 10을 받을 때 서명 키 검증에 실패하는 사례가 있어 빌드 재현성을 우선했다.

FROM node:20-alpine AS base
WORKDIR /app
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

# 실행 이미지 — 프로덕션 코드는 파일시스템을 읽지 않으므로
# supabase/·scripts/·artifacts/를 넣지 않는다 (readFileSync 사용처는 전부 *.spec.ts다)
FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY package.json ./package.json
USER node
EXPOSE 8080
CMD ["node", "dist/main.js"]
