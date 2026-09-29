// Production entrypoint. DRY_RUN=true by default: every transaction is built, signed and SIMULATED, never sent.
// Sending needs DRY_RUN=false AND LIVE_CONFIRM=<exact phrase> (enforced by config and again by the sender).
import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import { createLogger, loadConfig, publicConfigSummary, sleep, systemClock } from '@rat/core';
import { isStagingDatabase, stagingProblems } from '@rat/db';
import { runPreflightUntilAnswered } from './preflight';
import { LeaseGate } from './fenced-store';
import { createProductionDeps } from './production';
import { LockedRunner, createWorker } from './worker';

async function main(): Promise<void> {
  const cfg = loadConfig();
  const log = createLogger({ level: cfg.logLevel, name: 'rat-worker' });
  log.info(publicConfigSummary(cfg), cfg.dryRun ? 'starting in DRY RUN: nothing will be sent' : 'starting LIVE: transactions will be sent');
  // every database write of a tick first proves this worker still holds the lease (bound below, once the runner exists)
  const lease = new LeaseGate();
  let { deps, handle } = await createProductionDeps(cfg, log, { waitForCreatorKey: true, lease });
  // staging and production never meet: refused in DRY RUN too
  const staging = await stagingProblems(deps.store, cfg);
  if (cfg.staging && staging.length === 0 && !(await isStagingDatabase(deps.store, cfg))) {
    // a fresh staging database: wait, doing nothing, until `rat staging-init` (run inside this container) marks it
    log.warn('STAGING: this database is not marked as staging yet. Waiting for: rat staging-init');
    while (!(await isStagingDatabase(deps.store, cfg))) {
      await sleep(5_000);
      if ((await stagingProblems(deps.store, cfg)).length > 0) break;
    }
    await handle.close();
    ({ deps, handle } = await createProductionDeps(cfg, log, { waitForCreatorKey: true, lease })); // rewired for the staging database
    staging.push(...(await stagingProblems(deps.store, cfg)));
  }
  if (staging.length > 0) {
    log.fatal({ reasons: staging }, 'refusing to start: staging check failed');
    await deps.alerts.send('critical', 'staging_refused', `Worker refused to start:\n- ${staging.join('\n- ')}`);
    await handle.close();
    process.exit(1);
  }
  // an RPC or database hiccup at startup is waited out (with an alert), never a crash loop Railway gives up on
  const pre = await runPreflightUntilAnswered(deps, {
    sleep,
    onRetry: async (err, attempt, waitMs) => {
      log.error({ err, attempt }, `startup checks could not read the chain or the database; retrying in ${waitMs / 1000}s`);
      if (attempt === 3) await deps.alerts.send('warn', 'startup_retrying', `Worker startup: the checks cannot read the chain or the database (${(err as Error).message}). Retrying every minute; nothing runs until they answer.`);
    },
  });
  for (const issue of pre.issues) {
    if (issue.blocking) log.error({ check: issue.check }, issue.message);
    else log.warn({ check: issue.check }, issue.message);
  }
  if (!pre.ok) {
    const why = pre.issues.filter((i) => i.blocking).map((i) => i.message);
    log.fatal({ reasons: why }, 'refusing to start LIVE: preflight failed');
    await deps.alerts.send('critical', 'preflight_failed', `Worker refused to start LIVE:\n- ${why.join('\n- ')}`);
    await handle.close();
    process.exit(1);
  }
  const runner = new LockedRunner(createWorker(deps), {
    store: deps.store,
    clock: systemClock,
    holder: `${hostname()}:${process.pid}:${randomBytes(4).toString('hex')}`,
  });
  // every send and every database write first proves this worker still holds the lease: a worker that froze past it
  // and woke up after a replacement took over sends nothing and writes nothing (apps/worker/src/fenced-store.ts)
  deps.sender.setFence(() => runner.fence());
  lease.bind(() => runner.fence());

  let stopping = false;
  const stop = () => {
    stopping = true;
    log.info('stopping after the current tick');
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);

  let waitingLogged = false;
  while (!stopping) {
    const ran = await runner.tryTick().catch((err) => {
      log.error({ err }, 'tick failed');
      return true;
    });
    if (!ran && !waitingLogged) {
      log.warn('another worker holds the lock; waiting');
      waitingLogged = true;
    }
    if (ran) waitingLogged = false;
    await sleep(1_000);
  }
  await runner.release();
  await handle.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
