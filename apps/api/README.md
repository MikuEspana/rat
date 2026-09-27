# @rat/api

Public, read-only state API. Serves exactly `CONTRACT.md`. Owned by WS10. `pnpm --filter @rat/api start`.

- `GET /api/state`, `GET /api/rats[?afterId=N]`, `GET /api/events?afterId=N&limit=100`, `GET /health`
- Built with the same display math as the site (`@rat/contract`); every response passes the strict contract schemas in tests (no extra fields leak).
- `API_CACHE_SEC` (3s) in-memory cache + `Cache-Control` for a CDN, gzip, CORS (`CORS_ORIGIN`), 240 requests/min per IP.
- Mode follows `DRY_RUN`: paper rows in DRY RUN (`bot.mode = dry_run`, events `dryRun: true`), live rows otherwise; `paused` when the kill switch is on.
- Use a read-only database user: `DATABASE_URL_READONLY`. The API never migrates or writes.
- `/health` is always 200 (the platform health check must not depend on the worker); `ok` says whether the claim loop ran recently.

Measured in tests (PGlite, in-process): 6,000 rats `/api/rats` 422 to 444ms cold, 14ms cached; payload 2.8 MB raw, 90 KB gzipped (synthetic data; real data compresses less).
