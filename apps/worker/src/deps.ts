// Everything the worker needs, injected. Production wiring is in main.ts; tests and the simulation wire
// the same steps to SimChain + mock Jupiter (see sim-world.ts).
import type {
  Alerts,
  AppConfig,
  ChainReader,
  Clock,
  KeyStore,
  KillSwitch,
  Logger,
  PriceSource,
  Pubkey,
  Rng,
  StockConfigEntry,
  SwapBuilder,
} from '@rat/core';
import type { Store } from '@rat/db';
import type { PumpFunClient } from '@rat/pump';
import type { GuardedSender, SpendGuard } from '@rat/safety';

export interface WorkerDeps {
  config: AppConfig;
  /** paper store in DRY RUN, live store otherwise */
  store: Store;
  clock: Clock;
  rng: Rng;
  log: Logger;
  chain: ChainReader;
  sender: GuardedSender;
  guard: SpendGuard;
  keys: KeyStore;
  pump: PumpFunClient;
  prices: PriceSource;
  /** Jupiter /build (or the mock) */
  swap: SwapBuilder;
  alerts: Alerts;
  killSwitch: KillSwitch;
  stocks: StockConfigEntry[];
  creator: Pubkey;
}

/** In-memory state that does not need to survive a restart. */
export class WorkerState {
  solUsd: number | null = null;
  coinUsd: number | null = null;
  reconcileCursor = 0;
  lastPriceHistoryAt = new Map<string, number>();
  consecutiveFailures = new Map<string, number>();
  lastPaperClaimAt: number | null = null;
  paperFakeAccrued = 0n;
}
