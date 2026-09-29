// Property tests (fast-check): random sequences of claims, fees, spends, settles, releases, time jumps and kill
// switch flips against the REAL SpendGuard and the REAL database ledger, compared with a tiny independent model.
// Invariant: SOL spent never exceeds SOL claimed, to the lamport. Every spend is granted only when the claimed
// SOL left in the hire bucket covers it, the rolling-hour hire cap holds, the kill switch is off, and the ledger balance
// always equals the exact sum of what was booked.
import { type Bucket, FakeClock, type KillSwitch } from '@rat/core';
import { type DbHandle, Store, openMemoryDatabase } from '@rat/db';
import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RecordingAlerts } from './alerts';
import { type Reservation, SpendGuard } from './spend-guard';

const SOL = 1_000_000_000n;
const HOUR_MS = 3_600_000;

let handle: DbHandle;
beforeAll(async () => {
  handle = await openMemoryDatabase();
});
afterAll(async () => handle.close());

type Cmd =
  | { t: 'credit'; bucket: Bucket; lamports: bigint }
  | { t: 'fee'; lamports: bigint }
  | { t: 'authorize'; bucket: Bucket; lamports: bigint; parallel: number }
  | { t: 'settle'; pick: number; pct: number }
  | { t: 'release'; pick: number }
  /** settle or release an ALREADY closed reservation again (a retry after a crash): must book nothing */
  | { t: 'reclose'; pick: number; settle: boolean; pct: number }
  | { t: 'advance'; seconds: number }
  | { t: 'kill'; on: boolean };

// every claimed lamport hires rats: the hire bucket is the only one
const bucket = fc.constant<Bucket>('hire');
const lamports = (max: bigint) => fc.bigInt({ min: 0n, max });

/** Amount ranges. The tiny scale makes random scenarios land exactly on the cap boundaries (off-by-one checks). */
interface Scale {
  credit: bigint;
  fee: bigint;
  spend: bigint;
  cap: bigint;
  smokeCap: bigint;
}
const SOL_SCALE: Scale = { credit: 2n * SOL, fee: 100_000n, spend: (3n * SOL) / 2n, cap: SOL, smokeCap: SOL / 10n };
const TINY_SCALE: Scale = { credit: 20n, fee: 3n, spend: 14n, cap: 12n, smokeCap: 10n };

const cmdArb = (x: Scale): fc.Arbitrary<Cmd> =>
  fc.oneof(
    { weight: 3, arbitrary: fc.record({ t: fc.constant('credit' as const), bucket, lamports: lamports(x.credit) }) },
    { weight: 1, arbitrary: fc.record({ t: fc.constant('fee' as const), lamports: lamports(x.fee) }) },
    { weight: 5, arbitrary: fc.record({ t: fc.constant('authorize' as const), bucket, lamports: fc.bigInt({ min: -1n, max: x.spend }), parallel: fc.integer({ min: 1, max: 4 }) }) },
    { weight: 2, arbitrary: fc.record({ t: fc.constant('settle' as const), pick: fc.nat(), pct: fc.integer({ min: 0, max: 100 }) }) },
    { weight: 1, arbitrary: fc.record({ t: fc.constant('release' as const), pick: fc.nat() }) },
    { weight: 1, arbitrary: fc.record({ t: fc.constant('reclose' as const), pick: fc.nat(), settle: fc.boolean(), pct: fc.integer({ min: 0, max: 150 }) }) },
    { weight: 1, arbitrary: fc.record({ t: fc.constant('advance' as const), seconds: fc.integer({ min: 1, max: 5_400 }) }) },
    { weight: 1, arbitrary: fc.record({ t: fc.constant('kill' as const), on: fc.boolean() }) },
  );

/** The independent model: a list of booked deltas with their time. */
class Model {
  /** spend = reserve/settle/release (counts toward the hourly cap); fee = claim fee (counts toward the smoke cap only) */
  entries: { bucket: Bucket; delta: bigint; spend: boolean; fee?: boolean; at: number }[] = [];
  balance(b: Bucket) {
    return this.entries.filter((e) => e.bucket === b).reduce((s, e) => s + e.delta, 0n);
  }
  outflowSince(b: Bucket, since: number) {
    return -this.entries.filter((e) => e.bucket === b && e.spend && e.at >= since).reduce((s, e) => s + e.delta, 0n);
  }
  /** net hire spend since the start, claim fees included (what the smoke cap limits) */
  lifetime() {
    return -this.entries.filter((e) => e.spend || e.fee).reduce((s, e) => s + e.delta, 0n);
  }
  spent() {
    return -this.entries.filter((e) => e.spend).reduce((s, e) => s + e.delta, 0n);
  }
}

