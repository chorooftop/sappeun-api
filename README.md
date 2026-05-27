# sappeun-api

NestJS API for the Sappeun Flutter app.

## Local Setup

```bash
pnpm install
cp .env.example .env
pnpm dev
```

## Scripts

- `pnpm dev`: run NestJS in watch mode
- `pnpm build`: compile the API
- `pnpm start`: run the compiled API
- `pnpm test`: run unit tests

## Runtime Boundary

Flutter calls this API for privileged operations such as Cloudflare R2 presigned URLs, media confirmation, guest promotion, account deletion, and cleanup jobs. Supabase remains the Auth/Postgres provider.
