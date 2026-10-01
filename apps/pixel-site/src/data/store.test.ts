import { describe, expect, it } from 'vitest';
import type { HireEvent, RatsResponse, StateResponse, FreezeEvent } from '@rat/contract';
import stateJson from '@rat/contract/mock/state.json';
import ratsJson from '@rat/contract/mock/rats.json';
import { Store, type StoreEvent } from './store';

const state = stateJson as unknown as StateResponse;
const rats = ratsJson as unknown as RatsResponse;

function loaded(): { store: Store; seen: StoreEvent[] } {
  const store = new Store();
  const seen: StoreEvent[] = [];
  store.on((e) => seen.push(e));
  store.initState(structuredClone(state));
  store.loadRoster(structuredClone(rats));
  return { store, seen };
}

function hire(id: number, ratId: number, stock: string, costUsd = 5): HireEvent {
  return {
    id,
    type: 'hire',
    at: '2026-10-01T18:00:00Z',
    txSig: 'sig',
    txUrl: 'https://solscan.io/tx/sig',
    dryRun: false,
    data: { ratId, ratName: `Inu #${ratId}`, wallet: 'W'.repeat(44), stock, salarySol: 0.03, costUsd },
  };
}

describe('Store', () => {
  it('loads the roster once and recomputes the same views the API sent', () => {
    const { store } = loaded();
    expect(store.rats.size).toBe(rats.rats.length);
    const sample = rats.rats[7]!;
    const rec = store.rats.get(sample.id)!;
    expect(rec.view.tier).toBe(sample.tier);
    expect(rec.view.pnlPct).toBeCloseTo(sample.pnlPct, 1);
  });

  it('starts the event cursor after the history in /api/state', () => {
    const { store } = loaded();
    const maxId = Math.max(...state.events.map((e) => e.id));
    expect(store.lastEventId).toBe(maxId);
  });

  it('recomputes tiers from new prices without re-polling the roster', () => {
    const { store, seen } = loaded();
    const next = structuredClone(state);
    for (const s of next.stocks) if (s.priceUsd !== null) s.priceUsd *= 3; // everyone becomes a partner
    store.applyState(next);
    const tiers = seen.find((e) => e.kind === 'tiers');
    expect(tiers && tiers.kind === 'tiers' && tiers.ratIds.length).toBeGreaterThan(0);
    const priced = [...store.rats.values()].filter((r) => store.price(r.facts.stock) !== null);
    expect(priced.every((r) => r.view.tier === 'partner')).toBe(true);
  });

  it('adds a hired rat from the event, valued at cost now and following the price after', () => {
    const { store, seen } = loaded();
    const stock = state.stocks.find((s) => s.status === 'active' && s.priceUsd)!;
    const id = Math.max(...rats.rats.map((r) => r.id)) + 1;
    store.applyEvents([hire(store.lastEventId + 1, id, stock.symbol, 10)]);
    const rec = store.rats.get(id)!;
    expect(rec.estimated).toBe(true);
    expect(rec.view.valueUsd).toBeCloseTo(10, 2);
    expect(rec.view.pnlPct).toBe(0);
    expect(seen.some((e) => e.kind === 'hire')).toBe(true);
    const next = structuredClone(state);
    next.stocks.find((s) => s.symbol === stock.symbol)!.priceUsd = stock.priceUsd! * 1.2;
    store.applyState(next);
    expect(store.rats.get(id)!.view.pnlPct).toBeCloseTo(20, 1);
  });

  it('ignores events it has already seen and hires of rats already in the roster', () => {
    const { store, seen } = loaded();
    const known = rats.rats[0]!;
    store.applyEvents([hire(store.lastEventId, 999_999, 'TSLAx')]); // old id
    store.applyEvents([hire(store.lastEventId + 1, known.id, known.stock)]); // already known
    expect(store.rats.has(999_999)).toBe(false);
    expect(seen.filter((e) => e.kind === 'hire')).toHaveLength(0);
  });

  it('freezes and unfreezes a whole stock', () => {
    const { store } = loaded();
    const sym = state.stocks.find((s) => s.status === 'active')!.symbol;
    const base = { id: store.lastEventId + 1, at: '2026-10-01T18:00:00Z', txSig: null, txUrl: null, dryRun: false };
    const freeze: FreezeEvent = { ...base, type: 'freeze', data: { scope: 'stock', stock: sym, ratId: null, ratCount: 1, reason: 'stock_paused' } };
    store.applyEvents([freeze]);
    expect(store.ratsOf(sym).every((r) => r.facts.status === 'frozen')).toBe(true);
    store.applyEvents([{ ...freeze, id: freeze.id + 1, type: 'unfreeze', data: { ...freeze.data, reason: 'stock_resumed' } }]);
    expect(store.ratsOf(sym).every((r) => r.facts.status === 'active')).toBe(true);
  });
});
