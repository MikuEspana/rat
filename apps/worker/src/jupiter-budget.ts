// The worker's one Jupiter budget (packages/jupiter/src/budget.ts), wired to the alerts: a 429 means something
// else is using our Jupiter key or the plan changed, so the owner hears about it (throttled per key).
import type { Alerts, AppConfig } from '@rat/core';
import { JupiterBudget } from '@rat/jupiter';

export function createJupiterBudget(cfg: AppConfig, now: () => number, alerts: Alerts, opts: { startEmpty?: boolean } = {}): JupiterBudget {
  return new JupiterBudget(cfg.jupiter.maxRpm, now, {
    startEmpty: opts.startEmpty,
    onRateLimited: ({ streak, waitMs }) => {
      void alerts
        .send(
          'warn',
          'jupiter_429',
          `Jupiter answered 429 (rate limited), ${streak} in a row: no Jupiter call for ${Math.round(waitMs / 1000)} s (backoff doubles up to 5 min). Hires wait, nothing is lost. The worker stays under ${cfg.jupiter.maxRpm} calls a minute, so check what else uses the key.`,
        )
        .catch(() => undefined);
    },
  });
}
