# Frontend Contract (schemaVersion 2)

This is the exact JSON the website reads. Animate against the mock files now, then switch the base URL to the live API.

- Mock files: `packages/contract/mock/state.json`, `rats.json`, `events.json` (250 rats, 10 stocks, COINx paused so you can see frozen rats).
- **Live mock API**: `pnpm install` once, then `pnpm mock:api` serves the same 4 endpoints on `http://localhost:8787`, starting from the mock files and changing like the real bot:
  - a new rat every 2 to 6 seconds (hire events, `/api/rats?afterId=` picks them up)
  - stock prices drift every second in trends that flip (exaggerated so ranks, tiers and sizes visibly change)
  - a claim every 35 seconds (every claimed SOL goes to hiring rats)
  - COINx pauses (its rats freeze, `freeze` event) and resumes (`unfreeze` event) every couple of minutes
  - options: `MOCK_API_PORT=9000`, `MOCK_SPEED=3` (three times as busy), `MOCK_SEED=42` (the same run every time)
  - same JSON, schemaVersion 2, CORS open. No database, no chain, nothing real.
- TypeScript types + zod schemas + display math: `packages/contract` (`@rat/contract`). Browser safe: no Node APIs, only `zod`.

## Endpoints

| Endpoint | Poll | Size | Purpose |
|---|---|---|---|
| `GET /api/state` | every 5s | small (~30-50KB) | bot status, coin, treasury (fees claimed, spent on hires, waiting), portfolio, stocks, leaderboard, last 50 events |
| `GET /api/rats` | every 30s | large (6,000 rats: about 3.3 MB, about 820 KB gzipped, measured in `SIMULATION.md`) | full roster with live PnL. `?afterId=N` returns only rats with id > N. Fetch the full list once, then add new rats from `hire` events / `afterId` |
| `GET /api/events?afterId=N&limit=100` | every 5s | small | event feed, oldest first after `afterId` (limit max 500) |
| `GET /health` | n/a | tiny | `{ ok, mode, heartbeatAgeSec }` |

All responses: `Content-Type: application/json`, gzip, CORS open, cached 3s (`Cache-Control: public, max-age=3, s-maxage=3`).

## Rules

- Every response has `schemaVersion: 2` and `generatedAt`.
- SOL and USD values are JSON **numbers** (display only). Token amounts are **strings** (decimal, UI units).
- Times are ISO 8601 UTC strings.
- `wallet` is a normal Solana address: every rat gets a fresh keypair at hire time. There is no vanity suffix; do not rely on any pattern in it.
- Rats never disappear. Frozen rats stay in the list with `status: "frozen"`, valued at the last known price.
- Dry run: `bot.mode === "dry_run"` and every event has `dryRun: true`. Show a banner.

## Display math (same code on server and site: `@rat/contract`)

| Field | Formula |
|---|---|
| `valueUsd` | `tokenAmount x stock.priceUsd` (`tokenAmount` is already scaled for stock splits) |
| `costUsd` | SOL that went into the swap x SOL/USD at hire time. New rats start slightly red from slippage (honest). |
| `pnlUsd` | `valueUsd - costUsd` |
| `pnlPct` | `pnlUsd / costUsd x 100` (0 when cost is 0) |
| `rank` | sort by `pnlPct` desc, ties: earlier `hiredAt`, then lower `id`. 1 = best |
| `tier` | by `pnlPct`: `intern` < 0 <= `analyst` < 10 <= `associate` < 25 <= `vp` < 50 <= `partner` |
| `sizeScale` | `clamp(1 + pnlPct / 100, 0.5, 3)` |
| `avatarSeed` | first 8 hex chars of sha256(wallet), computed server side. Same wallet, same avatar, forever. |
| `allocationPct` | stock `valueUsd` / portfolio `valueUsd` x 100 |
| `hireWeightPct` | chance a new hire gets this stock right now (24h return rank weighting, 5% floor, 0 when paused) |

Rounding: USD and percentages to 2 decimals, `sizeScale` to 2 decimals, prices unrounded.

## Enums

