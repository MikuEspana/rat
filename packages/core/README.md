# @rat/core

Shared foundation. Owned by WS01.

- `types.ts`: domain types (buckets, modes, statuses, tx kinds, ledger reasons)
- `ports.ts`: interfaces every package codes against (PriceSource, SwapBuilder, ChainReader, TxSender, KeyStore, stores, Alerts, KillSwitch)
- `config.ts`: `loadConfig()` for every variable in `.env.example`, `loadStocksFile()`
- `money.ts`: lamports math (bigint only)
- `logger.ts`: pino with secret redaction and bigint support
- `clock.ts`: `FakeClock`, `SeededRng`
- `picker.ts`: hire weights by 24h return rank with a floor
- `tx-record.ts`: balance deltas from a landed transaction

Safety rule enforced here: `DRY_RUN=false` without the exact `LIVE_CONFIRM` phrase fails to load.