async function runScenario(cmds: Cmd[], smokeMode: boolean, x: Scale): Promise<void> {
  const CAP = x.cap;
  const SMOKE_CAP = x.smokeCap;
  await handle.db.execute('delete from ledger_entries');
  const clock = new FakeClock('2026-10-01T12:00:00Z');
  const store = new Store(handle.db, 'live', clock);
  let killOn = false;
  const killSwitch: KillSwitch = { status: async () => ({ on: killOn, reason: killOn ? 'test' : null }) };
  const guard = new SpendGuard(
    { ledger: store.ledger, killSwitch, alerts: new RecordingAlerts(), clock },
    {
      capPerHour: { hire: CAP },
      alertPct: 50,
      wallets: { hire: undefined },
      reserves: { hire: 0n },
      smokeMode,
      smokeCap: SMOKE_CAP,
      checkWallets: false,
    },
  );
  const m = new Model();
  /** a settle or release counts toward the hourly cap at the time of the reservation it closes */
  const reservedAt = new Map<number, number>();
  const open: Reservation[] = [];
  const closed: Reservation[] = [];
  let credited = 0n;
  let fees = 0n;

  for (const c of cmds) {
    const now = clock.now().getTime();
    switch (c.t) {
      case 'credit':
        await store.ledger.append({ bucket: c.bucket, deltaLamports: c.lamports, reason: 'claim_credit' });
        m.entries.push({ bucket: c.bucket, delta: c.lamports, spend: false, at: now });
        credited += c.lamports;
        break;
      case 'fee':
        await store.ledger.append({ bucket: 'hire', deltaLamports: -c.lamports, reason: 'claim_fee' });
        m.entries.push({ bucket: 'hire', delta: -c.lamports, spend: false, fee: true, at: now });
        fees += c.lamports;
        break;
      case 'authorize': {
        // `parallel` identical requests at once: the guard must grant them as if they came one by one
        const reqs = Array.from({ length: c.parallel }, (_, i) => ({ bucket: c.bucket, lamports: c.lamports, refType: 'test', refId: `${now}-${i}` }));
        const results = await Promise.all(reqs.map((r) => guard.authorize(r)));
        for (const r of results) {
          const before = m.balance(c.bucket);
          const expectOk =
            c.lamports > 0n &&
            !killOn &&
            before >= c.lamports &&
            m.outflowSince(c.bucket, now - HOUR_MS) + c.lamports <= CAP &&
            (!smokeMode || m.lifetime() + c.lamports <= SMOKE_CAP);
          expect(r.ok).toBe(expectOk);
          if (!r.ok) continue;
          // the invariant itself: claimed SOL left in the bucket covered this spend, to the lamport
          expect(before - c.lamports).toBeGreaterThanOrEqual(0n);
          m.entries.push({ bucket: c.bucket, delta: -c.lamports, spend: true, at: now });
          reservedAt.set(r.reservation.ledgerId, now);
          open.push(r.reservation);
          expect(m.outflowSince(c.bucket, now - HOUR_MS)).toBeLessThanOrEqual(CAP);
          if (smokeMode) expect(m.lifetime()).toBeLessThanOrEqual(SMOKE_CAP);
        }
        break;
      }
      case 'settle': {
        if (open.length === 0) break;
        const r = open.splice(c.pick % open.length, 1)[0]!;
        const actual = (r.lamports * BigInt(c.pct)) / 100n;
        await guard.settle(r, actual);
        if (actual !== r.lamports) m.entries.push({ bucket: r.bucket, delta: r.lamports - actual, spend: true, at: reservedAt.get(r.ledgerId)! });
        closed.push(r);
        break;
      }
      case 'release': {
        if (open.length === 0) break;
        const r = open.splice(c.pick % open.length, 1)[0]!;
        await guard.release(r, 'test');
        m.entries.push({ bucket: r.bucket, delta: r.lamports, spend: true, at: reservedAt.get(r.ledgerId)! });
        closed.push(r);
        break;
      }
      case 'reclose': {
        if (closed.length === 0) break;
        const r = closed[c.pick % closed.length]!;
        if (c.settle) await guard.settle(r, (r.lamports * BigInt(c.pct)) / 100n);
        else await guard.release(r, 'retry');
        break; // the model does not change: nothing may be booked
      }
      case 'advance':
        clock.advanceSeconds(c.seconds);
        break;
      case 'kill':
        killOn = c.on;
        break;
    }
    // the database ledger equals the model to the lamport, after every step
    const t = clock.now().getTime();
    expect(await store.ledger.balance('hire')).toBe(m.balance('hire'));
    expect(await store.ledger.netOutflowSince('hire', new Date(t - HOUR_MS))).toBe(m.outflowSince('hire', t - HOUR_MS));
  }
  // globally: hires (net of settles and releases) never spent more than was claimed. Claim fees are
  // booked too; a failed claim's fee is the only cost that can come from the creator's reserve.
  const spent = m.spent();
  expect(spent).toBeLessThanOrEqual(credited);
  expect(await store.ledger.lifetimeNetOutflow()).toBe(spent + fees);
}

describe('property: spend guard + ledger (fast-check)', () => {
  const run = (smokeMode: boolean, x: Scale, numRuns: number) =>
    fc.assert(fc.asyncProperty(fc.array(cmdArb(x), { minLength: 1, maxLength: 40 }), (cmds) => runScenario(cmds, smokeMode, x)), { numRuns });

  it('SOL spent never exceeds SOL claimed, caps hold, the ledger is exact (SOL amounts)', () => run(false, SOL_SCALE, 250), 120_000);
  it('same, with tiny lamport amounts so every boundary is hit exactly', () => run(false, TINY_SCALE, 250), 120_000);
  it('smoke mode: lifetime spend (fees included) never exceeds the smoke cap', () => run(true, TINY_SCALE, 150), 120_000);
});