| Field | Values |
|---|---|
| `bot.mode` | `live`, `dry_run`, `paused` (kill switch on) |
| `stock.status` | `active`, `paused` |
| `rat.status` | `active`, `frozen` |
| `rat.tier` | `intern`, `analyst`, `associate`, `vp`, `partner` |
| `event.type` | `claim`, `hire`, `freeze`, `unfreeze` |
| `claim.data.source` | `bot` (our claim), `external` (someone else triggered our claim; it goes to hires the same way) |
| `freeze.data.scope` | `stock` (issuer paused the whole stock), `rat` (one rat's account frozen or mismatched) |

## `GET /api/state`

```json
{
  "schemaVersion": 2,
  "generatedAt": "2026-10-01T18:00:05Z",
  "bot": {
    "mode": "live",
    "lastClaimAt": "2026-10-01T17:59:50Z",
    "nextClaimAt": "2026-10-01T18:00:25Z"
  },
  "coin": {
    "mint": "COINMINTxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxpump",
    "symbol": "RAT",
    "priceUsd": 0.00182,
    "supply": "987654321.12",
    "marketCapUsd": 1797531
  },
  "wallets": {
    "creator": "CREATORxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
  },
  "treasury": {
    "totalClaimedSol": 91.4,
    "totalHiredSol": 89.61,
    "waitingSol": 1.79
  },
  "portfolio": {
    "ratCount": 2987,
    "activeCount": 2950,
    "frozenCount": 37,
    "positionCount": 10,
    "costUsd": 16420.5,
    "valueUsd": 17102.9,
    "pnlUsd": 682.4,
    "pnlPct": 4.16
  },
  "stocks": [
    {
      "symbol": "TSLAx",
      "name": "Tesla",
      "mint": "XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB",
      "priceUsd": 412.33,
      "change24hPct": 6.2,
      "status": "active",
      "ratCount": 512,
      "costUsd": 2811.2,
      "valueUsd": 3001.4,
      "pnlUsd": 190.2,
      "pnlPct": 6.77,
      "allocationPct": 17.55,
      "hireWeightPct": 14.1
    }
  ],
  "leaderboard": { "top": [], "bottom": [] },
  "events": []
}
```

- `coin.*` fields are `null` before launch (no `COIN_MINT` yet), except `symbol`.
- `bot.lastClaimAt` can be `null`.
- Every claimed SOL goes to hiring rats. Nothing is bought back or burned, and nothing is paid to holders.
- `treasury.stageSol` (optional, rehearsal only): sent only by a STAGING API on a staging database. It is claimed fees plus SOL seeded for the rehearsal (`rat staging-seed`), so a rehearsal can show a real stage-up. The site's stage goes by `stageSol` when present, else `totalClaimedSol`. The production API never sends it, and `totalClaimedSol` never includes seeded SOL.
- `treasury.totalClaimedSol`: creator fees claimed so far. `treasury.totalHiredSol`: SOL spent on hires (salaries plus fees, rent and tips). `treasury.waitingSol`: claimed SOL not spent yet, usually waiting under the hourly hire cap.
- `portfolio` is what all the rats hold together: `ratCount`, `positionCount` (how many different stocks they hold), `costUsd`, `valueUsd` (show it as "Portfolio value"; it is the rats' stocks, not holders' money), `pnlUsd`, `pnlPct`.
- `stock.priceUsd` and `stock.change24hPct` can be `null` if Jupiter has no fresh price.
- `leaderboard.top` = 10 best `RatView`, `leaderboard.bottom` = 10 worst (worst first).
- `events` = last 50 events, newest first.

## `RatView` (same shape in `/api/rats` and the leaderboard)

```json
{
  "id": 1042,
  "name": "Rat #1042",
  "wallet": "7xKpQm3vN8aLr2Tz9WcYh4sBd6FjE1uGkPoXqZyW5n",
  "solscanUrl": "https://solscan.io/account/7xKpQm3vN8aLr2Tz9WcYh4sBd6FjE1uGkPoXqZyW5n",
  "stock": "TSLAx",
  "stockMint": "XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB",
  "status": "active",
  "avatarSeed": "a91f3c07",
  "hiredAt": "2026-10-01T17:40:12Z",
  "hireTx": "5hTx...sig",
  "tokenAmount": "0.014139",
  "costUsd": 5.41,
  "valueUsd": 5.83,
  "pnlUsd": 0.42,
  "pnlPct": 7.76,
  "rank": 88,
  "tier": "analyst",
  "sizeScale": 1.08
}
```

`name` is `"Rat #" + id` padded to 4 digits (`Rat #0042`, `Rat #1042`, `Rat #12345`).

## `GET /api/rats`

```json
{ "schemaVersion": 2, "generatedAt": "2026-10-01T18:00:05Z", "total": 2987, "rats": [ "RatView..." ] }
```

Sorted by `id` ascending. `total` is always the full count, even with `afterId`.

## `GET /api/events`

```json
{ "schemaVersion": 2, "generatedAt": "2026-10-01T18:00:05Z", "lastId": 90213, "events": [ "Event..." ] }
```

## Event shapes

```json
[
  { "id": 90210, "type": "claim", "at": "2026-10-01T17:59:50Z", "txSig": "3cL...", "txUrl": "https://solscan.io/tx/3cL...", "dryRun": false,
    "data": { "amountSol": 1.284, "source": "bot" } },
  { "id": 90211, "type": "hire", "at": "2026-10-01T17:59:58Z", "txSig": "5hT...", "txUrl": "https://solscan.io/tx/5hT...", "dryRun": false,
    "data": { "ratId": 1042, "ratName": "Rat #1042", "wallet": "7xKp...yW5n", "stock": "TSLAx", "salarySol": 0.03, "costUsd": 5.41 } },
  { "id": 90213, "type": "freeze", "at": "2026-10-01T18:00:03Z", "txSig": null, "txUrl": null, "dryRun": false,
    "data": { "scope": "stock", "stock": "COINx", "ratId": null, "ratCount": 37, "reason": "stock_paused" } },
  { "id": 90214, "type": "unfreeze", "at": "2026-10-01T19:00:03Z", "txSig": null, "txUrl": null, "dryRun": false,
    "data": { "scope": "stock", "stock": "COINx", "ratId": null, "ratCount": 37, "reason": "stock_resumed" } }
]
```

Freeze reasons: `stock_paused`, `account_frozen`, `balance_mismatch`. Unfreeze reasons: `stock_resumed`, `account_thawed`, `balance_restored`.

## Versioning

Any breaking change bumps `schemaVersion`. New optional fields can be added without a bump, so ignore unknown fields.

- v2 (buy and burn removed): no `burn` event, claim data is `{ amountSol, source }`, no `bot.nextBurnAt`, `coin.burnedTokens` or `wallets.fund`, treasury is `{ totalClaimedSol, totalHiredSol, waitingSol }`, and `portfolio.positionCount` is new.
