# @rat/jupiter

Jupiter clients. Owned by WS07. Docs checked in [jup-ag/docs](https://github.com/jup-ag/docs) (VERIFIED on 2026-09-27).

- `rate-limiter.ts`: one shared 60-second sliding window for every call (Jupiter's own window). Limit = `JUPITER_MAX_RPM` (default 55, free tier is 60/min). A 429 blocks all callers until `x-ratelimit-reset`.
- `http.ts`: `x-api-key` header, retries on 429 / 5xx / network errors, throws on other 4xx.
- `price.ts`: Price API v3, all mints in one call (split at 50 ids). Omitted or invalid prices are missing (stale), never 0.
- `swap.ts`: Swap API v2 `GET /swap/v2/build` (router path): quote + raw instructions in one call, `taker` + `payer`. Jupiter's compute budget instructions are dropped (our sender sets its own, capped). `/build` has no price impact field: the worker compares the implied price to the Price API instead.
- `mock.ts`: `MockPriceSource` (seeded random walk, can drop prices), `MockSwapBuilder` + `registerMockSwapProgram` (SimChain executes it: taker pays SOL, payer pays the token account rent, paused mints fail).
- `scripts/check-scaled-ui.ts`: owner decision #6. Read-only, needs `RPC_URL` + `JUPITER_API_KEY`. Not run by agents.
- `scripts/check-stocks.ts`: liquidity / price deviation / mint facts for every configured stock. Read-only. Not run by agents.
