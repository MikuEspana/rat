// The launch simulator: a whole launch in the browser, no server. A market cap curve (scenarios.ts) makes
// trading volume, volume makes creator fees, and the backend's rules (rules.ts) turn fees into claims and hires:
// a claim every 35 s loop, every lamport to hires (the rats hold their stocks, nothing is bought back or burned),
// 0.03 SOL per rat, at most 20 hires per loop, 60 SOL per hour, and at most 40 Jupiter calls in any minute (one per
// hire plus a price call every 45 s). What the limits hold back waits and is spent later.
// Stock picks use the worker's own picker. Responses are built with the contract's display math, in the exact
// shapes of /api/state, /api/rats and /api/events, so the site renders them with its real code.
//
// Nothing here touches a chain or a key: wallets are random strings, events carry no transaction signature.
import {
  computeRatView,
  leaderboard,
  rankRats,
  round2,
  SCHEMA_VERSION,
  summarizePortfolio,
  summarizeStocks,
  type EventsResponse,
  type RatEvent,
  type RatFacts,
  type RatsResponse,
  type RatView,
  type StateResponse,
  type StockFacts,
} from '@rat/contract';
import mockState from '@rat/contract/mock/state.json';
import { hireWeights, pickWeighted } from '../../../../packages/core/src/picker';
import { Rng } from '../floor/rng';
import { RULES, SWAP_SOL } from './rules';
import { COIN_SUPPLY, creatorFeeRate, curveAt, phaseFeePerMin, SOL_USD, volumeUsdPerHour, type Scenario } from './scenarios';

const STEP_MS = 5_000; // fee accrual resolution
const HIRE_GAP_MS = 1_500; // the hires of one loop go out one after another (each is its own transaction)
const HOUR_MS = 3_600_000;
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export const SIM_COIN_MINT = 'SiMuLaTioNRaTMint1111111111111111111111pump';

const round6 = (n: number): number => Math.round(n * 1e6) / 1e6;

interface SimStock {
  symbol: string;
  name: string;
  mint: string;
  price: number;
  /** price 24h ago, so change24hPct follows the drift */
  openPrice: number;
  base: number;
  /** ln drift per hour of the current trend */
  drift: number;
  nextTrendAt: number;
}

type Pending = { at: number; kind: 'hire' };

export interface SimStats {
  /** ms since launch */
  t: number;
  endMs: number;
  launched: boolean;
  finished: boolean;
  mcap: number | null;
  rats: number;
  feesSol: number;
  claimedSol: number;
  /** SOL spent on hires */
  hiredSol: number;
  /** claimed SOL waiting for the hourly hire cap */
  hireWaitingSol: number;
  /** most Jupiter calls in any 60 s so far */
  jupiterMaxPerMin: number;
  /** what all the rats' stocks are worth now (the rats' portfolio, not holders' money) */
  portfolioValueUsd: number;
}

export class LaunchSim {
  readonly epoch: number;
  readonly endMs: number;
  private readonly rng: Rng;
  private t = 0;
  private launched = false;
  private noise = 0;
  private mcap = 0;
  private readonly supply = COIN_SUPPLY;
  private claimable = 0;
  private hireBucket = 0;
  private fees = 0;
  private hireSpends: Array<{ at: number; sol: number }> = [];
  /** times of Jupiter calls (prices + builds) in the last minute, and the most seen in any minute */
  private jupiterCalls: number[] = [];
  private jupiterMax = 0;
  private pending: Pending[] = [];
  private nextStepAt = 0;
  private nextPriceAt = 0;
  private nextLoopAt = 0;
  private lastClaimAt: number | null = null;
  private readonly stocks: SimStock[];
  private readonly rats: RatFacts[] = [];
  private events: RatEvent[] = [];
  private nextEventId = 1;
  private readonly treasury: StateResponse['treasury'] = { totalClaimedSol: 0, totalHiredSol: 0, waitingSol: 0 };

