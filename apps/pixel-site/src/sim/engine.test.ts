import { EventsResponseSchema, RatsResponseSchema, StateResponseSchema, type RatEvent } from '@rat/contract';
import { describe, expect, it } from 'vitest';
import { Growth } from '../floor/growth';
import { buildMaster, PLAN_RATS, STAGES } from '../floor/plan';
import { LaunchSim } from './engine';
import { RULES } from './rules';
import { SCENARIOS, type ScenarioId } from './scenarios';

const EPOCH = Date.parse('2026-10-01T12:00:00Z');

function stageOf(rats: number): string {
  let s = STAGES[0]!.name;
  for (const st of STAGES) if (rats >= st.min) s = st.name;
  return s;
}

/** Runs a scenario to its end, checking the contract shapes along the way. */
function run(id: ScenarioId): { sim: LaunchSim; events: RatEvent[]; peak: number; mcapAt: (min: number) => number } {
  const sim = new LaunchSim(SCENARIOS[id], EPOCH);
  const pre = sim.stateResponse();
  expect(StateResponseSchema.parse(pre).coin.marketCapUsd).toBeNull();
  sim.launch();
  const events: RatEvent[] = [];
  let cursor = 0;
  let peak = 0;
  const mcaps = new Map<number, number>();
  for (let min = 1; min <= SCENARIOS[id].minutes; min++) {
    sim.advanceTo(min * 60_000);
    const res = sim.eventsResponse(cursor, 100_000);
    events.push(...res.events);
    cursor = res.lastId;
    const s = sim.stats();
    peak = Math.max(peak, s.mcap ?? 0);
    mcaps.set(min, s.mcap ?? 0);
    if (min % 60 === 0) {
      StateResponseSchema.parse(sim.stateResponse());
      EventsResponseSchema.parse(res);
    }
  }
  RatsResponseSchema.parse(sim.ratsResponse());
  return { sim, events, peak, mcapAt: (m) => mcaps.get(m) ?? 0 };
}

const results = new Map<ScenarioId, ReturnType<typeof run>>();
const get = (id: ScenarioId): ReturnType<typeof run> => {
  if (!results.has(id)) results.set(id, run(id));
  return results.get(id)!;
};

