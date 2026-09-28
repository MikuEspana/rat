// Chaos scenarios (in-memory only, SimChain in live mode), shared by the chaos test files:
//   A. the worker is killed right before EVERY single operation (database write/read, RPC call, Jupiter call) of a
//      hire; a restarted worker (fresh process state, same database and chain) must finish the job with every
//      lamport accounted for
//   B. the RPC goes down from every RPC call of a hire on, then comes back
//   C. the database drops from every database call of a hire on (mid-transaction), then comes back
//   D. Jupiter 429 storm in the middle of a launch
// Hires are the only spending (every claimed lamport hires rats), so they are the step these scenarios break.
import { SOL, type SimWorld, createSimWorld, createWorker, runClaimStep, runHireStep, runMintStep, runPriceStep, runWatchStep } from '@rat/worker';
import { expect } from 'vitest';
import { Chaos, type OpKind } from './chaos';
import { type MoneyStart, checkMoney, moneyStart } from '../e2e/money-check';

export type HireMode = 'single' | 'two_step';
export type StepName = 'hire';
/** Loops (35 s) after the chaos. */
const LOOPS_AFTER = 8;
/** `drop`: the step's first transaction never lands (its blockhash expires), so the release path runs too. */
export type Variant = 'clean' | 'drop';

async function funded(mode: HireMode): Promise<{ w: SimWorld; start: MoneyStart }> {
  const w = await createSimWorld({ dryRun: false, seed: 11, env: { HIRE_MODE: mode, MAX_HIRES_PER_LOOP: '1' } });
  const start = moneyStart(w);
  await runPriceStep(w.deps, w.worker.state);
  await runMintStep(w.deps);
  await runWatchStep(w.deps);
  w.accrue({ bondingLamports: SOL / 5n });
  start.accrued = SOL / 5n;
  expect((await runClaimStep(w.deps, w.worker.state)).status).toBe('claimed');
  return { w, start };
}

/** A fresh worker process on the same database and chain runs `loops` loops (35 s each). */
async function restartAndRun(w: SimWorld, loops: number): Promise<void> {
  const worker = createWorker(w.rebuildDeps());
  for (let i = 0; i < loops; i++) {
    await worker.tick();
    w.clock.advanceSeconds(35);
    w.chain.advanceBlocks(90);
    w.prices.step(w.rng);
  }
}

function runStep(_step: StepName, w: SimWorld, chaos: Chaos): Promise<unknown> {
  return runHireStep(w.rebuildDeps(chaos.parts(w)), w.worker.state);
}

async function expectFinished(w: SimWorld): Promise<void> {
  expect(await w.store.rats.listByStatus(['hiring']), 'no rat left half hired').toEqual([]);
  expect((await w.store.rats.listByStatus(['active'])).length).toBeGreaterThan(0);
}

/** Runs the step with chaos, then a restarted worker; returns the operations the step made (or reached). */
export async function scenario(
  mode: HireMode,
  step: StepName,
  setup: (c: Chaos) => void,
  after: 'restart' | 'same_process',
  variant: Variant = 'clean',
): Promise<{ ops: { kind: OpKind; name: string }[] }> {
  const { w, start } = await funded(mode);
  try {
    if (variant === 'drop') w.simSender.failNext('drop', step);
    const chaos = new Chaos();
    setup(chaos);
    const run = runStep(step, w, chaos).catch(() => undefined);
    await Promise.race([run, chaos.died]);
    w.simSender.clearFailures(); // an injected drop is meant for the step's own first tx only
    if (after === 'same_process') {
      // the outage ends; the same process keeps going (the scheduler caught the error)
      chaos.failing = null;
      chaos.down.clear();
      const worker = createWorker(w.rebuildDeps(chaos.parts(w)));
      for (let i = 0; i < LOOPS_AFTER; i++) {
        await worker.tick();
        w.clock.advanceSeconds(35);
        w.chain.advanceBlocks(90);
        w.prices.step(w.rng);
      }
    } else {
      await restartAndRun(w, LOOPS_AFTER);
    }
    await checkMoney(w, start);
    await expectFinished(w);
    return { ops: chaos.ops };
  } finally {
    await w.close();
  }
}

/** Runs `scenario` once per point, collecting every failure (so one run shows all broken points). */
export async function everyPoint(points: number, label: (k: number) => string, run: (k: number) => Promise<unknown>): Promise<void> {
  const failures: string[] = [];
  for (let k = 1; k <= points; k++) {
    try {
      await run(k);
    } catch (err) {
      failures.push(`${label(k)}: ${(err as Error).message.split('\n')[0]}`);
    }
  }
  expect(failures).toEqual([]);
}

export async function opsOf(mode: HireMode, step: StepName, variant: Variant = 'clean') {
  return (await scenario(mode, step, () => {}, 'restart', variant)).ops;
}

export const MATRIX = [
  ['single', 'hire', 'clean'],
  ['single', 'hire', 'drop'],
  ['two_step', 'hire', 'clean'],
] as const;

