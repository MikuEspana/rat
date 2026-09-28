// The launch simulator: a whole launch in the browser, no server. A market cap curve (scenarios.ts) makes
// trading volume, volume makes creator fees, and the backend's rules (rules.ts) turn fees into claims and hires:
// a claim every 35 s loop, every lamport to hires (the fund holds stocks, nothing is burned), 0.03 SOL per rat, at
// most 10 hires per loop, 30 SOL per hour. With a lower split the rest goes to buy and burn, like the bot: burn
// rounds 8 to 12 minutes apart in chunks of at most 1 SOL.
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
import { COIN_SUPPLY, creatorFeeRate, curveAt, SOL_USD, volumeUsdPerHour, type Scenario } from './scenarios';

const STEP_MS = 5_000; // fee accrual resolution
const HIRE_GAP_MS = 1_500; // the hires of one loop go out one after another (each is its own transaction)
const HOUR_MS = 3_600_000;
const FUND_RESERVE_SOL = 0.01;
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

type Pending = { at: number; kind: 'hire' } | { at: number; kind: 'chunk'; sol: number };

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
  burnedTokens: number;
  burnSpentSol: number;
  burnCount: number;
  /** claimed SOL waiting for the hourly caps */
  hireWaitingSol: number;
  burnWaitingSol: number;
  /** what all the rats' stocks are worth now */
  fundValueUsd: number;
}

export class LaunchSim {
  readonly epoch: number;
  readonly endMs: number;
  private readonly rng: Rng;
  private t = 0;
  private launched = false;
  private noise = 0;
  private mcap = 0;
  private supply = COIN_SUPPLY;
  private burned = 0;
  private claimable = 0;
  private hireBucket = 0;
  private burnBucket = 0;
  private fees = 0;
  private hireSpends: Array<{ at: number; sol: number }> = [];
  private burnSpends: Array<{ at: number; sol: number }> = [];
  private pending: Pending[] = [];
  private nextStepAt = 0;
  private nextPriceAt = 0;
  private nextLoopAt = 0;
  private nextRoundAt = 0;
  private lastClaimAt: number | null = null;
  private readonly stocks: SimStock[];
  private readonly rats: RatFacts[] = [];
  private events: RatEvent[] = [];
  private nextEventId = 1;
  private readonly treasury: StateResponse['treasury'] = {
    totalClaimedSol: 0,
    totalToHiresSol: 0,
    totalToFundSol: 0,
    fundWalletSol: FUND_RESERVE_SOL,
    totalBurnSpentSol: 0,
    burnCount: 0,
    lastBurnAt: null,
  };

  private readonly hireSplitBps: number;

  constructor(
    readonly scenario: Scenario,
    epoch = Date.now(),
    /** the bot's HIRE_SPLIT_BPS (default: all to hires); tests lower it to cover the burn path */
    opts: { hireSplitBps?: number } = {},
  ) {
    this.hireSplitBps = opts.hireSplitBps ?? RULES.hireSplitBps;
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
    this.nextRoundAt = this.gap(RULES.burnMinSec, RULES.burnMaxSec);
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
    const feeSol = (volumeUsd * creatorFeeRate(this.mcap)) / SOL_USD;
    this.claimable += feeSol;
    this.fees += feeSol;
  }

