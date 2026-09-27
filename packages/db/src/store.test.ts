import { FakeClock, type StockConfigEntry } from '@rat/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type DbHandle, openMemoryDatabase } from './connection';
import { Store } from './store';

let handle: DbHandle;
let clock: FakeClock;
let live: Store;
let paper: Store;

const STOCKS: StockConfigEntry[] = [
  { symbol: 'TSLAx', name: 'Tesla', mint: 'XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB', group: 'volatile', enabled: true, approved: true },
  { symbol: 'NVDAx', name: 'NVIDIA', mint: 'Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh', group: 'volatile', enabled: true, approved: false },
];

beforeEach(async () => {
  handle = await openMemoryDatabase();
  clock = new FakeClock('2026-10-01T12:00:00Z');
  live = new Store(handle.db, 'live', clock);
  paper = live.forMode('paper');
});

afterEach(async () => {
  await handle.close();
});

describe('ledger', () => {
  it('is exact to the lamport and separated by bucket and mode', async () => {
    await live.ledger.append({ bucket: 'hire', deltaLamports: 642_000_001n, reason: 'claim_credit' });
    await live.ledger.append({ bucket: 'burn', deltaLamports: 642_000_000n, reason: 'claim_credit' });
    await live.ledger.append({ bucket: 'hire', deltaLamports: -30_000_000n, reason: 'hire_reserve' });
    await live.ledger.append({ bucket: 'hire', deltaLamports: 1_234n, reason: 'hire_settle' });
    await live.ledger.append({ bucket: 'hire', deltaLamports: -5_000n, reason: 'claim_fee' });
    await paper.ledger.append({ bucket: 'hire', deltaLamports: 999_999_999_999n, reason: 'claim_credit' });

    expect(await live.ledger.balance('hire')).toBe(642_000_001n - 30_000_000n + 1_234n - 5_000n);
    expect(await live.ledger.balance('burn')).toBe(642_000_000n);
    expect(await paper.ledger.balance('hire')).toBe(999_999_999_999n);
    expect(await paper.ledger.balance('burn')).toBe(0n);
  });

  it('computes net outflow per bucket in a rolling window', async () => {
    await live.ledger.append({ bucket: 'hire', deltaLamports: 100_000_000_000n, reason: 'claim_credit' });
    await live.ledger.append({ bucket: 'hire', deltaLamports: -30_000_000n, reason: 'hire_reserve' });
    clock.advanceSeconds(3600);
    await live.ledger.append({ bucket: 'hire', deltaLamports: -30_000_000n, reason: 'hire_reserve' });
    await live.ledger.append({ bucket: 'hire', deltaLamports: 30_000_000n, reason: 'hire_release' });
    await live.ledger.append({ bucket: 'hire', deltaLamports: -30_000_000n, reason: 'hire_reserve' });
    await live.ledger.append({ bucket: 'burn', deltaLamports: -2_000_000_000n, reason: 'burn_reserve' });
    const since = new Date(clock.now().getTime() - 3_599_000);
    expect(await live.ledger.netOutflowSince('hire', since)).toBe(30_000_000n);
    expect(await live.ledger.netOutflowSince('burn', since)).toBe(2_000_000_000n);
    expect(await live.ledger.lifetimeNetOutflow()).toBe(2_060_000_000n);
  });
});

