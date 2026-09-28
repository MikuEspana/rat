import { EventsResponseSchema, RatsResponseSchema, StateResponseSchema, type RatEvent } from '@rat/contract';
import { describe, expect, it } from 'vitest';
import { STAGES } from '../floor/plan';
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
  for (const id of ['normal', 'mega', 'rug'] as const) {
    it(`${id}: runs the backend rules (split, per-loop limit, hourly caps, burn chunks and rounds)`, () => {
      const { sim, events } = get(id);
      const st = sim.stateResponse();
      const hires = events.filter((e) => e.type === 'hire');
      const burns = events.filter((e) => e.type === 'burn');
      const claims = events.filter((e) => e.type === 'claim');
      const t = (e: RatEvent): number => Date.parse(e.at) - EPOCH;

      // 50/50 split of every claim
      for (const c of claims) if (c.type === 'claim') expect(Math.abs(c.data.toHiresSol - c.data.toFundSol)).toBeLessThanOrEqual(2e-6);
      // never spends more than was claimed into each bucket
      expect(hires.length * RULES.salarySol).toBeLessThanOrEqual(st.treasury.totalToHiresSol + 1e-6);
      expect(st.treasury.totalBurnSpentSol).toBeLessThanOrEqual(st.treasury.totalToFundSol + 1e-6);
      // at most 10 hires per 35 s loop
      const perLoop = new Map<number, number>();
      for (const h of hires) perLoop.set(Math.floor(t(h) / 35_000), (perLoop.get(Math.floor(t(h) / 35_000)) ?? 0) + 1);
      expect(Math.max(0, ...perLoop.values())).toBeLessThanOrEqual(RULES.maxHiresPerLoop);
      // hourly hire cap, counted at the loop that reserved the salary
      const loops = hires.map((h) => Math.floor(t(h) / 35_000) * 35_000);
      for (let a = 0, b = 0; b < loops.length; b++) {
        while (loops[a]! <= loops[b]! - 3_600_000) a++;
        expect((b - a + 1) * RULES.salarySol).toBeLessThanOrEqual(RULES.capHireSolPerHour + 1e-6);
      }
      // burns: chunks of at most 1 SOL; rounds of at most 5 SOL, 8 to 12 minutes apart
      const rounds: Array<{ at: number; sol: number }> = [];
      for (const b of burns) {
        if (b.type !== 'burn') continue;
        expect(b.data.solSpent).toBeLessThanOrEqual(RULES.burnChunkMaxSol + 1e-9);
        const last = rounds[rounds.length - 1];
        if (last && t(b) - last.at < 120_000) last.sol += b.data.solSpent;
        else rounds.push({ at: t(b), sol: b.data.solSpent });
      }
      for (const r of rounds) expect(r.sol).toBeLessThanOrEqual(RULES.burnRoundMaxSol + 1e-6);
      for (let k = 1; k < rounds.length; k++) expect(rounds[k]!.at - rounds[k - 1]!.at).toBeGreaterThanOrEqual(RULES.burnMinSec * 1000 - 1);
      // events carry no transaction: nothing was sent
      for (const e of events) expect(e.txSig).toBeNull();
      const s = sim.stats();
      console.log(
        `${id}: ${s.rats} rats (${stageOf(s.rats)}), fees ${s.feesSol.toFixed(1)} SOL, claimed ${s.claimedSol.toFixed(1)}, burned ${s.burnSpentSol.toFixed(1)} SOL in ${s.burnCount} chunks, waiting hire ${s.hireWaitingSol.toFixed(1)} burn ${s.burnWaitingSol.toFixed(1)}`,
      );
    });
  }

  it('normal: pumps to about $1.8M in about 3 hours and ends in the megacorp stage, short of the evil empire', () => {
    const { sim, peak, mcapAt } = get('normal');
    expect(peak).toBeGreaterThan(1_500_000);
    expect(peak).toBeLessThan(2_300_000);
    expect(mcapAt(180)).toBeGreaterThan(mcapAt(360));
    expect(stageOf(sim.stats().rats)).toBe('MEGACORP');
  });

  it('mega: runs to about $10M and reaches the evil empire', () => {
    const { sim, peak } = get('mega');
    expect(peak).toBeGreaterThan(8_000_000);
    expect(stageOf(sim.stats().rats)).toBe('EVIL EMPIRE');
  });

  it('rug: pumps to about $300K, then loses about 80%', () => {
    const { sim, peak, mcapAt } = get('rug');
    expect(peak).toBeGreaterThan(240_000);
    expect(peak).toBeLessThan(400_000);
    expect(mcapAt(70)).toBeLessThan(peak * 0.3);
    expect(sim.stats().rats).toBeLessThan(1500);
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
