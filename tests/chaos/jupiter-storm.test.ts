// D. Jupiter answers every call with 429 for 20 minutes in the middle of a launch (live, SimChain).
// Claims must keep flowing, nothing that needs a Jupiter build is sent, the worker must not hammer Jupiter,
// everything resumes afterwards, and every lamport is accounted for. Runs in the `chaos` CI job.
import { SOL, createSimWorld, createWorker } from '@rat/worker';
import { describe, expect, it } from 'vitest';
import { checkMoney, launchCurve, moneyStart } from '../e2e/helpers';
import { Chaos } from './chaos';

const STEP = 35;
const MIN = 60 / STEP;

describe('D. Jupiter 429 storm', () => {
  it('20 minutes of 429s: claims continue, no hire or burn is sent, no retry storm, full recovery, money exact', async () => {
    const w = await createSimWorld({ dryRun: false, seed: 5 });
    try {
      const start = moneyStart(w);
      const chaos = new Chaos();
      const worker = createWorker(w.rebuildDeps(chaos.parts(w)));
      const total = 20n * SOL;
      const curve = launchCurve(total, 45 * 60, STEP);
      start.accrued = total;
      const attempts = async (kinds: string[]) =>
        (await w.store.db.query.txAttempts.findMany({ where: (a, { eq }) => eq(a.mode, 'live') })).filter((a) => kinds.includes(a.kind)).length;

      let before = { spend: 0, claims: 0, jupiter: 0 };
      for (let i = 0; i < curve.length; i++) {
        const minute = (i * STEP) / 60;
        if (minute >= 5 && !chaos.down.has('jupiter') && minute < 25) {
          chaos.down.add('jupiter');
          before = { spend: await attempts(['hire', 'burn']), claims: await attempts(['claim']), jupiter: chaos.counts.jupiter };
        }
        if (minute >= 25 && chaos.down.has('jupiter')) {
          chaos.down.delete('jupiter');
          // during the storm: claims kept going, nothing that needs a Jupiter build was sent
          expect(await attempts(['claim'])).toBeGreaterThan(before.claims);
          expect(await attempts(['hire', 'burn'])).toBe(before.spend);
          // no retry storm: well under the 55 requests/minute plan limit on average
          expect((chaos.counts.jupiter - before.jupiter) / 20).toBeLessThan(30);
        }
        w.accrue({ bondingLamports: curve[i]! });
        await worker.tick();
        w.clock.advanceSeconds(STEP);
        w.chain.advanceBlocks(90);
        w.prices.step(w.rng);
      }
      // settle: 20 more minutes without new fees
      for (let i = 0; i < 20 * MIN; i++) {
        await worker.tick();
        w.clock.advanceSeconds(STEP);
        w.chain.advanceBlocks(90);
        w.prices.step(w.rng);
      }
      expect(await attempts(['hire', 'burn'])).toBeGreaterThan(before.spend); // recovered
      expect((await w.store.burns.listByStatus(['confirmed'])).length).toBeGreaterThan(0);
      expect(w.alerts.keys().some((k) => ['burn_no_route', 'no_eligible_stocks', 'hire_idle'].includes(k))).toBe(true);
      await checkMoney(w, start);
      // the budget was used after the storm: less than one salary of hire budget is left idle
      expect(await w.store.ledger.balance('hire')).toBeLessThan(w.deps.config.salaryLamports * BigInt(w.deps.config.maxHiresPerLoop));
    } finally {
      await w.close();
    }
  }, 600_000);
});