  constructor(
    readonly scenario: Scenario,
    epoch = Date.now(),
  ) {
    this.epoch = epoch;
    this.endMs = scenario.minutes * 60_000;
    this.rng = new Rng(scenario.seed);
    this.stocks = (mockState as unknown as StateResponse).stocks.map((s) => {
      const price = s.priceUsd ?? 100;
      return { symbol: s.symbol, name: s.name, mint: s.mint, price, openPrice: price / (1 + (s.change24hPct ?? 0) / 100), base: price, drift: 0, nextTrendAt: 0 };
    });
    this.mcap = curveAt(scenario, 0).mcap;
  }

  /** The coin goes live: fees start, the bot's loops start. */
  launch(): void {
    if (this.launched) return;
    this.launched = true;
    this.t = 0;
    this.nextStepAt = STEP_MS;
    this.nextPriceAt = RULES.priceSec * 1000;
    this.nextLoopAt = RULES.loopSec * 1000;
  }

  get isLaunched(): boolean {
    return this.launched;
  }

  get time(): number {
    return this.t;
  }

  get finished(): boolean {
    return this.launched && this.t >= this.endMs;
  }

  /** Wall-clock time shown by the site for the current sim moment. */
  now(): number {
    return this.epoch + this.t;
  }

  // ------------------------------------------------------------------ simulation

  private gap(loSec: number, hiSec: number): number {
    return (loSec + this.rng.next() * (hiSec - loSec)) * 1000;
  }