describe('keys', () => {
  it('hands out each rat key exactly once, even when taken concurrently', async () => {
    const recs = Array.from({ length: 50 }, (_, i) => ({ pubkey: `k${i}RAT`, secretEnc: `enc${i}`, keyVersion: 1, role: 'rat' as const }));
    expect(await live.keys.insertMany(recs)).toBe(50);
    expect(await live.keys.insertMany(recs.slice(0, 5))).toBe(0);
    const taken = await Promise.all(Array.from({ length: 60 }, () => live.keys.takeAvailableRat()));
    const got = taken.filter(Boolean);
    expect(got.length).toBe(50);
    expect(new Set(got).size).toBe(50);
    expect(await live.keys.countAvailableRats()).toBe(0);
    await live.keys.release(got[0]!);
    expect(await live.keys.countAvailableRats()).toBe(1);
  });

  it('stores creator/fund keys and refuses silent overwrite', async () => {
    await live.keys.setRoleKey({ pubkey: 'creator1', secretEnc: 'e', keyVersion: 1, role: 'creator' });
    await expect(live.keys.setRoleKey({ pubkey: 'creator2', secretEnc: 'e', keyVersion: 1, role: 'creator' })).rejects.toThrow(
      /already stored/,
    );
    await live.keys.setRoleKey({ pubkey: 'creator2', secretEnc: 'e', keyVersion: 1, role: 'creator' }, { replace: true });
    expect((await live.keys.getRole('creator'))?.pubkey).toBe('creator2');
    expect(await live.keys.takeAvailableRat()).toBeNull();
  });
});

describe('rats and stocks', () => {
  it('one rat per wallet, freeze and unfreeze by stock', async () => {
    await live.stocks.syncConfig(STOCKS);
    const r1 = await live.rats.create({ wallet: 'w1RAT', stockMint: STOCKS[0]!.mint, salaryLamports: 30_000_000n, avatarSeed: 'aaaaaaaa' });
    await expect(
      live.rats.create({ wallet: 'w1RAT', stockMint: STOCKS[0]!.mint, salaryLamports: 30_000_000n, avatarSeed: 'aaaaaaaa' }),
    ).rejects.toThrow();
    await live.rats.activate(r1.id, {
      hireSig: 's1',
      solSwappedLamports: 24_500_000n,
      tokenAmountRaw: 1_413_900n,
      tokenDecimals: 8,
      costUsd: 4.54,
      solUsdAtHire: 185.4,
      hiredAt: clock.now(),
    });
    expect(await live.rats.freezeByStock(STOCKS[0]!.mint, 'stock_paused')).toBe(1);
    expect((await live.rats.get(r1.id))?.status).toBe('frozen');
    expect(await live.rats.unfreezeByStock(STOCKS[0]!.mint, 'stock_paused')).toBe(1);
    expect((await live.rats.get(r1.id))?.status).toBe('active');
  });

  it('syncConfig disables stocks removed from the file', async () => {
    await live.stocks.syncConfig(STOCKS);
    await live.stocks.syncConfig([STOCKS[0]!]);
    const list = await live.stocks.list();
    expect(list.find((s) => s.symbol === 'NVDAx')?.enabled).toBe(false);
    expect(await live.stocks.setStatus(STOCKS[0]!.mint, 'paused')).toBe('active');
    expect((await live.stocks.get(STOCKS[0]!.mint))?.status).toBe('paused');
  });

  it('serves a 6,000 rat roster quickly', async () => {
    await live.stocks.syncConfig(STOCKS);
    const now = clock.now();
    const values = Array.from({ length: 6000 }, (_, i) => ({
      mode: 'live',
      wallet: `wallet${i}RAT`,
      stockMint: STOCKS[i % 2]!.mint,
      status: i % 50 === 0 ? 'frozen' : 'active',
      avatarSeed: 'abcdef12',
      salaryLamports: 30_000_000n,
      tokenAmountRaw: 1_000_000n,
      tokenDecimals: 8,
      costUsd: 4.5,
      createdAt: now,
      hiredAt: now,
    }));
    const { rats } = await import('./schema');
    for (let i = 0; i < values.length; i += 1000) await handle.db.insert(rats).values(values.slice(i, i + 1000));
    const t0 = performance.now();
    const roster = await live.rats.roster();
    const ms = performance.now() - t0;
    expect(roster.length).toBe(6000);
    expect(roster[0]?.stock?.symbol).toBeDefined();
    expect(ms).toBeLessThan(1500);
    console.log(`roster of 6000 rats: ${ms.toFixed(0)}ms (PGlite, in-process)`);
    expect((await paper.rats.roster()).length).toBe(0);
  });
});

