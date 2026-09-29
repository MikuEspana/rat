import { SETTINGS, formatSol } from '@rat/core';
import type { CliContext } from '../context';

const HOUR_MS = 3_600_000;

/** Machine-readable status (`rat status --json`), for scripts/staging.sh and other scripts. No secret in it. */
export async function statusJson(ctx: CliContext): Promise<Record<string, unknown>> {
  const { store, config, clock } = ctx;
  const since = new Date(clock.now().getTime() - HOUR_MS);
  const sums = await store.ledger.sumByReason();
  const claims = await store.claims.totals();
  const killDb = (await store.settings.get(SETTINGS.killSwitch)) === 'on';
  return {
    mode: config.dryRun ? 'dry_run' : 'live',
    staging: config.staging,
    killSwitch: { on: config.killSwitch || killDb, reason: config.killSwitch ? 'KILL_SWITCH env var' : killDb ? await store.settings.get(SETTINGS.killReason) : null },
    hireBudgetSol: formatSol(await store.ledger.balance('hire')),
    hourOutflowSol: formatSol(await store.ledger.netOutflowSince('hire', since)),
    hourCapSol: formatSol(config.spendCapLamportsPerHour.hire),
    salarySol: formatSol(config.salaryLamports),
    claimedSol: formatSol(claims.claimed),
    claims: claims.count,
    seededSol: formatSol(sums.get('hire:seed_credit') ?? 0n),
    rats: await store.rats.countByStatus(),
    openReservations: (await store.ledger.openReservations('hire')).length,
    creatorKey: (await store.keys.getRole('creator'))?.pubkey ?? null,
    stagingCrashDone: (await store.settings.get(SETTINGS.stagingCrashDone)) !== null,
    attemptsLastHour: Object.fromEntries(await store.attempts.countByStatusSince(since)),
    loops: (await store.heartbeats.all()).map((hb) => ({ loop: hb.loop, ageSec: Math.round((clock.now().getTime() - hb.lastRunAt.getTime()) / 1000), lastError: hb.lastError ?? null })),
  };
}

export async function statusCommand(ctx: CliContext, opts: { json?: boolean } = {}): Promise<void> {
  const { store, config, out, clock } = ctx;
  if (opts.json) {
    out(JSON.stringify(await statusJson(ctx)));
    return;
  }
  const kill = await store.settings.get(SETTINGS.killSwitch);
  const since = new Date(clock.now().getTime() - HOUR_MS);
  out(`mode:            ${config.dryRun ? 'DRY RUN (paper)' : 'LIVE'}${config.smokeMode ? ' + SMOKE' : ''}`);
  out(`kill switch:     ${config.killSwitch ? 'ON (env)' : kill === 'on' ? `ON (db: ${(await store.settings.get(SETTINGS.killReason)) ?? ''})` : 'off'}`);
  for (const bucket of ['hire'] as const) {
    const bal = await store.ledger.balance(bucket);
    const used = await store.ledger.netOutflowSince(bucket, since);
    const cap = config.spendCapLamportsPerHour[bucket];
    out(`${bucket} bucket:     ${formatSol(bal)} SOL available, ${formatSol(used)} / ${formatSol(cap)} SOL spent in the last hour`);
  }
  const keys = await store.keys.counts();
  out(`rat wallets:     ${keys.assigned} keys stored encrypted (${keys.unused} never used: hire abandoned before any tx)`);
  out(`creator key:     ${(await store.keys.getRole('creator'))?.pubkey ?? 'NOT IMPORTED'}`);
  out(`rats:            ${JSON.stringify(await store.rats.countByStatus())}`);
  const claims = await store.claims.totals();
  out(`claimed:         ${formatSol(claims.claimed)} SOL in ${claims.count} claims (every claimed SOL goes to hires)`);
  const attempts = await store.attempts.countByStatusSince(since);
  out(`txs last hour:   ${JSON.stringify(Object.fromEntries(attempts))}`);
  for (const hb of await store.heartbeats.all()) {
    const age = Math.round((clock.now().getTime() - hb.lastRunAt.getTime()) / 1000);
    out(`loop ${hb.loop.padEnd(10)} last run ${age}s ago${hb.lastError ? `, last error: ${hb.lastError}` : ''}`);
  }
}
