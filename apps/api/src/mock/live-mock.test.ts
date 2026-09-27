// The live mock (pnpm mock:api): same contract as the real API, and it actually moves.
import { EventsResponseSchema, HealthResponseSchema, type RatEvent, RatsResponseSchema, StateResponseSchema } from '@rat/contract';
import { FakeClock, SeededRng } from '@rat/core';
import { describe, expect, it } from 'vitest';
import { createApp } from '../app';
import { LiveMock } from './live-mock';

function setup(seed = 7) {
  const clock = new FakeClock('2026-10-05T09:00:00Z');
  const mock = new LiveMock({ clock, rng: new SeededRng(seed) });
  const app = createApp({ service: mock, clock, cacheSec: 0, corsOrigin: '*', rateLimitPerMinute: 100_000 });
  const get = async (path: string) => (await app.request(path)).json() as Promise<unknown>;
  return { clock, mock, get };
}

async function allEvents(get: (p: string) => Promise<unknown>): Promise<RatEvent[]> {
  return EventsResponseSchema.parse(await get('/api/events?afterId=0&limit=500')).events;
}

describe('live mock API', () => {
  it('serves all 4 endpoints with the exact contract (strict schemas), before and after 10 minutes', async () => {
    const { clock, get } = setup();
    for (let round = 0; round < 2; round++) {
      const state = StateResponseSchema.parse(await get('/api/state'));
      expect(state.schemaVersion).toBe(1);
      RatsResponseSchema.parse(await get('/api/rats'));
      EventsResponseSchema.parse(await get('/api/events?afterId=0&limit=500'));
      HealthResponseSchema.parse(await get('/health'));
      clock.advanceSeconds(600);
    }
  });

  it('starts from the mock files with timestamps moved to now', async () => {
    const { clock, get } = setup();
    const state = StateResponseSchema.parse(await get('/api/state'));
    expect(state.portfolio.ratCount).toBe(250);
    expect(Date.parse(state.events[0]!.at)).toBeLessThanOrEqual(clock.now().getTime());
    expect(clock.now().getTime() - Date.parse(state.events[0]!.at)).toBeLessThan(120_000);
  });

  it('hires a rat every few seconds, with the next ids and a fresh wallet each', async () => {
    const { clock, get } = setup();
    const before = RatsResponseSchema.parse(await get('/api/rats'));
    clock.advanceSeconds(60);
    const after = RatsResponseSchema.parse(await get('/api/rats'));
    const added = after.total - before.total;
    expect(added).toBeGreaterThanOrEqual(10);
    expect(added).toBeLessThanOrEqual(30);
    const fresh = RatsResponseSchema.parse(await get(`/api/rats?afterId=${before.total}`)).rats;
    expect(fresh.map((r) => r.id)).toEqual(Array.from({ length: added }, (_, i) => before.total + 1 + i));
    for (const r of fresh) {
      expect(r.wallet).toMatch(/^[1-9A-HJ-NP-Za-km-z]{44}$/);
      expect(r.costUsd).toBeCloseTo(4.91, 2); // 0.0265 SOL swapped at 185.4 USD
    }
    const hires = (await allEvents(get)).filter((e) => e.type === 'hire' && e.id > 5061);
    expect(hires.length).toBe(added);
  });

  it('prices drift, so ranks and tiers change', async () => {
    const { clock, get } = setup();
    const r0 = RatsResponseSchema.parse(await get('/api/rats')).rats;
    const p0 = StateResponseSchema.parse(await get('/api/state')).stocks.map((s) => s.priceUsd);
    clock.advanceSeconds(300);
    const r1 = RatsResponseSchema.parse(await get('/api/rats')).rats;
    const p1 = StateResponseSchema.parse(await get('/api/state')).stocks.map((s) => s.priceUsd);
    expect(p1.filter((p, i) => p !== p0[i]).length).toBeGreaterThanOrEqual(8);
    const tier0 = new Map(r0.map((r) => [r.id, r.tier]));
    const changedTier = r1.filter((r) => tier0.has(r.id) && tier0.get(r.id) !== r.tier).length;
    expect(changedTier).toBeGreaterThan(20);
    const rank0 = new Map(r0.map((r) => [r.id, r.rank]));
    expect(r1.filter((r) => rank0.has(r.id) && rank0.get(r.id) !== r.rank).length).toBeGreaterThan(100);
  });

  it('burns every minute in chunks of at most 1 SOL a few seconds apart; claims split 50/50', async () => {
    const { clock, get } = setup();
    const t0 = StateResponseSchema.parse(await get('/api/state')).treasury;
    for (let i = 0; i < 18; i++) {
      clock.advanceSeconds(10);
      await get('/health');
    }
    const t1 = StateResponseSchema.parse(await get('/api/state')).treasury;
    const events = (await allEvents(get)).filter((e) => e.id > 5061);
    const burns = events.filter((e): e is Extract<RatEvent, { type: 'burn' }> => e.type === 'burn');
    const claims = events.filter((e): e is Extract<RatEvent, { type: 'claim' }> => e.type === 'claim');
    expect(burns.length).toBeGreaterThanOrEqual(3);
    for (const b of burns) expect(b.data.solSpent).toBeLessThanOrEqual(1);
    expect(t1.burnCount - t0.burnCount).toBe(burns.length);
    expect(claims.length).toBeGreaterThanOrEqual(4);
    for (const c of claims) expect(c.data.toHiresSol).toBe(c.data.toFundSol);
    expect(t1.totalClaimedSol).toBeGreaterThan(t0.totalClaimedSol);
  });

  it('one stock pauses (its rats freeze) and resumes (they unfreeze), with events', async () => {
    const { clock, get } = setup();
    const statusAt = async () => {
      const s = StateResponseSchema.parse(await get('/api/state'));
      return { status: s.stocks.find((x) => x.symbol === 'COINx')!.status, frozen: s.portfolio.frozenCount };
    };
    expect(await statusAt()).toMatchObject({ status: 'paused' });
    clock.advanceSeconds(45);
    const resumed = await statusAt();
    expect(resumed).toEqual({ status: 'active', frozen: 0 });
    clock.advanceSeconds(90);
    const pausedAgain = await statusAt();
    expect(pausedAgain.status).toBe('paused');
    expect(pausedAgain.frozen).toBeGreaterThan(20);
    const types = (await allEvents(get)).filter((e) => e.id > 5061 && (e.type === 'freeze' || e.type === 'unfreeze'));
    expect(types.map((e) => e.type)).toEqual(['unfreeze', 'freeze']);
    const state = StateResponseSchema.parse(await get('/api/state'));
    expect(state.stocks.find((x) => x.symbol === 'COINx')!.hireWeightPct).toBe(0);
  });

  it('events: afterId paging returns only newer events, oldest first', async () => {
    const { clock, get } = setup();
    clock.advanceSeconds(120);
    const first = EventsResponseSchema.parse(await get('/api/events?afterId=5061&limit=5'));
    expect(first.events.map((e) => e.id)).toEqual([5062, 5063, 5064, 5065, 5066]);
    expect(first.lastId).toBe(5066);
    const next = EventsResponseSchema.parse(await get(`/api/events?afterId=${first.lastId}&limit=5`));
    expect(next.events[0]!.id).toBe(5067);
  });
});
