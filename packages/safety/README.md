# @rat/safety

Nothing leaves a wallet without passing these. Owned by WS08.

- `spend-guard.ts`: `authorize()` is the only way to reserve money for a hire. It requires:
  - the kill switch is off
  - the **hire ledger bucket** covers the amount (claimed fees only; the wallet's own SOL never counts)
  - the rolling 60-minute net outflow stays under the cap (`SPEND_CAP_SOL_PER_HOUR_HIRE`, 60 SOL)
  - the smoke lifetime cap holds (smoke mode)
  - live: the creator wallet holds amount + reserve

  Alerts once when spending crosses `SPEND_ALERT_PCT` (50%), and critical when a cap is hit. `settle()` books the real cost (critical `overspend_*` alert if it was more than reserved), `release()` returns a reservation that definitely did not land. `authorize()` calls run one at a time.
- `guarded-sender.ts`: every transaction goes through it. In order:
  - kill switch (only the emergency `sweep` bypasses it)
  - reservation required for a hire
  - live claim/hire: **effects check**. The signed tx is simulated; it is refused (critical `effects_*` alert) if any of our wallets would lose more than its limit or the rat would get less than the quoted minimum. No limits or no simulation = not sent.
  - **lease fence**: the worker renews its lease right before sending; a worker that lost it sends nothing
  - attempt written before sending; a send that throws after that counts as `unknown` (re-checked later), never as "not sent"
  - DRY RUN = simulate only
- `effects.ts`: the pure limit check used by the effects check.
- `kill-switch.ts`: env `KILL_SWITCH` or the database flag (`rat kill` / `rat resume`).
- `alerts.ts`: Telegram + log, throttled per key (10 min).
- `mint-verifier.ts`: owner rule #12. Token-2022 program + mint authority equal to `XSTOCKS_MINT_AUTHORITY`, or the strict-majority authority (at least 3). No clear majority = everything rejected.
