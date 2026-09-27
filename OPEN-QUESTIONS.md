# Open Questions

Decisions only the owner can make. For each one, the safest option was picked so work could continue. Change any of them by editing config or replying.

| # | Question | Safe default picked | Where |
|---|---|---|---|
| 1 | Are the stock mints in `config/stocks.json` the real xStocks? They come from a third-party list (REPORTED). | Every stock has `approved: false`. Live mode never hires into an unapproved stock. Dry run may use them for paper rats. | `config/stocks.json` |
| 2 | HOODx and CRCLx mints could not be verified. | Left out of the list. Add them with their mint from xstocks.fi to include them. | `config/stocks.json` |
| 3 | Is Jupiter's `usdPrice` per scaled UI token (after the Scaled UI multiplier) or per raw token? UNCLEAR. | Rat value = scaled UI amount x `usdPrice`. Display only, so the worst case is a small display error. Run `pnpm --filter @rat/jupiter check:scaled-ui` once with a key and RPC to confirm. | `packages/jupiter` |
| 4 | Expected xStocks mint authority. Not verified from this sandbox (mainnet RPC is blocked by network policy). | `XSTOCKS_MINT_AUTHORITY` empty = the authority shared by the majority (at least 3) of configured mints. If there is no clear majority, every stock is rejected (no hires). Set the env var once you confirm the address. | `.env.example` |