describe('claims, burns, events', () => {
  it('tracks pending fund transfers from external claims', async () => {
    await live.claims.insert({ source: 'bot', status: 'confirmed', claimableLamports: 100n, claimedLamports: 100n, toFundLamports: 50n, fundShareLamports: 50n, hireShareLamports: 45n, feeLamports: 5n });
    await live.claims.insert({ source: 'external', status: 'confirmed', claimableLamports: 0n, claimedLamports: 40n, toFundLamports: 0n, fundShareLamports: 20n, hireShareLamports: 20n });
    await live.claims.insert({ source: 'bot', status: 'failed', claimableLamports: 999n });
    expect(await live.claims.pendingFundTransfer()).toBe(20n);
    const t = await live.claims.totals();
    expect(t.claimed).toBe(140n);
    expect(t.count).toBe(2);
    expect(await paper.claims.pendingFundTransfer()).toBe(0n);
  });

  it('events are ordered and paged per mode', async () => {
    for (let i = 0; i < 5; i++) await live.events.append({ type: 'hire', data: { i } });
    await paper.events.append({ type: 'claim', data: {} });
    const first = await live.events.after(0, 3);
    expect(first.map((e) => (e.data as { i: number }).i)).toEqual([0, 1, 2]);
    const rest = await live.events.after(first[2]!.id, 10);
    expect(rest.length).toBe(2);
    expect((await live.events.latest(1))[0]?.data).toEqual({ i: 4 });
    expect((await paper.events.latest(10)).length).toBe(1);
  });

  it('burn totals only count confirmed or simulated burns', async () => {
    await live.burns.insert({ status: 'confirmed', reservedLamports: 10n, solSpentLamports: 9n, tokensBurnedRaw: 1000n, coinDecimals: 6 });
    await live.burns.insert({ status: 'released', reservedLamports: 10n });
    const t = await live.burns.totals();
    expect(t.spent).toBe(9n);
    expect(t.burnedRaw).toBe(1000n);
    expect(t.count).toBe(1);
    expect(t.decimals).toBe(6);
  });
});

describe('locks and paper reset', () => {
  it('lease lock: one holder at a time, expired lease can be taken over', async () => {
    const now = clock.now();
    expect(await live.locks.acquire('worker', 'A', now, 60)).toBe(true);
    expect(await live.locks.acquire('worker', 'B', now, 60)).toBe(false);
    expect(await live.locks.acquire('worker', 'A', new Date(now.getTime() + 30_000), 60)).toBe(true);
    expect(await live.locks.acquire('worker', 'B', new Date(now.getTime() + 95_000), 60)).toBe(true);
    await live.locks.release('worker', 'A');
    expect((await live.locks.holder('worker'))?.holder).toBe('B');
  });

  it('resetPaper deletes only paper rows, returns keys, restarts numbering', async () => {
    await live.stocks.syncConfig(STOCKS);
    await live.keys.insertMany([{ pubkey: 'p1RAT', secretEnc: 'e', keyVersion: 1, role: 'rat' }]);
    const key = await paper.keys.takeAvailableRat();
    await paper.rats.create({ wallet: key!, stockMint: STOCKS[0]!.mint, salaryLamports: 1n, avatarSeed: 'aaaaaaaa' });
    await paper.ledger.append({ bucket: 'hire', deltaLamports: 5n, reason: 'claim_credit' });
    await live.ledger.append({ bucket: 'hire', deltaLamports: 7n, reason: 'claim_credit' });
    const r = await paper.resetPaper();
    expect(r).toEqual({ rats: 1, keysReleased: 1 });
    expect(await paper.ledger.balance('hire')).toBe(0n);
    expect(await live.ledger.balance('hire')).toBe(7n);
    expect(await live.keys.countAvailableRats()).toBe(1);
    const again = await live.rats.create({ wallet: 'x1RAT', stockMint: STOCKS[0]!.mint, salaryLamports: 1n, avatarSeed: 'aaaaaaaa' });
    expect(again.id).toBe(1);
  });
});
