// Startup checks. In live mode a blocking issue stops the worker before it sends anything; in DRY RUN every
// issue is only a warning. Each issue says exactly what is wrong and how to fix it.
import type { WorkerDeps } from './deps';

/** WATCH_FROM_SLOT may be at most this far ahead of the chain (about a minute of slots). */
export const WATCH_FROM_SLOT_MAX_AHEAD = 150;

export interface PreflightIssue {
  check: string;
  message: string;
  /** true = the worker refuses to start in live mode */
  blocking: boolean;
}

export interface PreflightResult {
  ok: boolean;
  issues: PreflightIssue[];
}

export async function runPreflight(d: WorkerDeps): Promise<PreflightResult> {
  const live = !d.config.dryRun;
  const issues: PreflightIssue[] = [];

  // A watch floor in the future would hide every transaction until then, including a leaked key.
  if (d.config.watchFromSlot > 0) {
    const slot = await d.chain.getSlot();
    if (d.config.watchFromSlot > slot + WATCH_FROM_SLOT_MAX_AHEAD) {
      issues.push({
        check: 'watch_from_slot',
        blocking: live,
        message: `WATCH_FROM_SLOT=${d.config.watchFromSlot} is ahead of the current slot ${slot}: the wallet watch would ignore every transaction until then. Set it to the slot right after the coin launch (docs/runbooks/go-live.md).`,
      });
    }
  }

  return { ok: !issues.some((i) => i.blocking), issues };
}
