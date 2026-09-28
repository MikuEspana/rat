// Client-side state. The roster is loaded once; after that only /api/state (prices, stocks, bot) and
// /api/events (hires, freezes, claims) are followed. Live PnL and tiers are recomputed here with the contract's
// display math, so the roster never needs a re-poll.
import {
  computeRatView,
  type ClaimEvent,
  type FreezeEvent,
  type HireEvent,
  type RatEvent,
  type RatFacts,
  type RatView,
  type RatsResponse,
  type StateResponse,
  type StockView,
  type Tier,
  type UnfreezeEvent,
  type UnrankedRatView,
} from '@rat/contract';

export interface RatRecord {
  facts: RatFacts;
  view: UnrankedRatView;
  /** true when tokenAmount was estimated from a hire event (rat hired after page load) */
  estimated: boolean;
}

export type StoreEvent =
  | { kind: 'roster'; count: number }
  | { kind: 'hire'; rat: RatRecord; event: HireEvent }
  | { kind: 'freeze'; ratIds: number[]; event: FreezeEvent }
  | { kind: 'unfreeze'; ratIds: number[]; event: UnfreezeEvent }
  | { kind: 'claim'; event: ClaimEvent }
  | { kind: 'state'; state: StateResponse }
  | { kind: 'tiers'; ratIds: number[] }
  | { kind: 'feed'; events: RatEvent[] };

type Listener = (e: StoreEvent) => void;

export function factsFromView(v: RatView): RatFacts {
  return {
    id: v.id,
    name: v.name,
    wallet: v.wallet,
    stock: v.stock,
    stockMint: v.stockMint,
    status: v.status,
    avatarSeed: v.avatarSeed,
    hiredAt: v.hiredAt,
    hireTx: v.hireTx,
    tokenAmount: v.tokenAmount,
    costUsd: v.costUsd,
  };
}

export class Store {
  readonly rats = new Map<number, RatRecord>();
  readonly stocks = new Map<string, StockView>();
  state: StateResponse | null = null;
  lastEventId = 0;
  private listeners: Listener[] = [];

  on(fn: Listener): () => void {
    this.listeners.push(fn);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== fn);
    };
  }

  private emit(e: StoreEvent): void {
    for (const l of this.listeners) l(e);
  }

  price(symbol: string): number | null {
    return this.stocks.get(symbol)?.priceUsd ?? null;
  }

  /** First /api/state: stocks and prices, and the event cursor (history is shown in the feed, not replayed). */
  initState(state: StateResponse): void {
    this.state = state;
    for (const s of state.stocks) this.stocks.set(s.symbol, s);
    this.lastEventId = state.events.reduce((m, e) => Math.max(m, e.id), 0);
    this.emit({ kind: 'state', state });
  }

  /** The one full roster load. Rats already known (hired while the roster was loading) keep their record. */
  loadRoster(res: RatsResponse): void {
    for (const v of res.rats) {
      if (this.rats.has(v.id) && !this.rats.get(v.id)!.estimated) continue;
      const facts = factsFromView(v);
      this.rats.set(v.id, { facts, view: computeRatView(facts, this.price(v.stock)), estimated: false });
    }
    this.emit({ kind: 'roster', count: this.rats.size });
  }

  /** Every /api/state poll: new prices recompute every rat; rats whose tier changed are reported. */
  applyState(state: StateResponse): void {
    this.state = state;
    for (const s of state.stocks) this.stocks.set(s.symbol, s);
    const changed: number[] = [];
    for (const rec of this.rats.values()) {
      const before: Tier = rec.view.tier;
      rec.view = computeRatView(rec.facts, this.price(rec.facts.stock));
      if (rec.view.tier !== before) changed.push(rec.facts.id);
    }
    this.emit({ kind: 'state', state });
    if (changed.length) this.emit({ kind: 'tiers', ratIds: changed });
  }

  /** New events from /api/events, oldest first. */
  applyEvents(events: RatEvent[]): void {
    const fresh = events.filter((e) => e.id > this.lastEventId).sort((a, b) => a.id - b.id);
    if (!fresh.length) return;
    for (const e of fresh) {
      this.lastEventId = Math.max(this.lastEventId, e.id);
      if (e.type === 'hire') this.hire(e);
      else if (e.type === 'freeze' || e.type === 'unfreeze') this.freeze(e);
      else if (e.type === 'claim') this.emit({ kind: 'claim', event: e });
    }
    // burns are never shown: every fee hires rats
    const shown = fresh.filter((e) => e.type !== 'burn');
    if (shown.length) this.emit({ kind: 'feed', events: shown });
  }

  private hire(e: HireEvent): void {
    const d = e.data;
    if (this.rats.has(d.ratId)) return; // already in the roster
    const stock = this.stocks.get(d.stock);
    const price = stock?.priceUsd ?? null;
    // No tokenAmount in the hire event: value it as costUsd at today's price, so PnL follows the price from here.
    const tokenAmount = price && price > 0 ? String(d.costUsd / price) : '0';
    const facts: RatFacts = {
      id: d.ratId,
      name: d.ratName,
      wallet: d.wallet,
      stock: d.stock,
      stockMint: stock?.mint ?? '',
      status: stock?.status === 'paused' ? 'frozen' : 'active',
      avatarSeed: '',
      hiredAt: e.at,
      hireTx: e.txSig,
      tokenAmount,
      costUsd: d.costUsd,
    };
    const rec: RatRecord = { facts, view: computeRatView(facts, price), estimated: true };
    this.rats.set(d.ratId, rec);
    this.emit({ kind: 'hire', rat: rec, event: e });
  }

  private freeze(e: FreezeEvent | UnfreezeEvent): void {
    const status = e.type === 'freeze' ? 'frozen' : 'active';
    const ids: number[] = [];
    for (const rec of this.rats.values()) {
      const hit = e.data.scope === 'stock' ? rec.facts.stock === e.data.stock : rec.facts.id === e.data.ratId;
      if (!hit || rec.facts.status === status) continue;
      rec.facts.status = status;
      rec.view = computeRatView(rec.facts, this.price(rec.facts.stock));
      ids.push(rec.facts.id);
    }
    if (e.type === 'freeze') this.emit({ kind: 'freeze', ratIds: ids, event: e });
    else this.emit({ kind: 'unfreeze', ratIds: ids, event: e });
  }

  ratsOf(symbol: string): RatRecord[] {
    const out: RatRecord[] = [];
    for (const r of this.rats.values()) if (r.facts.stock === symbol) out.push(r);
    return out.sort((a, b) => a.facts.id - b.facts.id);
  }
}
