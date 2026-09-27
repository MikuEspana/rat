# @rat/chain

Chain access. Owned by WS05.

- `rpc-sender.ts`: **the only file allowed to send transactions** (CI guard). Adds compute budget (priority fee capped by `PRIORITY_FEE_MICROLAMPORTS_MAX`), builds a v0 tx with lookup tables, signs, sends, rebroadcasts, confirms by block height. `submit()` throws unless `DRY_RUN=false` and `LIVE_CONFIRM` matched. A preflight rejection is `failed` with no record (never landed). A tx is `expired` only once the block height is 30 blocks past its last valid height.
- `rpc-reader.ts`: balances, mint states, token accounts, signatures and normalized tx records, with failover to `RPC_URL_BACKUP`.
- `mint-parse.ts`: SPL Token and Token-2022 mints, including Pausable (`paused`), Scaled UI Amount (multiplier in effect now) and Permanent Delegate.
- `sim/`: `SimChain` (in-memory Solana: System, ATA and Token programs, fees, signers, rent, paused mints, frozen accounts, wrapped SOL), `SimTxSender` (failure injection: drop, fail, land_timeout, reject), `SimChainReader`. Other packages register their program handlers (pump.fun, mock Jupiter swap).
