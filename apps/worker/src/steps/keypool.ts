// Key pool (every 60s): background refill plus two alerts.
//  - low: fewer than KEYPOOL_LOW_ALERT keys left
//  - runway: the pool lasts less than KEYPOOL_RUNWAY_ALERT_HOURS at the current hire rate (rats created in
//    the last 30 minutes, doubled). The grinder's output is not subtracted, so this alert errs on the early side.
// A refill batch starts in the background while the pool is under KEYPOOL_REFILL_BELOW. It never blocks the loop.
import type { WorkerDeps } from '../deps';

export const HIRE_RATE_WINDOW_MIN = 30;

export interface KeypoolResult {
  available: number;
  hireRatePerHour: number;
  /** null while nothing is being hired */
  runwayHours: number | null;
  refillStarted: boolean;
  grinding: boolean;
}

export async function runKeypoolStep(d: WorkerDeps): Promise<KeypoolResult> {
  const k = d.config.keypool;
  const available = await d.keys.availableRatKeys();
  const since = new Date(d.clock.now().getTime() - HIRE_RATE_WINDOW_MIN * 60_000);
  const hireRatePerHour = (await d.store.rats.countCreatedSince(since)) * (60 / HIRE_RATE_WINDOW_MIN);
  const runwayHours = hireRatePerHour > 0 ? available / hireRatePerHour : null;

  const start = d.keyRefiller?.maybeStart(available);
  const grinding = d.keyRefiller?.busy ?? false;
  const fix = 'Import pre-ground keys with: rat keys import-dir <dir> (docs/runbooks/keys.md).';

  if (available < k.lowAlert) {
    await d.alerts.send('warn', 'keypool_low', `Rat key pool is low: ${available} keys left (alert below ${k.lowAlert})${grinding ? ', grinder running' : ''}. ${fix}`);
  }
  if (k.runwayAlertHours > 0 && runwayHours !== null && runwayHours < k.runwayAlertHours) {
    await d.alerts.send(
      'critical',
      'keypool_runway',
      `Rat key pool runs out in ~${runwayHours.toFixed(1)} h at the current hire rate (${Math.round(hireRatePerHour)} rats/h, ${available} keys left${grinding ? ', grinder running' : ', grinder idle'}). ${fix}`,
    );
  }
  return { available, hireRatePerHour, runwayHours, refillStarted: start?.started ?? false, grinding };
}
