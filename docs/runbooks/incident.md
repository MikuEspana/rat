# Incident

Launch day: `INCIDENTS.md` has one screen per problem with the exact fix command.

First move: `rat kill --reason "<what you saw>"`. Then look.

| Symptom | Where to look | Action |
|---|---|---|
| Critical alert "transaction signed by the creator wallet was NOT sent by the bot" | Solscan for that signature | If it was you (a manual transaction), add its signature to `KNOWN_OWNER_TX_SIGS`, redeploy, then `rat resume`. Otherwise assume the key leaked. Keep the kill switch on. Move remaining funds with your cold wallet process; `rat sweep --to <cold>` moves the rats' stock + SOL (typed confirmation). |
| `cap_reached_*` alert | `rat status` (spent in the last hour) | Normal at very high volume: spending resumes as the hour rolls, the budget carries over. Raise `SPEND_CAP_SOL_PER_HOUR_*` only if you mean it. |
| `stock_paused_*` / `mint_rejected_*` | `rat stocks-sync` output | Issuer paused a stock (rats frozen automatically) or a mint failed verification (never hired into). Check the issuer's announcements. |
| `rat_balance_*` | Solscan for the rat wallet | Tokens moved by the issuer's permanent delegate. The rat is frozen. |
| `claim_failed`, many failed txs | `rat status` (txs last hour), RPC provider status | Usually RPC trouble. Switch `RPC_URL` / `RPC_URL_BACKUP`. |
| `hire_idle` (no rat hired for 30 min while more than 0.1 SOL waits) | the alert text (reason), `rat status`, the site's stock prices | Stale prices (weekend or Jupiter omits the xStocks): hires resume by themselves when prices are fresh. No approved or verified stock: fix `config/stocks.json`, `rat stocks-sync`. |
| `preflight_failed` (worker refused to start LIVE) | Railway logs of the worker (each reason on its own line) | Fix what it says (0 approved stocks, no approved stock passing the mint check, `WATCH_FROM_SLOT` ahead of the chain), redeploy. |
| `inflow_*` | Solscan | Someone sent SOL to our wallet. It is never spent by the bot. |
| Heartbeat stale (`/health` `ok: false`) | Railway logs of the worker | Restart the worker service. The lease lock frees itself after 120s. |

Emergency sweep (last resort). Turn the kill switch on first: only then are rats still being hired swept too. If the creator wallet was drained (a key leak), each rat pays its own fee. Tokens in an account the issuer froze, or of a paused stock, cannot move: their SOL still goes, and the sweep says which rats to sweep again later. It exits with an error whenever anything is left behind. Run it from the Mac as `scripts/rat.sh sweep ...`.
```
rat sweep --to <cold wallet>                                   # prints the plan
rat sweep --to <cold wallet> --confirm "SWEEP ALL RATS TO <cold wallet>"
```
In DRY RUN it only simulates. Live it needs `DRY_RUN=false` + `LIVE_CONFIRM`.
