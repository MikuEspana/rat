# @rat/jupiter

Jupiter clients. Owned by WS07. Docs checked in [jup-ag/docs](https://github.com/jup-ag/docs) (VERIFIED on 2026-09-27).

- `budget.ts`: the worker's **Jupiter budget**. We stay on the Free tier (60 requests per 60 s, per organisation). Every worker call (prices, builds, retries) takes a token; at most `JUPITER_MAX_RPM` (40, a hard maximum) in any 60 seconds, the same sliding window Jupiter counts with. Taking never waits: with no token left a hire waits for the next loop and a price round is skipped. A 429 stops every call with an exponential backoff (5 s doubling to 5 min, or Jupiter's `x-ratelimit-reset` if later) and alerts the owner. It starts spent, so a restarting worker never bursts. `BudgetedSwapBuilder` / `BudgetedPriceSource` wrap the real clients and the mocks alike.
- `rate-limiter.ts`: a waiting sliding-window limiter for the CLI and scripts (a separate process, a few calls). A 429 blocks all callers until `x-ratelimit-reset`.
- `http.ts`: `x-api-key` header, retries on 429 / 5xx / network errors, throws on other 4xx.
- `price.ts`: Price API v3, all mints in one call (split at 50 ids). Omitted or invalid prices are missing (stale), never 0.
- `swap.ts`: Swap API v2 `GET /swap/v2/build` (router path): quote + raw instructions in one call, `taker` + `payer`. Jupiter's compute budget instructions are dropped (our sender sets its own, capped). `/build` has no price impact field: the worker compares the implied price to the Price API instead.
- `mock.ts`: `MockPriceSource` (seeded random walk, can drop prices), `MockSwapBuilder` + `registerMockSwapProgram` (SimChain executes it: taker pays SOL, payer pays the token account rent, paused mints fail).
- `scripts/check-scaled-ui.ts`: owner decision #6. Read-only, needs `RPC_URL` + `JUPITER_API_KEY`. Not run by agents.
- `scripts/check-stocks.ts`: liquidity / price deviation / mint facts for every configured stock. Read-only. Not run by agents.
