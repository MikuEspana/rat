import type { AppConfig, Clock } from '@rat/core';
import type { Store } from '@rat/db';

export interface CliContext {
  config: AppConfig;
  /** bound to the mode the bot runs in (paper when DRY_RUN, live otherwise) */
  store: Store;
  clock: Clock;
  out: (line: string) => void;
  /** messages for the person, when stdout carries data (for example `keys backup --out -`); default: out */
  err?: (line: string) => void;
}
