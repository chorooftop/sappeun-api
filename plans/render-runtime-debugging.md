# Render Runtime Debugging

This service writes one-line structured runtime logs to stdout/stderr so Render
Logs can be correlated with Events.

## Incident Triage

1. Open Render Events for `sappeun-api` and note the event timestamp, instance id,
   and deploy id.
2. Query Logs for the same resource and time range. Prefer Render MCP
   `list_logs` after Codex has restarted with the `render` MCP server enabled.
   If MCP is unavailable, use Render REST API `/v1/logs`.
3. Check `https://sappeun-api.onrender.com/v1/health` with a 60 second timeout.
   Free instances can cold start, but a healthy process should return JSON.
4. If Events show `server_failed` and Logs are empty, trigger a Manual Deploy or
   Restart and watch live logs immediately.
5. Search for these events first:
   - `app_bootstrap_started`
   - `app_listening`
   - `app_bootstrap_failed`
   - `uncaught_exception`
   - `unhandled_rejection`
   - `http_request_failed`
6. Use `requestId` from `Rndr-Id` or `x-request-id` to correlate request logs with
   exception logs.

## Expected Health Response

`/v1/health` is intentionally lightweight and does not check Supabase or R2. It
should include:

- `ok`
- `service`
- `timestamp`
- `uptimeSec`
- `nodeEnv`
- `commitSha` when Render exposes `RENDER_GIT_COMMIT`

## Local Verification

Run:

```bash
pnpm test
pnpm build
pnpm start
curl -i http://localhost:4000/v1/health
```

When debugging Render-only failures, validate Render environment variables
without printing secret values, then start the app locally with equivalent env.
