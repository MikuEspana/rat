// Key pool: alerts when the vanity key pool runs low and tops it up with the grinder when one is wired.
import type { WorkerDeps } from '../deps';

export async function runKeypoolStep(d: WorkerDeps): Promise<{ available: number; added: number }> {
  const available = await d.keys.availableRatKeys();
  if (available >= d.config.keypoolMin) return { available, added: 0 };
  await d.alerts.send('warn', 'keypool_low', `Rat key pool is low: ${available} left (min ${d.config.keypoolMin}). Import pre-ground keys with: rat keys import-dir <dir>`);
  if (!d.refillKeys) return { available, added: 0 };
  const r = await d.refillKeys();
  return { available: available + r.added, added: r.added };
}
