# Incident

First move: `rat kill --reason "<what you saw>"`. Then look.

| Symptom | Where to look | Action |
|---|---|---|
| Critical alert "transaction signed by the creator/fund wallet was NOT sent by the bot" | Solscan for that signature | Assume the key leaked. Keep the kill switch on. Move remaining funds with your cold wallet process; `rat sweep --to <cold>` moves the rats' stock + SOL (typed confirmation). |
| `cap_reached_*` alert | `rat status` (spent in the last hour) | Normal at very high volume: spending resumes as the hour rolls, the budget carries over. Raise `SPEND_CAP_SOL_PER_HOUR_*` only if you mean it. |
| `stock_paused_*` / `mint_rejected_*` | `rat stocks-sync` output | Issuer paused a stock (rats frozen automatically) or a mint failed verification (never hired into). Check the issuer's announcements. |
| `rat_balance_*` | Solscan for the rat wallet | Tokens moved by the issuer's permanent delegate. The rat is frozen. |
| `claim_failed`, `burn_failed`, many failed txs | `rat status` (txs last hour), RPC provider status | Usually RPC trouble. Switch `RPC_URL` / `RPC_URL_BACKUP`. |
| `keypool_empty` / `keypool_low` | `rat keys pool` | `keys.md`: import pre-ground keys. |
| `inflow_*` | Solscan | Someone sent SOL to our wallet. It is never spent by the bot. |
| Heartbeat stale (`/health` `ok: false`) | Railway logs of the worker | Restart the worker service. The lease lock frees itself after 120s. |

Emergency sweep (last resort):
```
rat sweep --to <cold wallet>                                   # prints the plan
rat sweep --to <cold wallet> --confirm "SWEEP ALL RATS TO <cold wallet>"
```
In DRY RUN it only simulates. Live it needs `DRY_RUN=false` + `LIVE_CONFIRM`.