  private gauss(): number {
    const u = Math.max(1e-12, this.rng.next());
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * this.rng.next());
  }

  private b58(len: number): string {
    let s = '';
    for (let k = 0; k < len; k++) s += B58[this.rng.int(58)];
    return s;
  }

  private iso(t = this.t): string {
    return new Date(this.epoch + t).toISOString();
  }

  private push(e: Omit<RatEvent, 'id' | 'dryRun' | 'txSig' | 'txUrl' | 'at'>): void {
    // no transaction signature: nothing was sent, so there is nothing to link to
    this.events.push({ ...e, id: this.nextEventId++, at: this.iso(), txSig: null, txUrl: null, dryRun: false } as RatEvent);
  }

  private spentLastHour(list: Array<{ at: number; sol: number }>): number {
    while (list.length && list[0]!.at <= this.t - HOUR_MS) list.shift();
    return list.reduce((a, s) => a + s.sol, 0);
  }

  private schedule(p: Pending): void {
    let k = this.pending.length;
    while (k > 0 && this.pending[k - 1]!.at > p.at) k--;
    this.pending.splice(k, 0, p);
  }

  private change(s: SimStock): number {
    return (s.price / s.openPrice - 1) * 100;
  }

  /** Market cap with a little noise around the scenario curve; fees from the volume. */
  private accrue(): void {
    const c = curveAt(this.scenario, this.t / 60_000);
    this.mcap = c.mcap * Math.exp(this.noise);
    const volumeUsd = volumeUsdPerHour(this.mcap, c.slopePerHour) * (STEP_MS / HOUR_MS);
    const phases = this.scenario.feePhases;
    const feeSol = phases ? phaseFeePerMin(phases, this.t / 60_000) * (STEP_MS / 60_000) : (volumeUsd * creatorFeeRate(this.mcap)) / SOL_USD;
    this.claimable += feeSol;
    this.fees += feeSol;
  }

  /** Jupiter calls left in the rolling minute. */
  private jupiterRoom(): number {
    while (this.jupiterCalls.length && this.jupiterCalls[0]! <= this.t - 60_000) this.jupiterCalls.shift();
    return RULES.jupiterPerMin - this.jupiterCalls.length;
  }

  private jupiterCall(): void {
    this.jupiterCalls.push(this.t);
    this.jupiterMax = Math.max(this.jupiterMax, this.jupiterCalls.length);
  }

  /** Stock prices drift in trends that flip (exaggerated, so rats visibly change tier within one launch). */
  private stepPrices(): void {
    // one batched Jupiter call for every price; with no call left this round is skipped, like the worker
    if (this.jupiterRoom() < 1) return;
    this.jupiterCall();
    const dtH = RULES.priceSec / 3600;
    for (const s of this.stocks) {
      if (this.t >= s.nextTrendAt) {
        s.drift = this.rng.pick([-0.05, -0.025, 0, 0.025, 0.05, 0.08]);
        s.nextTrendAt = this.t + this.gap(20 * 60, 60 * 60);
      }
      s.price *= Math.exp(s.drift * dtH + 0.0025 * this.gauss());
      if (s.price > s.base * 1.8) s.drift = -Math.abs(s.drift || 0.025);
      if (s.price < s.base * 0.6) s.drift = Math.abs(s.drift || 0.025);
    }
    // market cap noise: mean-reverting, about 6% either side of the curve
    const k = RULES.priceSec / 600;
    this.noise += -this.noise * k + 0.06 * Math.sqrt(2 * k) * this.gauss();
  }

  /** The bot's loop: claim (all of it to hires), then hire as far as the budget, the per-loop limit and the cap allow. */
  private loop(): void {
    if (this.claimable >= RULES.minClaimSol) {
      const amount = round6(this.claimable);
      this.claimable = 0;
      this.hireBucket += amount;
      this.treasury.totalClaimedSol = round6(this.treasury.totalClaimedSol + amount);
      this.lastClaimAt = this.t;
      this.push({ type: 'claim', data: { amountSol: amount, source: 'bot' } } as Omit<RatEvent, 'id' | 'dryRun' | 'txSig' | 'txUrl' | 'at'>);
    }
    const capLeft = RULES.capHireSolPerHour - this.spentLastHour(this.hireSpends);
    const jupiterLeft = this.jupiterRoom() - RULES.tokensKeptForPrices;
    const n = Math.max(0, Math.min(RULES.maxHiresPerLoop, jupiterLeft, Math.floor((this.hireBucket + 1e-9) / RULES.salarySol), Math.floor((capLeft + 1e-9) / RULES.salarySol)));
    for (let k = 0; k < n; k++) {
      this.jupiterCall(); // one /build per hire
      // reserve before sending, like the spend guard
      this.hireBucket -= RULES.salarySol;
      this.treasury.totalHiredSol = round6(this.treasury.totalHiredSol + RULES.salarySol);
      this.hireSpends.push({ at: this.t, sol: RULES.salarySol });
      this.schedule({ at: this.t + (k + 1) * HIRE_GAP_MS, kind: 'hire' });
    }
  }

  private hire(): void {
    const weights = hireWeights(this.stocks.map((s) => ({ key: s.mint, change24hPct: this.change(s) })), RULES.minStockWeightBps);
    const mint = pickWeighted(weights, this.rng);
    const stock = this.stocks.find((s) => s.mint === mint) ?? this.stocks[0]!;
    const id = this.rats.length + 1;
    const wallet = this.b58(44);
    const costUsd = round2(SWAP_SOL * SOL_USD);
    const tokens = (costUsd * (1 - 0.003)) / stock.price; // a little under cost: new rats start slightly red
    const name = `Rat #${String(id).padStart(4, '0')}`;
    this.rats.push({
      id,
      name,
      wallet,
      stock: stock.symbol,
      stockMint: stock.mint,
      status: 'active',
      avatarSeed: this.rng.int(0x100000000).toString(16).padStart(8, '0'),
      hiredAt: this.iso(),
      hireTx: null,
      tokenAmount: tokens.toFixed(8),
      costUsd,
    });
    this.push({ type: 'hire', data: { ratId: id, ratName: name, wallet, stock: stock.symbol, salarySol: RULES.salarySol, costUsd } } as Omit<RatEvent, 'id' | 'dryRun' | 'txSig' | 'txUrl' | 'at'>);
  }

  /** Runs everything due up to `targetMs` after launch (stops at the scenario's end). */
  advanceTo(targetMs: number): void {
    if (!this.launched) return;
    const target = Math.min(targetMs, this.endMs);
    for (;;) {
      const p = this.pending[0];
      const next = Math.min(this.nextStepAt, this.nextPriceAt, this.nextLoopAt, p ? p.at : Number.POSITIVE_INFINITY);
      if (next > target) break;
      this.t = next;
      if (p && p.at === next) {
        this.pending.shift();
        this.hire();
      } else if (this.nextStepAt === next) {
        this.accrue();
        this.nextStepAt += STEP_MS;
      } else if (this.nextPriceAt === next) {
        this.stepPrices();
        this.nextPriceAt += RULES.priceSec * 1000;
      } else {
        this.loop();
        this.nextLoopAt += RULES.loopSec * 1000;
      }
    }
    this.t = Math.max(this.t, target);
  }

  stats(): SimStats {
    return {
      t: this.t,
      endMs: this.endMs,
      launched: this.launched,
      finished: this.finished,
      mcap: this.launched ? this.mcap : null,
      rats: this.rats.length,
      feesSol: this.fees,
      claimedSol: this.treasury.totalClaimedSol,
      hiredSol: this.treasury.totalHiredSol,
      hireWaitingSol: Math.max(0, this.hireBucket),
      jupiterMaxPerMin: this.jupiterMax,
      portfolioValueUsd: this.portfolioValue(),
    };
  }

  private portfolioValue(): number {
    const prices = new Map(this.stocks.map((s) => [s.mint, s.price]));
    let v = 0;
    for (const r of this.rats) v += Number(r.tokenAmount) * (prices.get(r.stockMint) ?? 0);
    return v;
  }

  // ------------------------------------------------------------------ responses (same shapes as the real API)

  private views(): RatView[] {
    const prices = new Map(this.stocks.map((s) => [s.mint, s.price]));
    return rankRats(this.rats.map((r) => computeRatView(r, prices.get(r.stockMint) ?? null)));
  }

  stateResponse(): StateResponse {
    const all = this.views();
    const weights = hireWeights(this.stocks.map((s) => ({ key: s.mint, change24hPct: this.change(s) })), RULES.minStockWeightBps);
    const facts: StockFacts[] = this.stocks.map((s) => ({
      symbol: s.symbol,
      name: s.name,
      mint: s.mint,
      priceUsd: round2(s.price),
      change24hPct: round2(this.change(s)),
      status: 'active',
      hireWeight: weights.get(s.mint) ?? 0,
    }));
    const live = this.launched;
    const price = this.mcap / this.supply;
    return {
      schemaVersion: SCHEMA_VERSION,
      generatedAt: this.iso(),
      bot: {
        mode: 'live',
        lastClaimAt: this.lastClaimAt === null ? null : this.iso(this.lastClaimAt),
        nextClaimAt: live && !this.finished ? this.iso(this.nextLoopAt) : null,
      },
      coin: {
        mint: live ? SIM_COIN_MINT : null,
        symbol: 'RAT',
        priceUsd: live ? Number(price.toPrecision(4)) : null,
        supply: live ? this.supply.toFixed(2) : null,
        marketCapUsd: live ? Math.round(this.mcap) : null,
      },
      wallets: { creator: null },
      treasury: { ...this.treasury, waitingSol: round6(Math.max(0, this.hireBucket)) },
      portfolio: summarizePortfolio(all),
      stocks: summarizeStocks(facts, all),
      leaderboard: leaderboard(all),
      events: this.events.slice(-50).reverse(),
    };
  }

  ratsResponse(): RatsResponse {
    const all = this.views();
    return { schemaVersion: SCHEMA_VERSION, generatedAt: this.iso(), total: all.length, rats: all };
  }

  eventsResponse(afterId: number, limit = 500): EventsResponse {
    // events are in id order: find the first one after the cursor from the end
    let k = this.events.length;
    while (k > 0 && this.events[k - 1]!.id > afterId) k--;
    const rows = this.events.slice(k, k + limit);
    return {
      schemaVersion: SCHEMA_VERSION,
      generatedAt: this.iso(),
      lastId: rows.length > 0 ? rows[rows.length - 1]!.id : this.nextEventId - 1,
      events: rows,
    };
  }
}
