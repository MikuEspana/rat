# @rat/safety

Nothing leaves a wallet without passing these. Owned by WS08.

- `spend-guard.ts`: `authorize()` is the only way to reserve money for a hire or burn. It requires:
  - the kill switch is off
  - the **ledger bucket** covers the amount (claimed fees only; the wallet's own SOL never counts)
  - the bucket's rolling 60-minute net outflow stays under its cap (`SPEND_CAP_SOL_PER_HOUR_HIRE` / `_BURN`, 30 SOL each)
  - the smoke lifetime cap holds (smoke mode)
  - live: the wallet holds amount + reserve (+ the fund share owed, for the creator)

  Alerts once when a bucket crosses `SPEND_ALERT_PCT` (50%), and critical when a cap is hit. `settle()` books the real cost, `release()` returns a reservation that definitely did not land.
- `guarded-sender.ts`: every transaction goes through it. Kill switch (only the emergency `sweep` bypasses it), reservation required for hire/burn, attempt written before sending, DRY RUN = simulate only.
- `kill-switch.ts`: env `KILL_SWITCH` or the database flag (`rat kill` / `rat resume`).
- `alerts.ts`: Telegram + log, throttled per key (10 min).
- `mint-verifier.ts`: owner rule #12. Token-2022 program + mint authority equal to `XSTOCKS_MINT_AUTHORITY`, or the strict-majority authority (at least 3). No clear majority = everything rejected.
