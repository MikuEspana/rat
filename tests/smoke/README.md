# Mainnet smoke test (owner only)

**Agents never run this.** It sends real mainnet transactions. Hard cap: 0.1 SOL of bot spend, enforced in code (`SMOKE_MODE` lifetime cap in the SpendGuard) on top of the preflight below.

## What it proves
1. Claiming real creator fees of a coin works (`collect_creator_fee_v2`).
2. The one-transaction hire works with Jupiter `/build` (`taker` = empty rat wallet, `payer` = creator). If it fails, set `HIRE_MODE=two_step` and rerun (owner decision #3).
3. Buy + burn works with the coin's real token program.
4. Real rent and fees per rat.

## Steps
1. Create **throwaway** wallets: test creator, test fund. Fund the test creator with ~0.12 SOL, the test fund with ~0.02 SOL.
2. Launch a **throwaway** coin on pump.fun from the test creator (normal mode: no holder rewards, no fee sharing). Make one small buy so some creator fees exist.
3. Use a **fresh** database (for example a second Supabase project or `DATABASE_URL=pglite://./smoke-db`).
4. Environment:
   ```
   SMOKE_MODE=true
   SMOKE_CAP_SOL=0.1
   DRY_RUN=false
   LIVE_CONFIRM=I_UNDERSTAND_THIS_SENDS_MAINNET_TRANSACTIONS
   MAX_HIRES_PER_LOOP=2
   COIN_MINT=<test coin>
   CREATOR_PUBKEY=<test creator>  FUND_PUBKEY=<test fund>
   RPC_URL=...  JUPITER_API_KEY=...  KEY_ENCRYPTION_KEY=...  DATABASE_URL=...
   ```
   Approve at least 3 stocks in `config/stocks.json` (the mint check needs a majority of 3).
5. Import the test keys: `rat keys import --role creator` and `--role fund` (stdin), and `rat keys grind --count 2`.
6. Run: `pnpm --filter @rat/tests smoke -- --topup-hire 0.06 --topup-burn 0.012`
   (the top-ups only credit the ledger for SOL you already sent to the test wallets; the test coin's own fees are tiny).
7. Read `tests/smoke/REPORT.md` and check the rats and the burn on Solscan.
8. Optional, only if you want burns through Jito (`BURN_SEND_VIA=jito`, OPEN-QUESTIONS #12): run steps 6 and 7 again with `BURN_SEND_VIA=jito` added to the environment, on a fresh database. On Solscan the burn tx must end with a small SOL transfer to a Jito tip account. If it never lands (the worker logs "polling until the blockhash expires"), raise `JITO_TIP_SOL` or keep `BURN_SEND_VIA=rpc`.

The preflight refuses to start unless: `SMOKE_MODE=true`, cap <= 0.1 SOL, live mode confirmed, `COIN_MINT` + test wallets set, `MAX_HIRES_PER_LOOP` <= 2, and the database has no live rats.
