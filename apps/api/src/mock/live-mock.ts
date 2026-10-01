// Live mock of the public API, for building and animating the site before the bot runs.
// Starts from packages/contract/mock/*.json (timestamps shifted to "now") and keeps changing like the real bot:
//   - a new rat every 2 to 6 seconds (fresh wallet; stock picked like the bot: better 24h change, more hires, 5% floor)
//   - stock prices drift every second in trends that flip, exaggerated so rats visibly change tier
//   - a claim every 35 seconds (every claimed SOL goes to hiring rats)
//   - one stock (COINx) pauses (its rats freeze) and resumes (they unfreeze) every couple of minutes
// Same contract, schemaVersion 2. No database, no chain, nothing real.
import { createRequire } from 'node:module';
import {
  type BotMode,
  type EventsResponse,
  type RatEvent,
  type RatFacts,
  type RatsResponse,
  SCHEMA_VERSION,
  type StateResponse,
  type StockFacts,
  computeRatView,
  leaderboard,
  rankRats,
  round2,
  solscanTxUrl,
  summarizePortfolio,
  summarizeStocks,
} from '@rat/contract';
import { type Clock, type Rng, avatarSeedFor, hireWeights, pickWeighted, ratName, systemRng } from '@rat/core';
import type { StateProvider } from '../app';

const SOL_USD = 185.4;
const SALARY_SOL = 0.03;
/** what a rat actually swaps into its stock (salary minus fees, rent and its SOL buffer) */
const SWAP_SOL = 0.0265;
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
/** after a long idle gap only the last few minutes are simulated */
const MAX_CATCHUP_MS = 5 * 60_000;

interface MockStock {
  symbol: string;
  name: string;
  mint: string;
  price: number;
  /** price 24h ago, so change24hPct follows the drift */
  openPrice: number;
  basePrice: number;
  status: 'active' | 'paused';
  /** per-second log drift of the current trend */
  drift: number;
  nextTrendAt: number;
}

export interface LiveMockOptions {
  clock: Clock;
  rng?: Rng;
  /** 2 = everything happens twice as often (default 1) */
  speed?: number;
  /** hiring stops at this many rats (default 6000) */
  maxRats?: number;
  /** the stock that pauses and resumes (default COINx) */
  pausingStock?: string;
}

const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

export class LiveMock implements StateProvider {
  private readonly clock: Clock;
  private readonly rng: Rng;
  private readonly speed: number;
  private readonly maxRats: number;
  private readonly rats: RatFacts[] = [];
  private readonly stocks: MockStock[] = [];
  private events: RatEvent[] = [];
  private nextEventId: number;
  private readonly coin: { mint: string | null; priceUsd: number; supply: number };
  private readonly wallets: { creator: string | null };
  private readonly treasury: StateResponse['treasury'];
  private readonly bot: { lastClaimAt: string | null; nextClaimAt: string | null };
  private readonly pausing: string;
  private simMs: number;
  private lastPriceAt: number;
  private readonly due: { price: number; hire: number; claim: number; pause: number };

  constructor(opts: LiveMockOptions) {
    this.clock = opts.clock;
    this.rng = opts.rng ?? systemRng;
    this.speed = opts.speed && opts.speed > 0 ? opts.speed : 1;
    this.maxRats = opts.maxRats ?? 6000;
    this.pausing = opts.pausingStock ?? 'COINx';

    const require = createRequire(import.meta.url);
    const load = (f: string) => require(`@rat/contract/mock/${f}`) as unknown;
    const state = structuredClone(load('state.json')) as StateResponse;
    const ratsFile = structuredClone(load('rats.json')) as RatsResponse;
    const eventsFile = structuredClone(load('events.json')) as EventsResponse;

    const now = this.clock.now().getTime();
    const shift = now - Date.parse(state.generatedAt);
    const moved = (iso: string | null) => (iso ? new Date(Date.parse(iso) + shift).toISOString() : null);

    for (const s of state.stocks) {
      const price = s.priceUsd ?? 100;
      this.stocks.push({
        symbol: s.symbol,
        name: s.name,
        mint: s.mint,
        price,
        openPrice: price / (1 + (s.change24hPct ?? 0) / 100),
        basePrice: price,
        status: s.status,
        drift: 0,
        nextTrendAt: now,
      });
    }
    for (const r of ratsFile.rats) {
      this.rats.push({
        id: r.id,
        name: r.name,
        wallet: r.wallet,
        stock: r.stock,
        stockMint: r.stockMint,
        status: r.status,
        avatarSeed: r.avatarSeed,
        hiredAt: moved(r.hiredAt)!,
        hireTx: r.hireTx,
        tokenAmount: r.tokenAmount,
        costUsd: r.costUsd,
      });
    }
    this.events = eventsFile.events.map((e) => ({ ...e, at: moved(e.at)! })).sort((a, b) => a.id - b.id);
    this.nextEventId = Math.max(eventsFile.lastId, ...this.events.map((e) => e.id)) + 1;
    this.coin = {
      mint: state.coin.mint,
      priceUsd: state.coin.priceUsd ?? 0.0018,
      supply: Number(state.coin.supply ?? '1000000000'),
    };
    this.wallets = { ...state.wallets };
    this.treasury = { ...state.treasury };
    this.bot = { lastClaimAt: moved(state.bot.lastClaimAt), nextClaimAt: null };

    this.simMs = now;
    this.lastPriceAt = now;
    const paused = this.stocks.find((s) => s.symbol === this.pausing);
    this.due = {
      price: now + 1000,
      hire: now + this.gap(2, 6),
      claim: now + this.gap(35, 35),
      pause: now + this.gap(paused?.status === 'paused' ? 40 : 80, paused?.status === 'paused' ? 40 : 80),
    };
    this.bot.nextClaimAt = new Date(this.due.claim).toISOString();
  }

