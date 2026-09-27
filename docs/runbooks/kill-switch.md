# Kill switch

Stops every new transaction (claims, hires, burns) at the guarded sender. Transactions already sent are still tracked to confirmation. Read-only loops (prices, reconcile) keep running, so the site stays live.

| Way | How | Undo |
|---|---|---|
| CLI | `rat kill --reason "why"` | `rat resume` |
| Env | set `KILL_SWITCH=true` on the worker, redeploy | set it back to `false` |
| Automatic | the worker engages it when a transaction signed by the creator or fund wallet was not sent by the bot | investigate first (`incident.md`), then `rat resume` |

Check with `rat status` (`kill switch: ON (...)`). The site shows `bot.mode = "paused"`.

The emergency sweep (`rat sweep`) is the only transaction that ignores the kill switch, and it needs a typed confirmation.
