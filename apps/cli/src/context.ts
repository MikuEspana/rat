import type { AppConfig, Clock } from '@rat/core';
import type { Store } from '@rat/db';

export interface CliContext {
  config: AppConfig;
  /** bound to the mode the bot runs in (paper when DRY_RUN, live otherwise) */
  store: Store;
  clock: Clock;
  out: (line: string) => void;
}