  // ---------- simulation ----------

  /** ms until the next event, uniform between lo and hi seconds, scaled by speed */
  private gap(lo: number, hi: number): number {
    return ((lo + this.rng.next() * (hi - lo)) * 1000) / this.speed;
  }

  private pick<T>(xs: T[]): T {
    return xs[Math.floor(this.rng.next() * xs.length)]!;
  }

  private b58(len: number): string {
    let s = '';
    for (let i = 0; i < len; i++) s += B58[Math.floor(this.rng.next() * 58)];
    return s;
  }

  private push(e: Omit<RatEvent, 'id' | 'dryRun' | 'txUrl'> & { txSig: string | null }): void {
    const event = { ...e, id: this.nextEventId++, dryRun: false, txUrl: e.txSig ? solscanTxUrl(e.txSig) : null } as RatEvent;
    this.events.push(event);
    if (this.events.length > 5000) this.events = this.events.slice(-4000);
  }

  private at(): string {
    return new Date(this.simMs).toISOString();
  }

  private stepPrices(): void {
    const dt = Math.sqrt(this.speed);
    for (const s of this.stocks) {
      if (s.status === 'paused') continue; // a paused stock does not trade
      if (this.simMs >= s.nextTrendAt) {
        s.drift = this.pick([-0.0025, -0.001, 0, 0.001, 0.0025]);
        s.nextTrendAt = this.simMs + this.gap(45, 120);
      }
      const shock = (this.rng.next() + this.rng.next() + this.rng.next() - 1.5) * 0.004;
      s.price *= Math.exp((s.drift + shock) * dt);
      // keep it within a band around where it started, turning the trend around at the edges
      if (s.price > s.basePrice * 2.2) s.drift = -Math.abs(s.drift || 0.001);
      if (s.price < s.basePrice * 0.45) s.drift = Math.abs(s.drift || 0.001);
    }
    this.coin.priceUsd *= Math.exp((this.rng.next() - 0.5) * 0.01 * dt);
    this.lastPriceAt = this.simMs;
  }

  private hire(): void {
    if (this.rats.length >= this.maxRats) return;
    const active = this.stocks.filter((s) => s.status === 'active');
    const weights = hireWeights(active.map((s) => ({ key: s.mint, change24hPct: (s.price / s.openPrice - 1) * 100 })), 500);
    const mint = pickWeighted(weights, this.rng);
    const stock = active.find((s) => s.mint === mint);
    if (!stock) return;
    const id = (this.rats.at(-1)?.id ?? 0) + 1;
    const wallet = this.b58(44);
    const costUsd = SWAP_SOL * SOL_USD;
    const tokens = (costUsd * 0.995) / stock.price; // a little under cost: new rats start slightly red
    const sig = this.b58(88);
    this.treasury.totalHiredSol = round6(this.treasury.totalHiredSol + SALARY_SOL);
    this.treasury.waitingSol = round6(Math.max(0, this.treasury.waitingSol - SALARY_SOL));
    this.rats.push({
      id,
      name: ratName(id),
      wallet,
      stock: stock.symbol,
      stockMint: stock.mint,
      status: 'active',
      avatarSeed: avatarSeedFor(wallet),
      hiredAt: this.at(),
      hireTx: sig,
      tokenAmount: tokens.toFixed(8),
      costUsd: round2(costUsd),
    });
    this.push({ type: 'hire', at: this.at(), txSig: sig, data: { ratId: id, ratName: ratName(id), wallet, stock: stock.symbol, salarySol: SALARY_SOL, costUsd: round2(costUsd) } });
  }

  private claim(): void {
    const amount = round6(0.05 + this.rng.next() * 0.55);
    this.treasury.totalClaimedSol = round6(this.treasury.totalClaimedSol + amount);
    this.treasury.waitingSol = round6(this.treasury.waitingSol + amount);
    this.bot.lastClaimAt = this.at();
    this.push({ type: 'claim', at: this.at(), txSig: this.b58(88), data: { amountSol: amount, source: this.rng.next() < 0.1 ? 'external' : 'bot' } });
  }