  /** Stock prices drift in trends that flip (exaggerated, so rats visibly change tier within one launch). */
  private stepPrices(): void {
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

  /** The bot's loop: claim, split 50/50, then hire as far as the budget, the per-loop limit and the cap allow. */
  private loop(): void {
    if (this.claimable >= RULES.minClaimSol) {
      const amount = round6(this.claimable);
      const toHires = round6((amount * this.hireSplitBps) / 10_000);
      const toFund = round6(amount - toHires);
      this.claimable = 0;
      this.hireBucket += toHires;
      this.burnBucket += toFund;
      this.treasury.totalClaimedSol = round6(this.treasury.totalClaimedSol + amount);
      this.treasury.totalToHiresSol = round6(this.treasury.totalToHiresSol + toHires);
      this.treasury.totalToFundSol = round6(this.treasury.totalToFundSol + toFund);
      this.treasury.fundWalletSol = round6(this.treasury.fundWalletSol + toFund);
      this.lastClaimAt = this.t;
      this.push({ type: 'claim', data: { amountSol: amount, toHiresSol: toHires, toFundSol: toFund, source: 'bot' } } as Omit<RatEvent, 'id' | 'dryRun' | 'txSig' | 'txUrl' | 'at'>);
    }
    const capLeft = RULES.capHireSolPerHour - this.spentLastHour(this.hireSpends);
    const n = Math.max(0, Math.min(RULES.maxHiresPerLoop, Math.floor((this.hireBucket + 1e-9) / RULES.salarySol), Math.floor((capLeft + 1e-9) / RULES.salarySol)));
    for (let k = 0; k < n; k++) {
      // reserve before sending, like the spend guard
      this.hireBucket -= RULES.salarySol;
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

  /** A burn round: as much as the fund's claimed SOL, the round limit and the hourly cap allow, in chunks. */
  private burnRound(): void {
    const capLeft = RULES.capBurnSolPerHour - this.spentLastHour(this.burnSpends);
    const amount = Math.min(this.burnBucket, RULES.burnRoundMaxSol, capLeft);
    if (amount >= RULES.minBurnSol) {
      const n = Math.ceil(amount / RULES.burnChunkMaxSol - 1e-9);
      const chunk = round6(amount / n);
      let at = this.t;
      for (let k = 0; k < n; k++) {
        this.schedule({ at, kind: 'chunk', sol: chunk });
        at += this.gap(RULES.chunkGapMinSec, RULES.chunkGapMaxSec);
      }
      this.burnBucket -= chunk * n;
      this.burnSpends.push({ at: this.t, sol: chunk * n });
    }
    this.nextRoundAt = this.t + this.gap(RULES.burnMinSec, RULES.burnMaxSec);
  }

  private burnChunk(sol: number): void {
    const price = this.mcap / this.supply;
    const tokens = Math.min(this.supply * 0.01, ((sol * SOL_USD) / price) * (1 - 0.004)); // small price impact, inside the 1.5% slippage
    this.burned += tokens;
    this.supply -= tokens;
    this.treasury.totalBurnSpentSol = round6(this.treasury.totalBurnSpentSol + sol);
    this.treasury.fundWalletSol = round6(Math.max(0, this.treasury.fundWalletSol - sol));
    this.treasury.burnCount++;
    this.treasury.lastBurnAt = this.iso();
    this.push({ type: 'burn', data: { solSpent: sol, tokensBurned: tokens.toFixed(2) } } as Omit<RatEvent, 'id' | 'dryRun' | 'txSig' | 'txUrl' | 'at'>);
  }

  /** Runs everything due up to `targetMs` after launch (stops at the scenario's end). */
  advanceTo(targetMs: number): void {
    if (!this.launched) return;
    const target = Math.min(targetMs, this.endMs);
    for (;;) {
      const p = this.pending[0];
      const next = Math.min(this.nextStepAt, this.nextPriceAt, this.nextLoopAt, this.nextRoundAt, p ? p.at : Number.POSITIVE_INFINITY);
      if (next > target) break;
      this.t = next;
      if (p && p.at === next) {
        this.pending.shift();
        if (p.kind === 'hire') this.hire();
        else this.burnChunk(p.sol);
      } else if (this.nextStepAt === next) {
        this.accrue();
        this.nextStepAt += STEP_MS;
      } else if (this.nextPriceAt === next) {
        this.stepPrices();
        this.nextPriceAt += RULES.priceSec * 1000;
      } else if (this.nextLoopAt === next) {
        this.loop();
        this.nextLoopAt += RULES.loopSec * 1000;
      } else {
        this.burnRound();
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
      burnedTokens: this.burned,
      burnSpentSol: this.treasury.totalBurnSpentSol,
      burnCount: this.treasury.burnCount,
      hireWaitingSol: Math.max(0, this.hireBucket),
      burnWaitingSol: Math.max(0, this.burnBucket),
      fundValueUsd: this.fundValue(),
    };
  }

  private fundValue(): number {
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
        nextBurnAt: live && !this.finished ? this.iso(this.nextRoundAt) : null,
      },
      coin: {
        mint: live ? SIM_COIN_MINT : null,
        symbol: 'RAT',
        priceUsd: live ? Number(price.toPrecision(4)) : null,
        supply: live ? this.supply.toFixed(2) : null,
        marketCapUsd: live ? Math.round(this.mcap) : null,
        burnedTokens: this.burned.toFixed(2),
      },
      wallets: { creator: null, fund: null },
      treasury: { ...this.treasury },
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
