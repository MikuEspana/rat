// Rehearsal only: the one-shot crash test (STAGING_CRASH_AFTER_SEND=N). Right after the Nth hire is broadcast, before
// it is confirmed, the worker kills itself with SIGKILL (no cleanup, like a crash or a lost machine). Railway restarts
// it and the hire state machine must finish that rat exactly once. It fires once per database: a setting records it
// before the kill. Wired only when STAGING is on and the database is marked as staging (production.ts).
import { type AppConfig, type Logger, type PreparedTx, SETTINGS } from '@rat/core';
import type { Store } from '@rat/db';

export function stagingCrashHook(
  cfg: Pick<AppConfig, 'staging' | 'stagingCrashAfterSend'>,
  store: Store,
  opts: { log?: Logger; kill?: () => void } = {},
): ((tx: PreparedTx) => Promise<void>) | undefined {
  if (!cfg.staging || cfg.stagingCrashAfterSend <= 0) return undefined;
  let hires = 0;
  return async (tx) => {
    if (tx.request.kind !== 'hire') return;
    hires++;
    if (hires < cfg.stagingCrashAfterSend) return;
    if (await store.settings.get(SETTINGS.stagingCrashDone)) return;
    await store.settings.set(SETTINGS.stagingCrashDone, `${new Date().toISOString()} ${tx.signature}`);
    opts.log?.warn({ sig: tx.signature, hire: hires }, 'STAGING crash test: killing the worker right after this hire was broadcast');
    (opts.kill ?? (() => process.kill(process.pid, 'SIGKILL')))();
  };
}
