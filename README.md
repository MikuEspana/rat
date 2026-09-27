# RAT RACE

> The rat always loses. The fund always wins.

A memecoin on pump.fun (Solana) with a live 3D website. Trading volume pays creator fees. Creator fees hire rats. Every rat is a trader with its own Solana wallet (vanity address ending in `RAT`) that buys one tokenized stock (xStocks) and holds it forever. Everything is public.

## Mechanics (v1, final)

1. **Claim, every ~35s.** Claim pump.fun creator fees (bonding curve, and PumpSwap after graduation). Every claim is split: **50% to hires, 50% to the fund wallet.**
2. **Hire.** Hire budget / salary (~0.03 SOL, overhead included) = new rats. Each rat gets its own vanity wallet, its salary, buys one stock and **holds forever**. No trims, no sells, no promotions on-chain. Better performing stocks get more new hires.
3. **Buy and burn, every 8 to 12 min (random).** The fund wallet buys the coin and burns it, in chunks of at most 1 SOL a few seconds apart, at 1.5% max slippage. Skipped if under 0.01 SOL.

Everything else (promotions, rat size, rank, leaderboard, PnL) is computed from live prices **for display only**.

The only transaction types: **claim**, **hire** (fund + buy stock), **buy + burn**. An emergency sweep exists as a manual CLI command only, and the bot never runs it.

Rules that never change:

- Rats never die and never sell.
- If a stock is paused or frozen by its issuer, its rats are marked `frozen` and skipped.
- Prices are read off-chain (Jupiter Price API). Only claims, hires and burns are transactions.
- The database is the source of truth. Failed transactions retry next loop.
- The bot can only spend fees it has claimed (tracked in a ledger), never the creator wallet's own balance.
- **No payouts to holders, ever.** Profits only leave as buy and burn.
- All rat wallets and the total float are public on the site.

## Repo map

| Path | What |
|---|---|
| `ROADMAP.md` | Workstreams, safety, testing, launch checklist |
| `CONTRACT.md` | The JSON the website reads |
| `packages/contract/mock/` | Mock `state.json`, `rats.json`, `events.json` to animate against |
| `pnpm mock:api` | The same API with live-changing mock data on `localhost:8787` (hires, price drift, burns, a stock pausing) |
| `config/stocks.json` | The stock list (needs owner approval before live hires) |
| `OPEN-QUESTIONS.md` | Decisions only the owner can make, with the safe default picked |
| `STATUS.md` | What is built, tested, mocked, and how to go live |
| `SIMULATION.md` | Launch-hour simulation results (50 SOL in DRY RUN, caps, live on SimChain) |
| `packages/*` | Backend libraries (core, contract, db, keys, chain, pump, jupiter, safety) |
| `apps/*` | `worker` (the bot), `api` (public state API), `cli` (operator tools) |
| `tests/*` | End to end simulation and the mainnet smoke script |
| `infra/`, `docs/runbooks/` | Deploy config and runbooks |

## Safety defaults

- `DRY_RUN=true` by default. Going live needs `DRY_RUN=false` **and** `LIVE_CONFIRM` set to an exact phrase.
- Keys are encrypted (AES-256-GCM) in the database. The only secret in env is the master key.
- Spend cap: 30 SOL per hour per bucket (hires, burns), alert at 50%.
- Kill switch: env var, database flag, or CLI.
