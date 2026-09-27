// Startup checks. In live mode a blocking issue stops the worker before it sends anything; in DRY RUN every
// issue is only a warning. Each issue says exactly what is wrong and how to fix it.
import { verifyStockMints } from '@rat/safety';
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

  // Live hires need at least one approved stock whose mint passes the check (Token-2022 + xStocks authority).
  const all = await d.store.stocks.list();
  const enabled = all.filter((s) => s.enabled);
  const approved = enabled.filter((s) => s.approved);
  if (approved.length === 0) {
    issues.push({
      check: 'approved_stocks',
      blocking: live,
      message: `0 of ${enabled.length} enabled stocks are approved in ${d.config.stocksFile}, so no rat could ever be hired and the hire budget would sit idle. Verify the mints on xstocks.fi, set "approved": true for each stock you want, then run: rat stocks-sync. Not approved: ${enabled.map((s) => s.symbol).join(', ') || 'none configured'}.`,
    });
  } else {
    const states = await d.chain.getMintStates(all.map((s) => s.mint));
    const v = verifyStockMints(states, d.config.xstocksMintAuthority);
    const passing = approved.filter((s) => v.checks.get(s.mint)?.ok);
    if (passing.length === 0) {
      issues.push({
        check: 'approved_stocks_verified',
        blocking: live,
        message: `${approved.length} stocks are approved but none passes the mint check (Token-2022 + xStocks mint authority), so no rat could be hired: ${approved.map((s) => `${s.symbol}: ${v.checks.get(s.mint)?.reason ?? 'no mint state'}`).join('; ')}.`,
      });
    }
  }

  return { ok: !issues.some((i) => i.blocking), issues };
}
