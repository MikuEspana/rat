# End-to-end simulations

Everything in memory: PGlite + SimChain (real System/ATA/Token semantics and the real pump.fun claim instructions) + mock Jupiter + fake clock. Nothing touches mainnet.

| File | Scenario |
|---|---|
| `launch-hour.test.ts` | **A** DRY RUN hour with 50 SOL of fees; **B** 100 SOL hour hitting the 30 SOL/h caps, budget carried over; **C** live execution on SimChain with exact wallet vs ledger conservation |
| `resilience.test.ts` | **D** 12% random tx failures (drop, fail, land-but-timeout, reject); **E** kill switch and a paused stock mid-run; **F** outside actors (external claims, random SOL) |
| `scale.test.ts` | 6,000 rats: loop time, reconcile coverage, API |
| `launch-hour-report.ts` | writes `SIMULATION.md` at the repo root (`pnpm --filter @rat/tests sim:launch-hour`) |
