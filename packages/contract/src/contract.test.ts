import { describe, expect, it } from 'vitest';
import events from '../mock/events.json';
import rats from '../mock/rats.json';
import state from '../mock/state.json';
import {
  EventsResponseSchema,
  RatViewSchema,
  RatsResponseSchema,
  StateResponseSchema,
  computeRatView,
  leaderboard,
  rankRats,
  sizeScaleFor,
  summarizePortfolio,
  tierFor,
  type RatFacts,
  type RatView,
} from './index';

describe('mock files', () => {
  it('state.json validates', () => {
    const r = StateResponseSchema.safeParse(state);
    if (!r.success) console.error(r.error.issues.slice(0, 5));
    expect(r.success).toBe(true);
  });
  it('rats.json validates', () => {
    const r = RatsResponseSchema.safeParse(rats);
    if (!r.success) console.error(r.error.issues.slice(0, 5));
    expect(r.success).toBe(true);
    expect(rats.total).toBe(rats.rats.length);
  });
  it('events.json validates', () => {
    const r = EventsResponseSchema.safeParse(events);
    if (!r.success) console.error(r.error.issues.slice(0, 5));
    expect(r.success).toBe(true);
  });

  it('mock rats are consistent with the display math', () => {
    const prices = new Map(state.stocks.map((s) => [s.mint, s.priceUsd]));
    for (const rat of rats.rats as RatView[]) {
      const view = computeRatView({ ...rat }, prices.get(rat.stockMint)!);
      expect(Math.abs(view.valueUsd - rat.valueUsd)).toBeLessThanOrEqual(0.011);
      expect(Math.abs(view.pnlUsd - rat.pnlUsd)).toBeLessThanOrEqual(0.011);
      expect(rat.tier).toBe(tierFor(rat.pnlPct));
      expect(rat.sizeScale).toBe(sizeScaleFor(rat.pnlPct));
    }
    const ranked = rankRats((rats.rats as RatView[]).map(({ rank: _r, ...v }) => v));
    expect(ranked.map((r) => r.rank)).toEqual((rats.rats as RatView[]).map((r) => r.rank));
  });

  it('state aggregates match the rat list', () => {
    const p = summarizePortfolio(rats.rats as RatView[]);
    expect(p).toEqual(state.portfolio);
    const lb = leaderboard(rats.rats as RatView[]);
    expect(lb.top.map((r) => r.id)).toEqual(state.leaderboard.top.map((r) => r.id));
    expect(lb.bottom.map((r) => r.id)).toEqual(state.leaderboard.bottom.map((r) => r.id));
  });

  it('schemas reject unknown fields (nothing leaks)', () => {
    const rat = { ...(rats.rats[0] as RatView), secretKey: 'x' };
    expect(RatViewSchema.safeParse(rat).success).toBe(false);
  });
});

const baseRat: RatFacts = {
  id: 1,
  name: 'Inu #0001',
  wallet: '7xKpQm3vN8aLr2Tz9WcYh4sBd6FjE1uGkPoXqZyW5n',
  stock: 'TSLAx',
  stockMint: 'XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB',
  status: 'active',
  avatarSeed: 'a91f3c07',
  hiredAt: '2026-10-01T17:40:12Z',
  hireTx: 'sig',
  tokenAmount: '0.014139',
  costUsd: 5.41,
};

describe('display math', () => {
  it('computes value, pnl, tier and size', () => {
    const v = computeRatView(baseRat, 412.33);
    expect(v.valueUsd).toBe(5.83);
    expect(v.pnlUsd).toBe(0.42);
    expect(v.pnlPct).toBe(7.76);
    expect(v.tier).toBe('analyst');
    expect(v.sizeScale).toBe(1.08);
    expect(v.solscanUrl).toBe(`https://solscan.io/account/${baseRat.wallet}`);
  });

  it('tier boundaries', () => {
    expect(tierFor(-0.01)).toBe('intern');
    expect(tierFor(0)).toBe('analyst');
    expect(tierFor(9.99)).toBe('analyst');
    expect(tierFor(10)).toBe('associate');
    expect(tierFor(24.99)).toBe('associate');
    expect(tierFor(25)).toBe('vp');
    expect(tierFor(49.99)).toBe('vp');
    expect(tierFor(50)).toBe('partner');
    expect(tierFor(900)).toBe('partner');
  });

  it('size scale clamps to [0.5, 3]', () => {
    expect(sizeScaleFor(-90)).toBe(0.5);
    expect(sizeScaleFor(-50)).toBe(0.5);
    expect(sizeScaleFor(0)).toBe(1);
    expect(sizeScaleFor(150)).toBe(2.5);
    expect(sizeScaleFor(500)).toBe(3);
  });

  it('unpriced rats are valued at cost, zero-cost rats have 0%', () => {
    expect(computeRatView(baseRat, null).pnlPct).toBe(0);
    expect(computeRatView({ ...baseRat, costUsd: 0 }, 400).pnlPct).toBe(0);
  });

  it('frozen rats keep their value and status', () => {
    const v = computeRatView({ ...baseRat, status: 'frozen' }, 400);
    expect(v.status).toBe('frozen');
    expect(v.valueUsd).toBeGreaterThan(0);
  });

  it('rank ties break by hire time then id', () => {
    const a = computeRatView({ ...baseRat, id: 2, hiredAt: '2026-10-01T10:00:00Z' }, 412.33);
    const b = computeRatView({ ...baseRat, id: 3, hiredAt: '2026-10-01T09:00:00Z' }, 412.33);
    const c = computeRatView({ ...baseRat, id: 1, hiredAt: '2026-10-01T09:00:00Z' }, 412.33);
    const ranked = rankRats([a, b, c]);
    expect(ranked.map((r) => [r.id, r.rank])).toEqual([
      [1, 1],
      [2, 3],
      [3, 2],
    ]);
  });
});
