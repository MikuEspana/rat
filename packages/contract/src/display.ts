// Display math. Used by the API to build responses and by the site if it wants to
// recompute live numbers between polls. Everything here is display only.
import { solscanAccountUrl } from './urls';
import type { Portfolio, RatView, StockView, Tier } from './types';

export const TIERS: ReadonlyArray<{ name: Tier; minPct: number }> = [
  { name: 'partner', minPct: 50 },
  { name: 'vp', minPct: 25 },
  { name: 'associate', minPct: 10 },
  { name: 'analyst', minPct: 0 },
];

export const SIZE_SCALE_MIN = 0.5;
export const SIZE_SCALE_MAX = 3;

export function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/** Tier from the displayed (rounded) pnlPct. Below 0 is intern. */
export function tierFor(pnlPct: number): Tier {
  for (const t of TIERS) if (pnlPct >= t.minPct) return t.name;
  return 'intern';
}

/** clamp(1 + pnlPct/100, 0.5, 3), rounded to 2 decimals. */
export function sizeScaleFor(pnlPct: number): number {
  return round2(Math.min(SIZE_SCALE_MAX, Math.max(SIZE_SCALE_MIN, 1 + pnlPct / 100)));
}

/** Stored facts about one rat (no live price yet). */
export interface RatFacts {
  id: number;
  name: string;
  wallet: string;
  stock: string;
  stockMint: string;
  status: 'active' | 'frozen';
  avatarSeed: string;
  hiredAt: string;
  hireTx: string | null;
  /** UI amount, already scaled for stock splits */
  tokenAmount: string;
  costUsd: number;
}

export type UnrankedRatView = Omit<RatView, 'rank'>;

/**
 * Live view of one rat. `priceUsd` null (never priced) values the rat at cost.
 * pnlPct is rounded first; tier and size come from the rounded value.
 */
export function computeRatView(rat: RatFacts, priceUsd: number | null): UnrankedRatView {
  const cost = rat.costUsd;
  const valueRaw = priceUsd === null ? cost : Number(rat.tokenAmount) * priceUsd;
  const pnlRaw = valueRaw - cost;
  const pnlPct = cost > 0 ? round2((pnlRaw / cost) * 100) : 0;
  return {
    id: rat.id,
    name: rat.name,
    wallet: rat.wallet,
    solscanUrl: solscanAccountUrl(rat.wallet),
    stock: rat.stock,
    stockMint: rat.stockMint,
    status: rat.status,
    avatarSeed: rat.avatarSeed,
    hiredAt: rat.hiredAt,
    hireTx: rat.hireTx,
    tokenAmount: rat.tokenAmount,
    costUsd: round2(cost),
    valueUsd: round2(valueRaw),
    pnlUsd: round2(pnlRaw),
    pnlPct,
    tier: tierFor(pnlPct),
    sizeScale: sizeScaleFor(pnlPct),
  };
}

/** Ranks by pnlPct desc, ties: earlier hiredAt, then lower id. Returns views sorted by id. */
export function rankRats(views: UnrankedRatView[]): RatView[] {
  const order = [...views].sort((a, b) => {
    if (b.pnlPct !== a.pnlPct) return b.pnlPct - a.pnlPct;
    const ta = Date.parse(a.hiredAt);
    const tb = Date.parse(b.hiredAt);
    if (ta !== tb) return ta - tb;
    return a.id - b.id;
  });
  const rankById = new Map<number, number>();
  order.forEach((v, i) => rankById.set(v.id, i + 1));
  return views.map((v) => ({ ...v, rank: rankById.get(v.id)! })).sort((a, b) => a.id - b.id);
}

/** 10 best (best first) and 10 worst (worst first). */
export function leaderboard(rats: RatView[], size = 10): { top: RatView[]; bottom: RatView[] } {
  const byRank = [...rats].sort((a, b) => a.rank - b.rank);
  return { top: byRank.slice(0, size), bottom: byRank.slice(-size).reverse() };
}

export function summarizePortfolio(rats: RatView[]): Portfolio {
  const cost = rats.reduce((a, r) => a + r.costUsd, 0);
  const value = rats.reduce((a, r) => a + r.valueUsd, 0);
  const frozen = rats.filter((r) => r.status === 'frozen').length;
  return {
    ratCount: rats.length,
    activeCount: rats.length - frozen,
    frozenCount: frozen,
    positionCount: new Set(rats.map((r) => r.stockMint)).size,
    costUsd: round2(cost),
    valueUsd: round2(value),
    pnlUsd: round2(value - cost),
    pnlPct: cost > 0 ? round2(((value - cost) / cost) * 100) : 0,
  };
}

export interface StockFacts {
  symbol: string;
  name: string;
  mint: string;
  priceUsd: number | null;
  change24hPct: number | null;
  status: 'active' | 'paused';
  /** 0..1 */
  hireWeight: number;
}

/** Per-stock aggregates in the order of `stocks`. */
export function summarizeStocks(stocks: StockFacts[], rats: RatView[]): StockView[] {
  const totalValue = rats.reduce((a, r) => a + r.valueUsd, 0);
  return stocks.map((s) => {
    const mine = rats.filter((r) => r.stockMint === s.mint);
    const cost = mine.reduce((a, r) => a + r.costUsd, 0);
    const value = mine.reduce((a, r) => a + r.valueUsd, 0);
    return {
      symbol: s.symbol,
      name: s.name,
      mint: s.mint,
      priceUsd: s.priceUsd,
      change24hPct: s.change24hPct,
      status: s.status,
      ratCount: mine.length,
      costUsd: round2(cost),
      valueUsd: round2(value),
      pnlUsd: round2(value - cost),
      pnlPct: cost > 0 ? round2(((value - cost) / cost) * 100) : 0,
      allocationPct: totalValue > 0 ? round2((value / totalValue) * 100) : 0,
      hireWeightPct: s.status === 'paused' ? 0 : round2(s.hireWeight * 100),
    };
  });
}