  private togglePause(): void {
    const s = this.stocks.find((x) => x.symbol === this.pausing);
    if (!s) return;
    const mine = this.rats.filter((r) => r.stockMint === s.mint);
    if (s.status === 'active') {
      s.status = 'paused';
      const hit = mine.filter((r) => r.status === 'active');
      for (const r of hit) r.status = 'frozen';
      this.push({ type: 'freeze', at: this.at(), txSig: null, data: { scope: 'stock', stock: s.symbol, ratId: null, ratCount: hit.length, reason: 'stock_paused' } });
      this.due.pause = this.simMs + this.gap(40, 40);
    } else {
      s.status = 'active';
      const hit = mine.filter((r) => r.status === 'frozen');
      for (const r of hit) r.status = 'active';
      this.push({ type: 'unfreeze', at: this.at(), txSig: null, data: { scope: 'stock', stock: s.symbol, ratId: null, ratCount: hit.length, reason: 'stock_resumed' } });
      this.due.pause = this.simMs + this.gap(80, 80);
    }
  }

  /** Runs everything that was due up to now. */
  private advance(): void {
    const target = this.clock.now().getTime();
    if (target - this.simMs > MAX_CATCHUP_MS) {
      const skip = target - MAX_CATCHUP_MS - this.simMs;
      this.simMs += skip;
      for (const k of Object.keys(this.due) as (keyof typeof this.due)[]) this.due[k] = Math.max(this.due[k], this.simMs);
    }
    for (;;) {
      const next = Math.min(this.due.price, this.due.hire, this.due.claim, this.due.pause);
      if (next > target) break;
      this.simMs = next;
      if (this.due.price === next) {
        this.stepPrices();
        this.due.price = next + 1000;
      } else if (this.due.hire === next) {
        this.hire();
        this.due.hire = next + this.gap(2, 6);
      } else if (this.due.claim === next) {
        this.claim();
        this.due.claim = next + this.gap(35, 35);
        this.bot.nextClaimAt = new Date(this.due.claim).toISOString();
      } else {
        this.togglePause();
      }
    }
    this.simMs = target;
  }

  // ---------- responses (same shapes as the real API) ----------

  private views() {
    const prices = new Map(this.stocks.map((s) => [s.mint, s.price]));
    return rankRats(this.rats.map((r) => computeRatView(r, prices.get(r.stockMint) ?? null)));
  }

  async stateResponse(): Promise<StateResponse> {
    this.advance();
    const all = this.views();
    const active = this.stocks.filter((s) => s.status === 'active');
    const weights = hireWeights(active.map((s) => ({ key: s.mint, change24hPct: (s.price / s.openPrice - 1) * 100 })), 500);
    const facts: StockFacts[] = this.stocks.map((s) => ({
      symbol: s.symbol,
      name: s.name,
      mint: s.mint,
      priceUsd: round2(s.price),
      change24hPct: round2((s.price / s.openPrice - 1) * 100),
      status: s.status,
      hireWeight: weights.get(s.mint) ?? 0,
    }));
    return {
      schemaVersion: SCHEMA_VERSION,
      generatedAt: this.clock.now().toISOString(),
      bot: { mode: 'live', ...this.bot },
      coin: {
        mint: this.coin.mint,
        symbol: 'WSI',
        priceUsd: Number(this.coin.priceUsd.toPrecision(4)),
        supply: this.coin.supply.toFixed(2),
        marketCapUsd: Math.round(this.coin.priceUsd * this.coin.supply),
      },
      wallets: { ...this.wallets },
      treasury: { ...this.treasury },
      portfolio: summarizePortfolio(all),
      stocks: summarizeStocks(facts, all),
      leaderboard: leaderboard(all),
      events: this.events.slice(-50).reverse(),
    };
  }

  async ratsResponse(afterId = 0): Promise<RatsResponse> {
    this.advance();
    const all = this.views();
    return { schemaVersion: SCHEMA_VERSION, generatedAt: this.clock.now().toISOString(), total: all.length, rats: all.filter((r) => r.id > afterId) };
  }

  async eventsResponse(afterId: number, limit: number): Promise<EventsResponse> {
    this.advance();
    const rows = this.events.filter((e) => e.id > afterId).slice(0, limit);
    return {
      schemaVersion: SCHEMA_VERSION,
      generatedAt: this.clock.now().toISOString(),
      lastId: rows.length > 0 ? rows[rows.length - 1]!.id : this.nextEventId - 1,
      events: rows,
    };
  }

  async health(): Promise<{ ok: boolean; mode: BotMode; heartbeatAgeSec: number | null }> {
    this.advance();
    return { ok: true, mode: 'live', heartbeatAgeSec: Math.round((this.clock.now().getTime() - this.lastPriceAt) / 1000) };
  }
}
