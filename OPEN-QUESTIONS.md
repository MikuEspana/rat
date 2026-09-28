# Open Questions

Decisions only the owner can make. For each one, the safest option was picked so work could continue. Change any of them by editing config or replying.

| # | Question | Safe default picked | Where |
|---|---|---|---|
| 1 | Are the stock mints in `config/stocks.json` the real xStocks? They come from a third-party list (REPORTED). | Every stock has `approved: false`. Live mode never hires into an unapproved stock. Dry run may use them for paper rats. | `config/stocks.json` |
| 2 | HOODx and CRCLx mints could not be verified. | Left out of the list. Add them with their mint from xstocks.fi to include them. | `config/stocks.json` |
| 3 | Is Jupiter's `usdPrice` per scaled UI token (after the Scaled UI multiplier) or per raw token? UNCLEAR. | Rat value = scaled UI amount x `usdPrice`. Display only, so the worst case is a small display error. Run `pnpm --filter @rat/jupiter check:scaled-ui` once with a key and RPC to confirm. | `packages/jupiter` |
| 4 | Expected xStocks mint authority. Not verified from this sandbox (mainnet RPC is blocked by network policy). | `XSTOCKS_MINT_AUTHORITY` empty = the authority shared by the majority (at least 3) of configured mints. If there is no clear majority, every stock is rejected (no hires). Set the env var once you confirm the address. | `.env.example` |
| 5 | Vanity rat addresses (ending in RAT) and pre-grinding keys. | **Resolved by the owner: dropped.** Every rat gets a fresh normal keypair at hire time, encrypted and stored before any SOL is sent to it. No grinding, no key pool, no `solana-keygen`. | `docs/runbooks/keys.md` |
| 6 | Does Jupiter `/build` build a hire for a rat wallet that is still empty (the salary arrives in the same tx) with `payer` = creator? UNCLEAR until mainnet. | 1-tx hire is the default. If the smoke test shows it fails, set `HIRE_MODE=two_step` (fund, then the rat buys). Both are tested on SimChain. | `.env.example` |
| 7 | Real cost of a hire. The salary is 0.03 SOL all-in with a 0.0025 SOL overhead allowance for the xStock token account rent + fees. xStock account rent is estimated (Token-2022 accounts with extensions). | The ledger books the real cost of every hire, so a different rent only changes how many rats fit, never the accounting. The smoke report shows the real number; raise `HIRE_OVERHEAD_EST_SOL` if rent + fees exceed 0.0025. | `.env.example` |
| 8 | Price deviation guard. A hire is skipped when the implied buy price is more than 2% above the Price API price. Thin xStock liquidity could trip it often. | `MAX_PRICE_IMPACT_PCT=2`. `check:stocks` prints each stock's deviation for a real salary-sized buy; stocks that fail it are skipped for that loop, not forever. | `.env.example` |
| 9 | ~~Burns are a predictable, sandwichable buy.~~ | Closed 2026-09-28: buy and burn was removed. Every claimed fee hires rats. | |
| 12 | ~~Send burns through Jito?~~ | Closed 2026-09-28: no burns, so the Jito route was removed. Every transaction goes through the normal RPC send. | |
| 10 | Owner-funded smoke top-ups. The throwaway coin's fees are too small to hire 2 rats, so the smoke script credits the ledger for SOL you send to the test wallets yourself. | Only the smoke script can do this, only with `SMOKE_MODE=true`, and the 0.1 SOL smoke cap still applies. The production bot has no manual credit path (you are away during launch). | `tests/smoke/README.md` |
| 11 | Operating from the EU with tokenized US stocks (xStocks terms). | Noted, proceeding as instructed. Not a code question. | none |
