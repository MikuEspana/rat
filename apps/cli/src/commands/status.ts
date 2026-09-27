import { SETTINGS, formatSol } from '@rat/core';
import type { CliContext } from '../context';

const HOUR_MS = 3_600_000;

export async function statusCommand(ctx: CliContext): Promise<void> {
  const { store, config, out, clock } = ctx;
  const kill = await store.settings.get(SETTINGS.killSwitch);
  const since = new Date(clock.now().getTime() - HOUR_MS);
  out(`mode:            ${config.dryRun ? 'DRY RUN (paper)' : 'LIVE'}${config.smokeMode ? ' + SMOKE' : ''}`);
  out(`kill switch:     ${config.killSwitch ? 'ON (env)' : kill === 'on' ? `ON (db: ${(await store.settings.get(SETTINGS.killReason)) ?? ''})` : 'off'}`);
  for (const bucket of ['hire', 'burn'] as const) {
    const bal = await store.ledger.balance(bucket);
    const used = await store.ledger.netOutflowSince(bucket, since);
    const cap = config.spendCapLamportsPerHour[bucket];
    out(`${bucket} bucket:     ${formatSol(bal)} SOL available, ${formatSol(used)} / ${formatSol(cap)} SOL spent in the last hour`);
  }
  out(`fund share owed: ${formatSol(await store.claims.pendingFundTransfer())} SOL (rides in the next claim tx)`);
  const keys = await store.keys.counts();
  out(`rat key pool:    ${keys.available} available, ${keys.assigned} assigned (min ${config.keypoolMin})`);
  out(`creator key:     ${(await store.keys.getRole('creator'))?.pubkey ?? 'NOT IMPORTED'}`);
  out(`fund key:        ${(await store.keys.getRole('fund'))?.pubkey ?? 'NOT IMPORTED'}`);
  out(`rats:            ${JSON.stringify(await store.rats.countByStatus())}`);
  const claims = await store.claims.totals();
  const burns = await store.burns.totals();
  out(`claimed:         ${formatSol(claims.claimed)} SOL in ${claims.count} claims`);
  out(`burned:          ${burns.count} burns, ${formatSol(burns.spent)} SOL spent`);
  const attempts = await store.attempts.countByStatusSince(since);
  out(`txs last hour:   ${JSON.stringify(Object.fromEntries(attempts))}`);
  for (const hb of await store.heartbeats.all()) {
    const age = Math.round((clock.now().getTime() - hb.lastRunAt.getTime()) / 1000);
    out(`loop ${hb.loop.padEnd(10)} last run ${age}s ago${hb.lastError ? `, last error: ${hb.lastError}` : ''}`);
  }
}
