# Mainnet smoke test (owner only)

**Agents never run this.** It sends real mainnet transactions. Hard cap: 0.1 SOL of bot spend, enforced in code (`SMOKE_MODE` lifetime cap in the SpendGuard) on top of the preflight below.

## What it proves
1. Claiming real creator fees of a coin works (`collect_creator_fee_v2`).
2. The one-transaction hire works with Jupiter `/build` (`taker` = empty rat wallet, `payer` = creator). If it fails, set `HIRE_MODE=two_step` and rerun (owner decision #3).
3. Real rent and fees per rat.

## Steps
1. Create a **throwaway** test creator wallet and fund it with ~0.1 SOL.
2. Launch a **throwaway** coin on pump.fun from the test creator (normal mode: no holder rewards, no fee sharing). Make one small buy so some creator fees exist.
3. Use a **fresh** database (for example a second Railway Postgres service or `DATABASE_URL=pglite://./smoke-db`).
4. Environment:
   ```
   SMOKE_MODE=true
   SMOKE_CAP_SOL=0.1
   DRY_RUN=false
   LIVE_CONFIRM=I_UNDERSTAND_THIS_SENDS_MAINNET_TRANSACTIONS
   MAX_HIRES_PER_LOOP=2
   COIN_MINT=<test coin>
   CREATOR_PUBKEY=<test creator>
   RPC_URL=...  JUPITER_API_KEY=...  KEY_ENCRYPTION_KEY=...  DATABASE_URL=...
   ```
   Approve at least 3 stocks in `config/stocks.json` (the mint check needs a majority of 3).
5. Import the test key: `rat keys import --role creator` (stdin). Rat wallets are created at hire time.
6. Run: `pnpm --filter @rat/tests smoke -- --topup-hire 0.06`
   (the top-up only credits the ledger for SOL you already sent to the test wallet; the test coin's own fees are tiny).
7. Read `tests/smoke/REPORT.md` and check the claim and the rats on Solscan.

The preflight refuses to start unless: `SMOKE_MODE=true`, cap <= 0.1 SOL, live mode confirmed, `COIN_MINT` + the test wallet set, `MAX_HIRES_PER_LOOP` <= 2, and the database has no live rats.