describe('launch simulator', () => {
  for (const id of ['normal', 'mega', 'rush', 'rug'] as const) {
    it(`${id}: runs the backend rules (every claim to hires, per-loop limit, hourly cap)`, () => {
      const { sim, events } = get(id);
      const st = sim.stateResponse();
      const hires = events.filter((e) => e.type === 'hire');
      const claims = events.filter((e) => e.type === 'claim');
      const t = (e: RatEvent): number => Date.parse(e.at) - EPOCH;

      // only claims and hires: nothing is bought back or burned
      expect(events.every((e) => e.type === 'claim' || e.type === 'hire')).toBe(true);
      // every claimed SOL goes to hires: spent on hires plus still waiting is exactly what was claimed
      const claimed = claims.reduce((a, c) => a + (c.type === 'claim' ? c.data.amountSol : 0), 0);
      expect(Math.abs(claimed - st.treasury.totalClaimedSol)).toBeLessThanOrEqual(1e-4);
      expect(Math.abs(st.treasury.totalHiredSol + st.treasury.waitingSol - st.treasury.totalClaimedSol)).toBeLessThanOrEqual(1e-4);
      // never spends more than was claimed (hired counts salaries when reserved, so the last loop's hires may still be on their way)
      expect(st.treasury.totalHiredSol).toBeLessThanOrEqual(st.treasury.totalClaimedSol + 1e-6);
      expect(st.treasury.totalHiredSol).toBeGreaterThanOrEqual(hires.length * RULES.salarySol - 1e-6);
      expect(st.treasury.totalHiredSol).toBeLessThanOrEqual((hires.length + RULES.maxHiresPerLoop) * RULES.salarySol + 1e-6);
      // at most 20 hires per 35 s loop
      const perLoop = new Map<number, number>();
      for (const h of hires) perLoop.set(Math.floor(t(h) / 35_000), (perLoop.get(Math.floor(t(h) / 35_000)) ?? 0) + 1);
      expect(Math.max(0, ...perLoop.values())).toBeLessThanOrEqual(RULES.maxHiresPerLoop);
      // hourly hire cap, counted at the loop that reserved the salary
      const loops = hires.map((h) => Math.floor(t(h) / 35_000) * 35_000);
      let maxHour = 0;
      for (let a = 0, b = 0; b < loops.length; b++) {
        while (loops[a]! <= loops[b]! - 3_600_000) a++;
        maxHour = Math.max(maxHour, (b - a + 1) * RULES.salarySol);
        expect((b - a + 1) * RULES.salarySol).toBeLessThanOrEqual(RULES.capHireSolPerHour + 1e-6);
      }
      // never more than 40 Jupiter calls (prices + builds) in any minute
      expect(sim.stats().jupiterMaxPerMin).toBeLessThanOrEqual(RULES.jupiterPerMin);
      // events carry no transaction: nothing was sent
      for (const e of events) expect(e.txSig).toBeNull();
      const s = sim.stats();
      console.log(
        `${id}: ${s.rats} rats (${stageOf(s.rats)}), fees ${s.feesSol.toFixed(1)} SOL, claimed ${s.claimedSol.toFixed(1)}, hired ${s.hiredSol.toFixed(1)}, waiting ${s.hireWaitingSol.toFixed(1)}, portfolio $${Math.round(s.portfolioValueUsd)}, max ${maxHour.toFixed(2)} SOL in an hour, max ${Math.max(0, ...perLoop.values())} per loop`,
      );
    });
  }

  it('normal: pumps to about $1.8M in about 3 hours, then cools off; every fee hires, so it reaches Wall Street', () => {
    const { sim, peak, mcapAt } = get('normal');
    expect(peak).toBeGreaterThan(1_500_000);
    expect(peak).toBeLessThan(2_300_000);
    expect(mcapAt(180)).toBeGreaterThan(mcapAt(360));
    expect(stageOf(sim.stats().rats)).toBe('WALL STREET');
    expect(sim.stats().rats).toBeLessThanOrEqual(PLAN_RATS); // everyone gets a desk, no line outside
  });

  it('mega: runs to about $10M; the building fills up and the rest line up outside', () => {
    const { sim, peak } = get('mega');
    const s = sim.stats();
    expect(peak).toBeGreaterThan(8_000_000);
    expect(stageOf(s.rats)).toBe('WALL STREET');
    // replay the roster through the site's idle game: every desk taken, a few hundred in the job-fair line
    const growth = new Growth(buildMaster());
    for (const r of sim.ratsResponse().rats) growth.add(r.id, r.stock);
    expect(growth.waitingCount).toBeGreaterThan(100);
    expect(growth.waitingCount).toBeLessThan(1500);
    console.log(`mega: ${growth.waitingCount} rats in the job-fair line at the end`);
  });

  it('a bigger run hits the limits (60 SOL/h, 40 Jupiter calls a minute): the rest of the fees wait and are spent later', () => {
    const big = { ...SCENARIOS.mega, curve: SCENARIOS.mega.curve.map(([m, v]) => [m, v * 3] as const), minutes: 150 };
    const sim = new LaunchSim(big, EPOCH);
    sim.launch();
    let maxWaiting = 0;
    for (let min = 1; min <= big.minutes; min++) {
      sim.advanceTo(min * 60_000);
      maxWaiting = Math.max(maxWaiting, sim.stats().hireWaitingSol);
    }
    const hires = sim.eventsResponse(0, 1_000_000).events.filter((e) => e.type === 'hire');
    const t = (e: RatEvent): number => Math.floor((Date.parse(e.at) - EPOCH) / 35_000) * 35_000;
    let maxHour = 0;
    for (let a = 0, b = 0; b < hires.length; b++) {
      while (t(hires[a]!) <= t(hires[b]!) - 3_600_000) a++;
      maxHour = Math.max(maxHour, (b - a + 1) * RULES.salarySol);
    }
    expect(maxHour).toBeLessThanOrEqual(RULES.capHireSolPerHour + 1e-6);
    // two 20-hire loops can fall inside one minute, so the 40-call Jupiter budget binds a little before the cap
    expect(maxHour).toBeGreaterThan(55);
    expect(sim.stats().jupiterMaxPerMin).toBeLessThanOrEqual(RULES.jupiterPerMin);
    expect(maxWaiting).toBeGreaterThan(5);
  });

  it('rush: the backend\'s 3-hour launch (180 SOL of fees): the line of waiting hires swells past 1,000, then every fee is spent', () => {
    const { sim } = get('rush');
    const s = sim.stats();
    expect(s.feesSol).toBeGreaterThan(178);
    expect(s.feesSol).toBeLessThan(181);
    // most of it waits in the job-fair line during the rush (applicants: claimed SOL not hired yet)
    let peak = 0;
    const probe = new LaunchSim(SCENARIOS.rush, EPOCH);
    probe.launch();
    for (let min = 1; min <= SCENARIOS.rush.minutes; min++) {
      probe.advanceTo(min * 60_000);
      peak = Math.max(peak, probe.stats().hireWaitingSol);
    }
    expect(peak / RULES.salarySol).toBeGreaterThan(1000);
    // and all of it hires rats by the end
    expect(s.hireWaitingSol).toBeLessThan(RULES.salarySol);
    expect(s.rats).toBeGreaterThan(5_900);
    console.log(`rush: peak ${Math.round(peak / RULES.salarySol)} rats waiting in line, ${s.rats} rats at the end`);
  });

  it('rug: pumps to about $300K, then loses about 80%', () => {
    const { sim, peak, mcapAt } = get('rug');
    expect(peak).toBeGreaterThan(240_000);
    expect(peak).toBeLessThan(400_000);
    expect(mcapAt(70)).toBeLessThan(peak * 0.3);
    expect(sim.stats().rats).toBeLessThan(1500);
  });

  it('every fee hires rats: the portfolio is worth about what they paid for their stocks', () => {
    const s = get('normal').sim.stats();
    expect(s.portfolioValueUsd).toBeGreaterThan(s.rats * 4);
  });

  it('is deterministic for a scenario', () => {
    const a = new LaunchSim(SCENARIOS.normal, EPOCH);
    const b = new LaunchSim(SCENARIOS.normal, EPOCH);
    a.launch();
    b.launch();
    a.advanceTo(90 * 60_000);
    b.advanceTo(90 * 60_000);
    expect(a.stats()).toEqual(b.stats());
  });
});
