// Debug only: pad the roster to N rats (?stress=3000) and keep synthetic hires walking in (?walkers=N), so the
// 3,000-rat target can be tested against the mock API, which starts with 250 rats.
import type { HireEvent, RatsResponse, RatView, StateResponse } from '@rat/contract';

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s ^ (s >>> 15), 2246822507) + 0x9e3779b9) >>> 0;
    return (s >>> 8) / 16777216;
  };
}

export function padRoster(res: RatsResponse, state: StateResponse, target: number): RatsResponse {
  if (res.rats.length >= target) return res;
  const r = rng(3000);
  const stocks = state.stocks.filter((s) => s.priceUsd !== null);
  const rats: RatView[] = [...res.rats];
  let id = rats.reduce((m, x) => Math.max(m, x.id), 0) + 1;
  const template = res.rats[0];
  while (rats.length < target && template && stocks.length) {
    const s = stocks[Math.floor(r() * stocks.length)]!;
    const cost = 3 + r() * 6;
    const pnl = -0.4 + r() * 1.3; // -40% .. +90%: every tier shows up
    rats.push({
      ...template,
      id,
      name: `Rat #${String(id).padStart(4, '0')}`,
      stock: s.symbol,
      stockMint: s.mint,
      status: s.status === 'paused' ? 'frozen' : 'active',
      tokenAmount: String((cost * (1 + pnl)) / s.priceUsd!),
      costUsd: Math.round(cost * 100) / 100,
      hireTx: null,
    });
    id++;
  }
  return { ...res, rats, total: rats.length };
}

let fakeId = 10_000_000;
let fakeRat = 5_000_000;

export function fakeHire(state: StateResponse, lastEventId: number): HireEvent | null {
  const active = state.stocks.filter((s) => s.status === 'active' && s.priceUsd !== null);
  const s = active[Math.floor(Math.random() * active.length)];
  if (!s) return null;
  fakeId = Math.max(fakeId, lastEventId + 1);
  const ratId = fakeRat++;
  return {
    id: fakeId++,
    type: 'hire',
    at: new Date().toISOString(),
    txSig: null,
    txUrl: null,
    dryRun: true,
    data: { ratId, ratName: `Rat #${ratId}`, wallet: 'StressTestWallet1111111111111111111111111111', stock: s.symbol, salarySol: 0.03, costUsd: 5 },
  };
}
