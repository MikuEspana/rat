// Production entrypoint. DRY_RUN=true by default: every transaction is built, signed and SIMULATED, never sent.
// Sending needs DRY_RUN=false AND LIVE_CONFIRM=<exact phrase> (enforced by config and again by the sender).
import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import { createLogger, loadConfig, publicConfigSummary, sleep, systemClock } from '@rat/core';
import { runPreflight } from './preflight';
import { createProductionDeps } from './production';
import { LockedRunner, createWorker } from './worker';

async function main(): Promise<void> {
  const cfg = loadConfig();
  const log = createLogger({ level: cfg.logLevel, name: 'rat-worker' });
  log.info(publicConfigSummary(cfg), cfg.dryRun ? 'starting in DRY RUN: nothing will be sent' : 'starting LIVE: transactions will be sent');
  const { deps, handle } = await createProductionDeps(cfg, log);
  const pre = await runPreflight(deps);
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
  // every send first proves this worker still holds the lease
  deps.sender.setFence(() => runner.fence());

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
